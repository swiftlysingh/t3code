import {
  type SimulatorAcquireInput,
  type SimulatorAcquireResult,
  type SimulatorCapabilities,
  SimulatorDeviceNotFoundError,
  type SimulatorError,
  type SimulatorEvent,
  type SimulatorInputEvent,
  SimulatorInputEvent as SimulatorInputEventSchema,
  SimulatorLeaseGenerationMismatchError,
  SimulatorLeaseId,
  SimulatorLeaseNotFoundError,
  type SimulatorListInput,
  type SimulatorListResult,
  type SimulatorReleaseInput,
  type SimulatorReleaseResult,
  SimulatorRuntimeUnavailableError,
  type SimulatorSendInput,
  type SimulatorSendInputResult,
  type SimulatorSession,
  type SimulatorStatusInput,
  type SimulatorStatusResult,
  SimulatorThreadLeaseConflictError,
  SimulatorUnsupportedPlatformError,
  type SimulatorUdid,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DeviceInventory from "./DeviceInventory.ts";
import * as HostLock from "./HostLock.ts";
import {
  ServeSimSupervisor,
  type ServeSimInput,
  type ServeSimSession,
} from "./ServeSimSupervisor.ts";
import {
  issueSimulatorStreamUrl,
  matchesSimulatorStreamBinding,
  type SimulatorStreamClaims,
} from "./StreamAccess.ts";

const DEFAULT_MAX_ACTIVE = 1;
const HOST_CAPACITY_LOCK_UDID = "t3-host-capacity-slot-1" as SimulatorUdid;

/**
 * This error never crosses the RPC/MCP boundary. It keeps process, lock, and
 * promise failures out of Effect's `unknown` channel until we can turn them
 * into the stable failed-session shape in the public contract.
 */
class SimulatorStartupFailure extends Schema.TaggedErrorClass<SimulatorStartupFailure>()(
  "SimulatorStartupFailure",
  {
    code: Schema.Literals(["simulator-locked", "startup-failed"]),
    cause: TrimmedNonEmptyString,
  },
) {}

const isHostLockContended = Schema.is(HostLock.SimulatorHostLockContendedError);
const isInvalidInventoryUdid = Schema.is(DeviceInventory.SimulatorInventoryInvalidUdidError);
const isSimulatorInputEvent = Schema.is(SimulatorInputEventSchema);
const isSimulatorStartupFailure = Schema.is(SimulatorStartupFailure);

export interface SimulatorManagerOptions {
  /**
   * Test seam for host-wide locking. Production uses the conservative lock
   * implementation in HostLock, shared by all local T3 environments.
   */
  readonly hostLock?: HostLock.SimulatorHostLock;
  /** Test seam. Production creates one supervised serve-sim child per lease. */
  readonly serveSim?: ServeSimSupervisor;
}

export interface SimulatorResolvedStream {
  readonly url: string;
  readonly contentType: "multipart/x-mixed-replace; boundary=frame";
}

export class SimulatorManager extends Context.Service<
  SimulatorManager,
  {
    readonly capabilities: Effect.Effect<SimulatorCapabilities>;
    readonly list: (input: SimulatorListInput) => Effect.Effect<SimulatorListResult>;
    readonly acquire: (
      input: SimulatorAcquireInput,
    ) => Effect.Effect<SimulatorAcquireResult, SimulatorError>;
    readonly status: (
      input: SimulatorStatusInput,
    ) => Effect.Effect<SimulatorStatusResult, SimulatorError>;
    readonly release: (
      input: SimulatorReleaseInput,
    ) => Effect.Effect<SimulatorReleaseResult, SimulatorError>;
    readonly releaseThread: (
      threadId: SimulatorSession["threadId"],
    ) => Effect.Effect<void, SimulatorError>;
    readonly sendInput: (
      input: SimulatorSendInput,
    ) => Effect.Effect<SimulatorSendInputResult, SimulatorError>;
    readonly resolveStream: (
      claims: SimulatorStreamClaims,
    ) => Effect.Effect<SimulatorResolvedStream | null>;
    readonly events: Stream.Stream<SimulatorEvent>;
    readonly subscribeEvents: Effect.Effect<
      PubSub.Subscription<SimulatorEvent>,
      never,
      Scope.Scope
    >;
  }
>()("t3/simulator/Manager/SimulatorManager") {}

interface ManagerState {
  readonly sessions: ReadonlyMap<string, SimulatorSession>;
  readonly queue: ReadonlyArray<string>;
  readonly sequence: number;
}

interface RuntimeHandle {
  /**
   * A sidecar session exists only after `ServeSimSupervisor.start` resolves.
   * Holding the supervisor independently lets release cancel an in-flight
   * start before it has returned a session handle.
   */
  readonly udid: SimulatorUdid;
  readonly supervisor: ServeSimSupervisor | null;
  readonly session: ServeSimSession | null;
  /** A successful cleanup step is recorded so retries never release a lock twice. */
  readonly sidecarClosed: boolean;
  readonly capacityLock: HostLock.SimulatorHostLockLease | null;
  readonly deviceLock: HostLock.SimulatorHostLockLease | null;
}

interface ActivationHandle {
  readonly session: SimulatorSession;
  readonly abortController: AbortController;
  fiber: Fiber.Fiber<void, never> | null;
  cancelRequested: boolean;
}

type EventDraft =
  | { readonly type: "session"; readonly session: SimulatorSession }
  | {
      readonly type: "released";
      readonly threadId: SimulatorSession["threadId"];
      readonly leaseId: SimulatorLeaseId;
      readonly generation: number;
    };

type AcquireMutation =
  | { readonly kind: "result"; readonly session: SimulatorSession }
  | { readonly kind: "conflict"; readonly error: SimulatorThreadLeaseConflictError };

type ReleaseMutation =
  | { readonly kind: "released"; readonly session: SimulatorSession }
  | { readonly kind: "not-found"; readonly error: SimulatorLeaseNotFoundError }
  | { readonly kind: "generation"; readonly error: SimulatorLeaseGenerationMismatchError };

interface CommitUpdate<A> {
  readonly result: A;
  readonly state: ManagerState;
  readonly drafts: ReadonlyArray<EventDraft>;
}

const initialState: ManagerState = { sessions: new Map(), queue: [], sequence: 0 };
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const hostOs = (platform: NodeJS.Platform): SimulatorCapabilities["host"]["os"] => {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
};

const hostArch = (architecture: NodeJS.Architecture): SimulatorCapabilities["host"]["arch"] => {
  switch (architecture) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
};

const errorText = (cause: unknown): string => {
  const value =
    cause instanceof Error && cause.message.trim().length > 0
      ? cause.message.trim()
      : typeof cause === "string" && cause.trim().length > 0
        ? cause.trim()
        : "Unexpected simulator runtime failure.";
  return value.slice(0, 2_000);
};

const makeLeaseId = (): SimulatorLeaseId =>
  SimulatorLeaseId.make(`sim-lease-${NodeCrypto.randomUUID()}`);

const findThreadSession = (state: ManagerState, threadId: string): SimulatorSession | undefined =>
  Array.from(state.sessions.values()).find((session) => session.threadId === threadId);

const isActive = (session: SimulatorSession): boolean =>
  session.state === "starting" || session.state === "ready";

const activeSessionCount = (state: ManagerState): number =>
  Array.from(state.sessions.values()).filter(isActive).length;

const withoutEphemeralFields = (session: SimulatorSession): SimulatorSession => {
  const { queuePosition: _queuePosition, media: _media, failure: _failure, ...rest } = session;
  return rest;
};

const updateQueuePositions = (
  sessions: Map<string, SimulatorSession>,
  queue: ReadonlyArray<string>,
  updatedAt: string,
): void => {
  queue.forEach((leaseId, index) => {
    const session = sessions.get(leaseId);
    if (!session || session.state !== "queued") return;
    sessions.set(leaseId, { ...session, queuePosition: index + 1, updatedAt });
  });
};

const drainQueue = (
  state: ManagerState,
  maxActive: number,
  updatedAt: string,
): {
  readonly sessions: Map<string, SimulatorSession>;
  readonly queue: Array<string>;
  readonly activated: Array<SimulatorSession>;
} => {
  const sessions = new Map(state.sessions);
  const queue: Array<string> = [];
  const activated: Array<SimulatorSession> = [];
  let activeCount = activeSessionCount(state);

  for (const leaseId of state.queue) {
    const session = sessions.get(leaseId);
    if (!session || session.state !== "queued") continue;
    const udidBusy = Array.from(sessions.values()).some(
      (candidate) =>
        candidate.leaseId !== leaseId && isActive(candidate) && candidate.udid === session.udid,
    );
    if (activeCount >= maxActive || udidBusy) {
      queue.push(leaseId);
      continue;
    }
    const starting: SimulatorSession = {
      ...withoutEphemeralFields(session),
      state: "starting",
      generation: session.generation + 1,
      updatedAt,
    };
    sessions.set(leaseId, starting);
    activated.push(starting);
    activeCount += 1;
  }

  updateQueuePositions(sessions, queue, updatedAt);
  return { sessions, queue, activated };
};

const toServeSimInput = (event: SimulatorInputEvent): ServeSimInput => {
  switch (event.type) {
    case "touch":
      return { type: "touch", phase: event.phase, x: event.x, y: event.y };
    case "home":
      return { type: "home" };
    case "keyboard":
      return { type: "keyboard", phase: event.phase, usage: event.usage };
    case "orientation":
      return { type: "orientation", orientation: event.orientation };
    case "scroll":
      return { type: "scroll", dx: event.dx, dy: event.dy, x: event.x, y: event.y };
  }
};

export const make = Effect.fn("SimulatorManager.make")(function* (
  options: SimulatorManagerOptions = {},
) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const inventory = yield* DeviceInventory.SimulatorInventory;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const host = { os: hostOs(platform), arch: hostArch(architecture) };
  const platformSupported = platform === "darwin" && architecture === "arm64";
  // The fixed host-capacity lock below intentionally implements one local
  // execution slot. A larger value would lie to callers until there are
  // matching independently-owned cross-process slots.
  const maxActive = DEFAULT_MAX_ACTIVE;
  const hostLock = options.hostLock ?? HostLock.make();
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  const eventsPubSub = yield* PubSub.unbounded<SimulatorEvent>();
  const mutationLock = yield* Semaphore.make(1);
  const cleanupLock = yield* Semaphore.make(1);
  const releaseLock = yield* Semaphore.make(1);
  const runtimes = new Map<string, RuntimeHandle>();
  // A marker is installed before forkDetach so release cannot race with an
  // unregistered startup fiber. A released starting lease drains only after
  // the activation has closed every lock and sidecar it acquired.
  const activations = new Map<string, ActivationHandle>();
  let disposed = false;

  const events = Stream.fromPubSub(eventsPubSub);

  const capabilitySnapshot = (
    executionReady: boolean,
    deviceEnumeration = executionReady,
  ): SimulatorCapabilities => ({
    host,
    platformSupported,
    executionReady,
    deviceEnumeration,
    liveStreaming: executionReady,
    humanInput: executionReady,
    agentAutomation: executionReady,
    maxActive,
    reason: platformSupported
      ? executionReady
        ? null
        : "dependency-unavailable"
      : "unsupported-platform",
  });

  const capabilities: SimulatorManager["Service"]["capabilities"] = platformSupported
    ? inventory.list.pipe(
        Effect.map((snapshot) =>
          capabilitySnapshot(snapshot.supported && snapshot.devices.length > 0, snapshot.supported),
        ),
        Effect.orElseSucceed(() => capabilitySnapshot(false)),
      )
    : Effect.succeed(capabilitySnapshot(false));

  const ensureSupported = (): Effect.Effect<void, SimulatorUnsupportedPlatformError> =>
    platformSupported ? Effect.void : Effect.fail(new SimulatorUnsupportedPlatformError({ host }));

  const applyEventDrafts = (
    state: ManagerState,
    drafts: ReadonlyArray<EventDraft>,
    createdAt: string,
  ): { readonly state: ManagerState; readonly events: ReadonlyArray<SimulatorEvent> } => {
    if (drafts.length === 0) return { state, events: [] };
    let sequence = state.sequence;
    const emitted: SimulatorEvent[] = drafts.map((draft) => {
      sequence += 1;
      if (draft.type === "session") {
        return {
          type: "session",
          session: draft.session,
          sequence,
          createdAt,
          environmentId,
        };
      }
      return {
        type: "released",
        threadId: draft.threadId,
        leaseId: draft.leaseId,
        generation: draft.generation,
        sequence,
        createdAt,
        environmentId,
      };
    });
    return { state: { ...state, sequence }, events: emitted };
  };

  /**
   * Commit state before publishing. In particular, a status request kicked
   * off by a session event must never observe the previous session state.
   * The semaphore also preserves the state-transition order for observers
   * when concurrent activation fibers finish at the same time.
   */
  const commit = <A>(
    createdAt: string,
    update: (state: ManagerState) => CommitUpdate<A>,
  ): Effect.Effect<A> =>
    mutationLock.withPermit(
      SynchronizedRef.modify(stateRef, (state) => {
        const next = update(state);
        const sequenced = applyEventDrafts(next.state, next.drafts, createdAt);
        return [{ result: next.result, events: sequenced.events }, sequenced.state] as const;
      }).pipe(
        Effect.flatMap(({ result, events: eventsToPublish }) =>
          Effect.forEach(eventsToPublish, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }).pipe(Effect.as(result)),
        ),
      ),
    );

  const cleanupFailure = (
    leaseId: SimulatorLeaseId,
    operation: "sidecar-close" | "device-lock-release" | "capacity-lock-release",
    cause: unknown,
  ): SimulatorRuntimeUnavailableError =>
    new SimulatorRuntimeUnavailableError({ leaseId, operation, cause: errorText(cause) });

  /**
   * Cleanup is intentionally retryable and fail-closed. A RuntimeHandle stays
   * present until its sidecar and both exact locks are confirmed gone. Each
   * successful step is durably recorded in-memory so a retry cannot attempt a
   * second release of a lock that has already been deleted by HostLock.
   */
  const cleanupRuntime = (
    leaseId: SimulatorLeaseId,
  ): Effect.Effect<void, SimulatorRuntimeUnavailableError> =>
    cleanupLock.withPermit(
      Effect.gen(function* () {
        let runtime = runtimes.get(leaseId);
        if (!runtime) return;

        if (!runtime.sidecarClosed) {
          const sidecar = runtime.session;
          const supervisor = runtime.supervisor;
          const udid = runtime.udid;
          if (sidecar !== null) {
            yield* Effect.tryPromise({
              try: () => sidecar.close(),
              catch: (cause): SimulatorRuntimeUnavailableError =>
                cleanupFailure(leaseId, "sidecar-close", cause),
            });
          } else if (supervisor !== null) {
            yield* Effect.tryPromise({
              try: () => supervisor.stop(udid),
              catch: (cause): SimulatorRuntimeUnavailableError =>
                cleanupFailure(leaseId, "sidecar-close", cause),
            });
          }
          runtime = { ...runtime, sidecarClosed: true };
          runtimes.set(leaseId, runtime);
        }

        if (runtime.deviceLock !== null) {
          const deviceLock = runtime.deviceLock;
          yield* hostLock
            .release(deviceLock)
            .pipe(
              Effect.mapError((cause) => cleanupFailure(leaseId, "device-lock-release", cause)),
            );
          runtime = { ...runtime, deviceLock: null };
          runtimes.set(leaseId, runtime);
        }

        if (runtime.capacityLock !== null) {
          const capacityLock = runtime.capacityLock;
          yield* hostLock
            .release(capacityLock)
            .pipe(
              Effect.mapError((cause) => cleanupFailure(leaseId, "capacity-lock-release", cause)),
            );
          runtime = { ...runtime, capacityLock: null };
          runtimes.set(leaseId, runtime);
        }

        runtimes.delete(leaseId);
      }),
    );

  const materializeSession = (
    session: SimulatorSession,
  ): Effect.Effect<SimulatorSession, SimulatorError> => {
    if (session.state !== "ready") return Effect.succeed(session);
    const runtime = runtimes.get(session.leaseId);
    const serveSession = runtime?.session;
    if (!serveSession || serveSession.udid !== session.udid) return Effect.succeed(session);
    return issueSimulatorStreamUrl({
      environmentId,
      threadId: session.threadId,
      leaseId: session.leaseId,
      udid: session.udid,
      generation: session.generation,
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.map((issued) => {
        const config = serveSession.config;
        const width =
          typeof config.width === "number" && Number.isFinite(config.width) && config.width >= 0
            ? Math.floor(config.width)
            : 0;
        const height =
          typeof config.height === "number" && Number.isFinite(config.height) && config.height >= 0
            ? Math.floor(config.height)
            : 0;
        const orientation =
          config.orientation === "portrait_upside_down" ||
          config.orientation === "landscape_left" ||
          config.orientation === "landscape_right"
            ? config.orientation
            : "portrait";
        return {
          ...session,
          media: {
            streamUrl: issued.relativeUrl,
            width,
            height,
            orientation,
            expiresAt: issued.expiresAt,
          },
        } satisfies SimulatorSession;
      }),
      Effect.mapError(
        (cause) =>
          new SimulatorRuntimeUnavailableError({
            leaseId: session.leaseId,
            operation: "stream-token",
            cause: errorText(cause),
          }),
      ),
    );
  };

  const transitionReady = (leaseId: SimulatorLeaseId, generation: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      return yield* commit(updatedAt, (state) => {
        const current = state.sessions.get(leaseId);
        if (!current || current.generation !== generation || current.state !== "starting") {
          return { result: false, state, drafts: [] };
        }
        const ready: SimulatorSession = {
          ...withoutEphemeralFields(current),
          state: "ready",
          updatedAt,
        };
        const sessions = new Map(state.sessions);
        sessions.set(leaseId, ready);
        return {
          result: true,
          state: { ...state, sessions },
          drafts: [{ type: "session", session: ready }],
        };
      });
    });

  const markFailed = (
    leaseId: SimulatorLeaseId,
    generation: number,
    failure: SimulatorSession["failure"],
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      return yield* commit(updatedAt, (state) => {
        const current = state.sessions.get(leaseId);
        if (
          !current ||
          current.generation !== generation ||
          (current.state !== "starting" && current.state !== "ready")
        ) {
          return { result: false, state, drafts: [] };
        }
        const failed: SimulatorSession = {
          ...withoutEphemeralFields(current),
          state: "failed",
          failure,
          updatedAt,
        };
        const sessions = new Map(state.sessions);
        sessions.set(leaseId, failed);
        return {
          result: true,
          state: { ...state, sessions },
          drafts: [{ type: "session", session: failed }],
        };
      });
    });

  let launchActivation: (session: SimulatorSession) => Effect.Effect<void> = () => Effect.void;

  const drainAndActivate = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      // A retained handle means an external sidecar or exact host lock still
      // needs cleanup. Do not turn a failed cleanup into a competing queued
      // launch; the caller can retry the original release safely.
      if (disposed || runtimes.size > 0) return Effect.void;
      return Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const activated = yield* commit(updatedAt, (state) => {
          const drained = drainQueue(state, maxActive, updatedAt);
          if (drained.activated.length === 0) {
            return { result: [] as Array<SimulatorSession>, state, drafts: [] };
          }
          const drafts: EventDraft[] = drained.activated.map((session) => ({
            type: "session",
            session,
          }));
          return {
            result: drained.activated,
            state: { ...state, sessions: drained.sessions, queue: drained.queue },
            drafts,
          };
        });
        yield* Effect.forEach(activated, launchActivation, { discard: true });
      });
    });

  const onUnexpectedExit = (session: SimulatorSession, stderrTail: string): void => {
    runFork(
      markFailed(session.leaseId, session.generation, {
        code: "serve-sim-exited",
        message: stderrTail.trim() || "serve-sim exited unexpectedly.",
        retryable: true,
      }).pipe(
        Effect.andThen(cleanupRuntime(session.leaseId)),
        Effect.andThen(drainAndActivate()),
        Effect.catchCause(() => Effect.void),
      ),
    );
  };

  const activate = (activation: ActivationHandle): Effect.Effect<void> => {
    const session = activation.session;

    const mapLockError = (cause: HostLock.SimulatorHostLockError): SimulatorStartupFailure =>
      new SimulatorStartupFailure({
        code: isHostLockContended(cause) ? "simulator-locked" : "startup-failed",
        cause: errorText(cause),
      });

    const wasCancelled = (): boolean => activation.cancelRequested || disposed;

    const start = Effect.gen(function* () {
      if (wasCancelled()) return;

      const supervisor =
        options.serveSim ??
        new ServeSimSupervisor({
          onUnexpectedExit: (event) => onUnexpectedExit(session, event.stderrTail),
        });
      const initialRuntime = runtimes.get(session.leaseId);
      if (!initialRuntime) return;
      runtimes.set(session.leaseId, { ...initialRuntime, supervisor });
      if (wasCancelled()) return;

      const capacityLock = yield* hostLock
        .acquire({
          udid: HOST_CAPACITY_LOCK_UDID,
          environmentId,
          threadId: session.threadId,
          leaseId: session.leaseId,
          generation: session.generation,
        })
        .pipe(Effect.mapError(mapLockError));
      const afterCapacity = runtimes.get(session.leaseId);
      if (!afterCapacity) return;
      runtimes.set(session.leaseId, { ...afterCapacity, capacityLock });
      if (wasCancelled()) return;

      const deviceLock = yield* hostLock
        .acquire({
          udid: session.udid,
          environmentId,
          threadId: session.threadId,
          leaseId: session.leaseId,
          generation: session.generation,
        })
        .pipe(Effect.mapError(mapLockError));
      const afterDevice = runtimes.get(session.leaseId);
      if (!afterDevice) return;
      runtimes.set(session.leaseId, { ...afterDevice, deviceLock });
      if (wasCancelled()) return;

      const serveSession = yield* Effect.tryPromise({
        try: () => supervisor.start(session.udid, { signal: activation.abortController.signal }),
        catch: (cause): SimulatorStartupFailure =>
          new SimulatorStartupFailure({ code: "startup-failed", cause: errorText(cause) }),
      });
      const afterStart = runtimes.get(session.leaseId);
      if (!afterStart) {
        yield* Effect.tryPromise({
          try: () => serveSession.close(),
          catch: (cause): SimulatorStartupFailure =>
            new SimulatorStartupFailure({ code: "startup-failed", cause: errorText(cause) }),
        });
        return;
      }
      // Install the sidecar before committing ready, so a concurrent input
      // request cannot ever observe a ready session without it.
      runtimes.set(session.leaseId, { ...afterStart, session: serveSession });
      if (wasCancelled()) return;

      const current = yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state) => state.sessions.get(session.leaseId)),
      );
      if (!current || current.generation !== session.generation || current.state !== "starting") {
        return;
      }

      const committed = yield* transitionReady(session.leaseId, session.generation);
      if (!committed) yield* cleanupRuntime(session.leaseId);
    });

    return start.pipe(
      Effect.catch((failure) => {
        if (wasCancelled()) return Effect.void;
        const startupFailure = isSimulatorStartupFailure(failure)
          ? failure
          : new SimulatorStartupFailure({ code: "startup-failed", cause: errorText(failure) });
        // A failed activation must not discard a partial handle. If cleanup
        // itself fails, release keeps the lease and retries those exact steps.
        return cleanupRuntime(session.leaseId).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(
            markFailed(session.leaseId, session.generation, {
              code: startupFailure.code,
              message: startupFailure.cause,
              retryable: true,
            }),
          ),
          Effect.asVoid,
        );
      }),
      Effect.ensuring(
        Effect.sync(() => activations.delete(session.leaseId)).pipe(
          Effect.andThen(Effect.suspend(() => (wasCancelled() ? Effect.void : drainAndActivate()))),
        ),
      ),
    );
  };

  launchActivation = (session) =>
    Effect.gen(function* () {
      if (disposed) return;
      const current = yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state) => state.sessions.get(session.leaseId)),
      );
      // The session event is published before this detached worker is forked.
      // A caller may release immediately from that event; never resurrect a
      // lease that was removed in that small handoff window.
      if (!current || current.generation !== session.generation || current.state !== "starting") {
        return;
      }
      const activation: ActivationHandle = {
        session,
        abortController: new AbortController(),
        fiber: null,
        cancelRequested: false,
      };
      runtimes.set(session.leaseId, {
        udid: session.udid,
        supervisor: null,
        session: null,
        sidecarClosed: false,
        capacityLock: null,
        deviceLock: null,
      });
      activations.set(session.leaseId, activation);
      const fiber = yield* activate(activation).pipe(Effect.forkDetach);
      activation.fiber = fiber;
    });

  const list: SimulatorManager["Service"]["list"] = Effect.fn("SimulatorManager.list")(
    function* (_input) {
      const [snapshot, state] = yield* Effect.all([
        inventory.list.pipe(Effect.orElseSucceed(() => null)),
        SynchronizedRef.get(stateRef),
      ]);
      const deviceEnumeration = platformSupported && snapshot?.supported === true;
      return {
        capabilities: capabilitySnapshot(
          snapshot !== null && snapshot.supported && snapshot.devices.length > 0,
          deviceEnumeration,
        ),
        devices: snapshot?.devices ?? [],
        sessions: Array.from(state.sessions.values()),
      } satisfies SimulatorListResult;
    },
  );

  const acquire: SimulatorManager["Service"]["acquire"] = Effect.fn("SimulatorManager.acquire")(
    function* (input) {
      yield* ensureSupported();
      const lookup = yield* inventory.find(input.udid).pipe(
        Effect.mapError((cause): SimulatorError => {
          if (isInvalidInventoryUdid(cause)) {
            return new SimulatorDeviceNotFoundError({ udid: input.udid });
          }
          return new SimulatorRuntimeUnavailableError({
            operation: "device-enumeration",
            cause: errorText(cause),
          });
        }),
      );
      if (!lookup.supported) {
        return yield* new SimulatorRuntimeUnavailableError({
          operation: "device-enumeration",
          cause: "CoreSimulator discovery is unavailable on this host.",
        });
      }
      if (!lookup.device) {
        return yield* new SimulatorDeviceNotFoundError({ udid: input.udid });
      }

      const createdAt = yield* nowIso;
      const mutation = yield* commit(createdAt, (state) => {
        const existing = findThreadSession(state, input.threadId);
        if (existing) {
          if (existing.udid === input.udid) {
            return {
              result: { kind: "result", session: existing } as AcquireMutation,
              state,
              drafts: [],
            };
          }
          return {
            result: {
              kind: "conflict",
              error: new SimulatorThreadLeaseConflictError({
                threadId: input.threadId,
                requestedUdid: input.udid,
                existingUdid: existing.udid,
              }),
            } as AcquireMutation,
            state,
            drafts: [],
          };
        }

        const leaseId = makeLeaseId();
        const shouldQueue =
          activeSessionCount(state) >= maxActive ||
          Array.from(state.sessions.values()).some(
            (candidate) => isActive(candidate) && candidate.udid === input.udid,
          );
        const session: SimulatorSession = {
          leaseId,
          threadId: input.threadId,
          udid: input.udid,
          generation: 1,
          state: shouldQueue ? "queued" : "starting",
          ...(shouldQueue ? { queuePosition: state.queue.length + 1 } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const sessions = new Map(state.sessions);
        sessions.set(leaseId, session);
        const queue = shouldQueue ? [...state.queue, leaseId] : state.queue;
        return {
          result: { kind: "result", session } as AcquireMutation,
          state: { ...state, sessions, queue },
          drafts: [{ type: "session", session }],
        };
      });

      if (mutation.kind === "conflict") return yield* mutation.error;
      if (mutation.session.state === "starting") yield* launchActivation(mutation.session);
      return { session: mutation.session } satisfies SimulatorAcquireResult;
    },
  );

  const status: SimulatorManager["Service"]["status"] = Effect.fn("SimulatorManager.status")(
    function* (input) {
      const state = yield* SynchronizedRef.get(stateRef);
      const session = findThreadSession(state, input.threadId);
      if (input.leaseId !== undefined && session?.leaseId !== input.leaseId) {
        return yield* new SimulatorLeaseNotFoundError({
          threadId: input.threadId,
          leaseId: input.leaseId,
        });
      }
      return {
        capabilities: yield* capabilities,
        threadId: input.threadId,
        session: session ? yield* materializeSession(session) : null,
      } satisfies SimulatorStatusResult;
    },
  );

  /**
   * `ServeSimSupervisor.start` owns a native child before it resolves a
   * session. Cancellation therefore goes through its exact-UDID `stop`, then
   * waits for the activation fiber to finish recording its acquired locks.
   */
  const requestActivationCancellation = (
    leaseId: SimulatorLeaseId,
  ): Effect.Effect<void, SimulatorRuntimeUnavailableError> =>
    Effect.gen(function* () {
      const activation = activations.get(leaseId);
      if (!activation) return;
      activation.cancelRequested = true;
      activation.abortController.abort();

      const supervisor = runtimes.get(leaseId)?.supervisor;
      if (supervisor !== null && supervisor !== undefined) {
        yield* Effect.tryPromise({
          try: () => supervisor.stop(activation.session.udid),
          catch: (cause): SimulatorRuntimeUnavailableError =>
            cleanupFailure(leaseId, "sidecar-close", cause),
        });
      }
    });

  const cancelAndAwaitActivation = (
    leaseId: SimulatorLeaseId,
  ): Effect.Effect<void, SimulatorRuntimeUnavailableError> =>
    Effect.gen(function* () {
      const activation = activations.get(leaseId);
      if (!activation) return;
      yield* requestActivationCancellation(leaseId);
      if (activation.fiber !== null) yield* Fiber.await(activation.fiber);
    });

  const release: SimulatorManager["Service"]["release"] = Effect.fn("SimulatorManager.release")(
    function* (input) {
      return yield* releaseLock.withPermit(
        Effect.gen(function* () {
          // Keep the lease visible until every external resource has been
          // closed. A failed cleanup is therefore retryable with the same
          // lease/generation rather than reporting a release that did not
          // actually free the exact UDID.
          const current = yield* SynchronizedRef.get(stateRef).pipe(
            Effect.map((state) => state.sessions.get(input.leaseId)),
          );
          if (!current || current.threadId !== input.threadId) {
            return yield* new SimulatorLeaseNotFoundError({
              threadId: input.threadId,
              leaseId: input.leaseId,
            });
          }
          if (current.generation !== input.generation) {
            return yield* new SimulatorLeaseGenerationMismatchError({
              leaseId: input.leaseId,
              expectedGeneration: current.generation,
              receivedGeneration: input.generation,
            });
          }

          yield* cancelAndAwaitActivation(current.leaseId);
          yield* cleanupRuntime(current.leaseId);

          const releasedAt = yield* nowIso;
          const mutation = yield* commit(releasedAt, (state) => {
            const session = state.sessions.get(input.leaseId);
            if (!session || session.threadId !== input.threadId) {
              return {
                result: {
                  kind: "not-found",
                  error: new SimulatorLeaseNotFoundError({
                    threadId: input.threadId,
                    leaseId: input.leaseId,
                  }),
                } as ReleaseMutation,
                state,
                drafts: [],
              };
            }
            if (session.generation !== input.generation) {
              return {
                result: {
                  kind: "generation",
                  error: new SimulatorLeaseGenerationMismatchError({
                    leaseId: input.leaseId,
                    expectedGeneration: session.generation,
                    receivedGeneration: input.generation,
                  }),
                } as ReleaseMutation,
                state,
                drafts: [],
              };
            }

            const sessions = new Map(state.sessions);
            sessions.delete(input.leaseId);
            const queue = state.queue.filter((leaseId) => leaseId !== input.leaseId);
            updateQueuePositions(sessions, queue, releasedAt);
            return {
              result: { kind: "released", session } as ReleaseMutation,
              state: { ...state, sessions, queue },
              drafts: [
                {
                  type: "released",
                  threadId: session.threadId,
                  leaseId: input.leaseId,
                  generation: input.generation,
                },
              ],
            };
          });

          if (mutation.kind === "not-found" || mutation.kind === "generation") {
            return yield* mutation.error;
          }
          yield* drainAndActivate();
          return {
            released: true,
            leaseId: mutation.session.leaseId,
            generation: mutation.session.generation,
          } satisfies SimulatorReleaseResult;
        }),
      );
    },
  );

  const releaseThread: SimulatorManager["Service"]["releaseThread"] = Effect.fn(
    "SimulatorManager.releaseThread",
  )(function* (threadId) {
    const state = yield* SynchronizedRef.get(stateRef);
    const session = findThreadSession(state, threadId);
    if (!session) return;
    yield* release({
      threadId,
      leaseId: session.leaseId,
      generation: session.generation,
    });
  });

  const sendInput: SimulatorManager["Service"]["sendInput"] = Effect.fn(
    "SimulatorManager.sendInput",
  )(function* (input) {
    if (!isSimulatorInputEvent(input.event)) {
      return yield* new SimulatorRuntimeUnavailableError({
        leaseId: input.leaseId,
        operation: "input",
        cause: "Input payload did not match the supported simulator input schema.",
      });
    }
    const state = yield* SynchronizedRef.get(stateRef);
    const session = state.sessions.get(input.leaseId);
    if (!session || session.threadId !== input.threadId) {
      return yield* new SimulatorLeaseNotFoundError({
        threadId: input.threadId,
        leaseId: input.leaseId,
      });
    }
    if (session.generation !== input.generation) {
      return yield* new SimulatorLeaseGenerationMismatchError({
        leaseId: input.leaseId,
        expectedGeneration: session.generation,
        receivedGeneration: input.generation,
      });
    }
    const runtime = runtimes.get(input.leaseId);
    const serveSession = runtime?.session;
    if (session.state !== "ready" || !serveSession) {
      return yield* new SimulatorRuntimeUnavailableError({
        leaseId: input.leaseId,
        operation: "input",
        cause: `Session is ${session.state}.`,
      });
    }
    yield* Effect.tryPromise({
      try: () => serveSession.sendInput(toServeSimInput(input.event)),
      catch: (cause): SimulatorRuntimeUnavailableError =>
        new SimulatorRuntimeUnavailableError({
          leaseId: input.leaseId,
          operation: "input",
          cause: errorText(cause),
        }),
    });
    return { accepted: true } satisfies SimulatorSendInputResult;
  });

  const resolveStream: SimulatorManager["Service"]["resolveStream"] = (claims) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map((state) => {
        const session = state.sessions.get(claims.leaseId);
        const runtime = runtimes.get(claims.leaseId);
        if (
          !session ||
          !runtime?.session ||
          session.state !== "ready" ||
          !matchesSimulatorStreamBinding(claims, {
            environmentId,
            threadId: session.threadId,
            leaseId: session.leaseId,
            udid: session.udid,
            generation: session.generation,
          })
        ) {
          return null;
        }
        return {
          url: runtime.session.urls.streamMjpeg,
          contentType: "multipart/x-mixed-replace; boundary=frame",
        } satisfies SimulatorResolvedStream;
      }),
    );

  // Layer disposal is a hard lifecycle boundary. A native child can exist
  // while `start` is still blocked, so ask its exact supervisor to stop and
  // wait for that activation to record every acquired lock before cleanup.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposed = true;
      const active = Array.from(activations.values());
      yield* Effect.forEach(
        active,
        (activation) =>
          requestActivationCancellation(activation.session.leaseId).pipe(Effect.ignore),
        { discard: true },
      );
      yield* Effect.forEach(
        active,
        (activation) =>
          activation.fiber === null
            ? Effect.void
            : Fiber.await(activation.fiber).pipe(Effect.asVoid),
        { discard: true },
      );
      const leaseIds = Array.from(runtimes.keys()).map((leaseId) => SimulatorLeaseId.make(leaseId));
      yield* Effect.forEach(leaseIds, (leaseId) => cleanupRuntime(leaseId).pipe(Effect.ignore), {
        discard: true,
      });
    }),
  );

  return SimulatorManager.of({
    capabilities,
    list,
    acquire,
    status,
    release,
    releaseThread,
    sendInput,
    resolveStream,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
});

export const layer = Layer.effect(SimulatorManager, make());

export const layerWithOptions = (options: SimulatorManagerOptions) =>
  Layer.effect(SimulatorManager, make(options));
