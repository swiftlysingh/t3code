import { it } from "@effect/vitest";
import {
  EnvironmentId,
  SimulatorDeviceNotFoundError,
  SimulatorLeaseGenerationMismatchError,
  SimulatorLeaseId,
  SimulatorLeaseNotFoundError,
  SimulatorRuntimeUnavailableError,
  SimulatorUdid,
  SimulatorUnsupportedPlatformError,
  ThreadId,
  type SimulatorDevice,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DeviceInventory from "./DeviceInventory.ts";
import * as HostLock from "./HostLock.ts";
import * as SimulatorManager from "./Manager.ts";
import {
  ServeSimSupervisor,
  type ServeSimInput,
  type ServeSimStartOptions,
  type ServeSimSession,
} from "./ServeSimSupervisor.ts";

const environmentId = EnvironmentId.make("simulator-manager-test-environment");
const foreignThreadId = ThreadId.make("simulator-manager-foreign-thread");
const foreignLeaseId = SimulatorLeaseId.make("simulator-manager-foreign-lease");
const capacityLockUdid = SimulatorUdid.make("t3-host-capacity-slot-1");

const deviceA = SimulatorUdid.make("11111111-1111-4111-8111-111111111111");
const deviceB = SimulatorUdid.make("22222222-2222-4222-8222-222222222222");
const missingDevice = SimulatorUdid.make("33333333-3333-4333-8333-333333333333");

const devices: ReadonlyArray<SimulatorDevice> = [
  { udid: deviceA, name: "iPhone 17 Pro", runtime: "iOS 26.4", state: "shutdown" },
  { udid: deviceB, name: "iPhone 17", runtime: "iOS 26.4", state: "shutdown" },
];

const freshThreadId = (() => {
  let next = 0;
  return () => ThreadId.make(`simulator-manager-thread-${++next}`);
})();

interface Gate<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (reason?: unknown) => void;
}

const gate = <A>(): Gate<A> => {
  let resolve: (value: A) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeServeSimSupervisor extends ServeSimSupervisor {
  readonly starts: string[] = [];
  readonly stopped: string[] = [];
  readonly closed: string[] = [];
  readonly opened: string[] = [];
  readonly inputs: Array<{ readonly udid: string; readonly input: ServeSimInput }> = [];
  readonly #gates = new Map<string, Gate<ServeSimSession>>();
  readonly #started = new Map<string, Gate<void>>();
  readonly #cancelled = new Set<string>();

  override start(udid: string, options: ServeSimStartOptions = {}): Promise<ServeSimSession> {
    this.starts.push(udid);
    this.#startedFor(udid).resolve();
    if (this.#cancelled.has(udid) || options.signal?.aborted) {
      return Promise.reject(new Error(`serve-sim start cancelled for ${udid}`));
    }
    const pending = this.#gateFor(udid);
    const cancel = () => {
      this.#cancelled.add(udid);
      pending.reject(new Error(`serve-sim start cancelled for ${udid}`));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    return pending.promise.finally(() => options.signal?.removeEventListener("abort", cancel));
  }

  override async stop(sessionOrUdid: ServeSimSession | string): Promise<void> {
    const udid = typeof sessionOrUdid === "string" ? sessionOrUdid : sessionOrUdid.udid;
    this.stopped.push(udid);
    this.#cancelled.add(udid);
    this.#gates.get(udid)?.reject(new Error(`serve-sim stopped for ${udid}`));
  }

  override async openNative(udid: string): Promise<void> {
    this.opened.push(udid);
  }

  waitForStart(udid: SimulatorUdid): Promise<void> {
    return this.#startedFor(udid).promise;
  }

  ready(udid: SimulatorUdid): void {
    this.#gateFor(udid).resolve({
      udid,
      pid: 9001,
      port: 19_000,
      baseUrl: "http://127.0.0.1:19000",
      urls: {
        streamMjpeg: `http://127.0.0.1:19000/helper/${encodeURIComponent(udid)}/stream.mjpeg`,
        config: `http://127.0.0.1:19000/helper/${encodeURIComponent(udid)}/config`,
        health: `http://127.0.0.1:19000/helper/${encodeURIComponent(udid)}/health`,
        ax: `http://127.0.0.1:19000/helper/${encodeURIComponent(udid)}/ax`,
        foreground: `http://127.0.0.1:19000/helper/${encodeURIComponent(udid)}/foreground`,
        privateWebSocket: `ws://127.0.0.1:19000/helper/${encodeURIComponent(udid)}/ws`,
      },
      config: { width: 430, height: 932, orientation: "portrait" },
      stdoutTail: () => "",
      stderrTail: () => "",
      sendInput: async (input) => {
        this.inputs.push({ udid, input });
      },
      close: async () => {
        this.closed.push(udid);
      },
    });
  }

  #gateFor(udid: string): Gate<ServeSimSession> {
    const existing = this.#gates.get(udid);
    if (existing) return existing;
    const created = gate<ServeSimSession>();
    this.#gates.set(udid, created);
    return created;
  }

  #startedFor(udid: string): Gate<void> {
    const existing = this.#started.get(udid);
    if (existing) return existing;
    const created = gate<void>();
    this.#started.set(udid, created);
    return created;
  }
}

interface FakeHostLock {
  readonly lock: HostLock.SimulatorHostLock;
  readonly held: ReadonlyMap<string, HostLock.SimulatorHostLockLease>;
  readonly released: string[];
  readonly failNextRelease: (udid: SimulatorUdid) => void;
}

const makeContendedError = (input: HostLock.SimulatorHostLockInput) =>
  new HostLock.SimulatorHostLockContendedError({
    udid: input.udid,
    path: `/tmp/simulator-locks/${input.udid}`,
    ownerEnvironmentId: environmentId,
    ownerThreadId: foreignThreadId,
    ownerLeaseId: foreignLeaseId,
    ownerPid: 11,
    ownerProcessStartIdentity: "foreign-process-start",
    acquiredAt: "2026-08-09T00:00:00.000Z",
  });

const makeReleaseFailure = (lease: HostLock.SimulatorHostLockLease) =>
  new HostLock.SimulatorHostLockReleaseMismatchError({
    udid: lease.metadata.udid,
    path: lease.path,
    reason: "deterministic fake release failure",
  });

const makeFakeHostLock = (contended = new Set<string>()): FakeHostLock => {
  const held = new Map<string, HostLock.SimulatorHostLockLease>();
  const released: string[] = [];
  const releaseFailures = new Set<string>();
  let nextToken = 0;
  const lock: HostLock.SimulatorHostLock = {
    acquire: (input) => {
      if (contended.has(input.udid) || held.has(input.udid)) {
        return Effect.fail(makeContendedError(input));
      }
      const token = `test-lock-token-${++nextToken}`;
      const lease: HostLock.SimulatorHostLockLease = {
        path: `/tmp/simulator-locks/${input.udid}-${token}`,
        metadata: {
          version: 1,
          udid: input.udid,
          ownerToken: token,
          environmentId: input.environmentId,
          threadId: input.threadId,
          leaseId: input.leaseId,
          generation: input.generation,
          pid: 1,
          processStartIdentity: "test-process-start",
          createdAt: "2026-08-09T00:00:00.000Z",
          acquiredAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
      };
      held.set(input.udid, lease);
      return Effect.succeed(lease);
    },
    release: (lease) =>
      Effect.suspend(() => {
        if (releaseFailures.delete(lease.metadata.udid)) {
          return Effect.fail(makeReleaseFailure(lease));
        }
        return Effect.sync(() => {
          const active = held.get(lease.metadata.udid);
          if (active?.metadata.ownerToken === lease.metadata.ownerToken) {
            held.delete(lease.metadata.udid);
            released.push(lease.metadata.udid);
          }
        });
      }),
  };
  return {
    lock,
    held,
    released,
    failNextRelease: (udid) => releaseFailures.add(udid),
  };
};

const hostLayer = (platform: NodeJS.Platform, architecture: NodeJS.Architecture) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessArchitecture, architecture),
  );

const inventoryLayer = (inventoryDevices: ReadonlyArray<SimulatorDevice>) =>
  Layer.succeed(
    DeviceInventory.SimulatorInventory,
    DeviceInventory.SimulatorInventory.of({
      list: Effect.succeed({
        supported: true,
        host: { platform: "darwin", architecture: "arm64" },
        devices: inventoryDevices,
      }),
      find: (udid) =>
        Effect.succeed({
          supported: true,
          device: inventoryDevices.find((device) => device.udid === udid),
        }),
    }),
  );

const environmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("not used by simulator manager tests"),
  }),
);

const secretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none<Uint8Array>()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
    remove: () => Effect.void,
  }),
);

const testLayer = (input: {
  readonly supervisor: FakeServeSimSupervisor;
  readonly hostLock: FakeHostLock;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly inventoryDevices?: ReadonlyArray<SimulatorDevice>;
}) => {
  const dependencies = Layer.mergeAll(
    hostLayer(input.platform ?? "darwin", input.architecture ?? "arm64"),
    inventoryLayer(input.inventoryDevices ?? devices),
    environmentLayer,
    secretStoreLayer,
  );
  return SimulatorManager.layerWithOptions({
    hostLock: input.hostLock.lock,
    serveSim: input.supervisor,
  }).pipe(Layer.provide(dependencies));
};

it.effect("reports dynamic host capabilities and rejects unsupported execution", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const capabilities = yield* manager.capabilities;
    expect(capabilities).toMatchObject({
      host: { os: "linux", arch: "x64" },
      platformSupported: false,
      executionReady: false,
      deviceEnumeration: false,
      reason: "unsupported-platform",
    });

    const error = yield* Effect.flip(manager.acquire({ threadId: freshThreadId(), udid: deviceA }));
    expect(error).toBeInstanceOf(SimulatorUnsupportedPlatformError);
  }).pipe(
    Effect.provide(
      testLayer({
        supervisor,
        hostLock,
        platform: "linux",
        architecture: "x64",
      }),
    ),
  );
});

it.effect(
  "keeps discovery available but execution unavailable when no devices are installed",
  () => {
    const supervisor = new FakeServeSimSupervisor();
    const hostLock = makeFakeHostLock();
    return Effect.gen(function* () {
      const manager = yield* SimulatorManager.SimulatorManager;
      const capabilities = yield* manager.capabilities;
      const listed = yield* manager.list({});
      expect(capabilities).toMatchObject({
        platformSupported: true,
        deviceEnumeration: true,
        executionReady: false,
        liveStreaming: false,
        humanInput: false,
        agentAutomation: false,
        reason: "dependency-unavailable",
      });
      expect(listed.capabilities).toEqual(capabilities);
      expect(listed.devices).toEqual([]);
    }).pipe(Effect.provide(testLayer({ supervisor, hostLock, inventoryDevices: [] })));
  },
);

it.effect("validates an exact available UDID before it reserves a lease", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const error = yield* Effect.flip(
      manager.acquire({ threadId: freshThreadId(), udid: missingDevice }),
    );
    expect(error).toBeInstanceOf(SimulatorDeviceNotFoundError);
    expect(supervisor.starts).toEqual([]);
    expect(hostLock.held.size).toBe(0);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("keeps an exact thread lease idempotent and rejects a different requested UDID", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const first = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);
    const repeated = yield* manager.acquire({ threadId, udid: deviceA });
    const conflict = yield* Effect.flip(manager.acquire({ threadId, udid: deviceB }));

    expect(repeated).toEqual(first);
    expect(conflict._tag).toBe("SimulatorThreadLeaseConflictError");
    supervisor.ready(deviceA);
    yield* PubSub.take(events);
    expect(supervisor.starts).toEqual([deviceA]);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("transitions a lease asynchronously from starting to ready", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    expect(opening.session.state).toBe("starting");
    expect((yield* PubSub.take(events)).type).toBe("session");

    supervisor.ready(deviceA);
    const readyEvent = yield* PubSub.take(events);
    expect(readyEvent).toMatchObject({
      type: "session",
      sequence: 2,
      session: { leaseId: opening.session.leaseId, state: "ready", generation: 1 },
    });

    const status = yield* manager.status({ threadId, leaseId: opening.session.leaseId });
    expect(status.session).toMatchObject({
      state: "ready",
      media: {
        width: 430,
        height: 932,
        orientation: "portrait",
      },
    });
    expect(status.session?.media?.streamUrl).toMatch(/^\/api\/simulator\//);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("queues locally, drains after release, and fences the new generation", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const firstThread = freshThreadId();
    const secondThread = freshThreadId();
    const first = yield* manager.acquire({ threadId: firstThread, udid: deviceA });
    yield* PubSub.take(events);
    const second = yield* manager.acquire({ threadId: secondThread, udid: deviceB });
    const queuedEvent = yield* PubSub.take(events);
    expect(first.session.state).toBe("starting");
    expect(second.session).toMatchObject({ state: "queued", queuePosition: 1 });
    expect(queuedEvent).toMatchObject({
      type: "session",
      sequence: 2,
      session: { state: "queued" },
    });

    supervisor.ready(deviceA);
    const readyFirst = yield* PubSub.take(events);
    expect(readyFirst).toMatchObject({
      type: "session",
      sequence: 3,
      session: { state: "ready" },
    });
    yield* manager.release({
      threadId: firstThread,
      leaseId: first.session.leaseId,
      generation: first.session.generation,
    });
    const releasedFirst = yield* PubSub.take(events);
    expect(releasedFirst).toMatchObject({ type: "released", sequence: 4 });
    const startedSecond = yield* PubSub.take(events);
    expect(startedSecond).toMatchObject({
      type: "session",
      sequence: 5,
      session: { leaseId: second.session.leaseId, state: "starting", generation: 2 },
    });

    supervisor.ready(deviceB);
    const readySecond = yield* PubSub.take(events);
    expect(readySecond).toMatchObject({
      type: "session",
      sequence: 6,
      session: { leaseId: second.session.leaseId, state: "ready", generation: 2 },
    });

    const stale = yield* Effect.flip(
      manager.release({
        threadId: secondThread,
        leaseId: second.session.leaseId,
        generation: second.session.generation,
      }),
    );
    expect(stale._tag).toBe("SimulatorLeaseGenerationMismatchError");
    expect(supervisor.closed).toEqual([deviceA]);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("fails a starting session when the host-wide UDID lock is held elsewhere", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock(new Set([deviceA]));
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const opening = yield* manager.acquire({ threadId: freshThreadId(), udid: deviceA });
    expect(opening.session.state).toBe("starting");
    const starting = yield* PubSub.take(events);
    expect(starting).toMatchObject({ type: "session", sequence: 1 });
    const failed = yield* PubSub.take(events);
    expect(failed).toMatchObject({
      type: "session",
      sequence: 2,
      session: {
        leaseId: opening.session.leaseId,
        state: "failed",
        failure: { code: "simulator-locked", retryable: true },
      },
    });
    expect(supervisor.starts).toEqual([]);
    expect(hostLock.held.size).toBe(0);
    expect(hostLock.released).toEqual([capacityLockUdid]);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("binds stream resolution and input to the live lease generation", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);
    supervisor.ready(deviceA);
    yield* PubSub.take(events);

    const status = yield* manager.status({ threadId, leaseId: opening.session.leaseId });
    if (!status.session || status.session.state !== "ready")
      throw new Error("ready session expected");
    expect(status.session.media).toBeDefined();
    const stream = yield* manager.resolveStream({
      version: 1,
      environmentId,
      threadId,
      leaseId: status.session.leaseId,
      udid: status.session.udid,
      generation: status.session.generation,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(stream).toEqual({
      url: `http://127.0.0.1:19000/helper/${encodeURIComponent(deviceA)}/stream.mjpeg`,
      contentType: "multipart/x-mixed-replace; boundary=frame",
    });
    const wrongGeneration = yield* manager.resolveStream({
      version: 1,
      environmentId,
      threadId,
      leaseId: status.session.leaseId,
      udid: status.session.udid,
      generation: status.session.generation + 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(wrongGeneration).toBeNull();

    const accepted = yield* manager.sendInput({
      threadId,
      leaseId: status.session.leaseId,
      generation: status.session.generation,
      event: { type: "touch", phase: "begin", x: 0.25, y: 0.75 },
    });
    expect(accepted).toEqual({ accepted: true });
    expect(supervisor.inputs).toEqual([
      { udid: deviceA, input: { type: "touch", phase: "begin", x: 0.25, y: 0.75 } },
    ]);

    const invalid = yield* Effect.flip(
      manager.sendInput({
        threadId,
        leaseId: status.session.leaseId,
        generation: status.session.generation,
        event: { type: "touch", phase: "begin", x: Number.NaN, y: 0.75 } as never,
      }),
    );
    expect(invalid).toBeInstanceOf(SimulatorRuntimeUnavailableError);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("opens only the exact ready device owned by the current lease", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);

    const starting = yield* Effect.flip(
      manager.open({
        threadId,
        leaseId: opening.session.leaseId,
        generation: opening.session.generation,
      }),
    );
    expect(starting).toBeInstanceOf(SimulatorRuntimeUnavailableError);
    expect(supervisor.opened).toEqual([]);

    supervisor.ready(deviceA);
    yield* PubSub.take(events);
    const ready = yield* manager.status({ threadId, leaseId: opening.session.leaseId });
    if (!ready.session) throw new Error("ready session expected");

    expect(
      yield* manager.open({
        threadId,
        leaseId: ready.session.leaseId,
        generation: ready.session.generation,
      }),
    ).toEqual({ opened: true });
    expect(supervisor.opened).toEqual([deviceA]);

    const stale = yield* Effect.flip(
      manager.open({
        threadId,
        leaseId: ready.session.leaseId,
        generation: ready.session.generation + 1,
      }),
    );
    expect(stale).toBeInstanceOf(SimulatorLeaseGenerationMismatchError);

    const foreign = yield* Effect.flip(
      manager.open({
        threadId: foreignThreadId,
        leaseId: ready.session.leaseId,
        generation: ready.session.generation,
      }),
    );
    expect(foreign).toBeInstanceOf(SimulatorLeaseNotFoundError);
    expect(supervisor.opened).toEqual([deviceA]);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("releases a ready thread session, its sidecar, and both host locks", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);
    supervisor.ready(deviceA);
    yield* PubSub.take(events);

    yield* manager.releaseThread(threadId);
    const released = yield* PubSub.take(events);
    expect(released).toMatchObject({
      type: "released",
      sequence: 3,
      leaseId: opening.session.leaseId,
    });
    expect(supervisor.closed).toEqual([deviceA]);
    expect(hostLock.held.size).toBe(0);
    expect(hostLock.released).toEqual([deviceA, capacityLockUdid]);
    expect((yield* manager.status({ threadId })).session).toBeNull();
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("keeps thread-deletion cleanup fail-closed and retryable", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);
    supervisor.ready(deviceA);
    yield* PubSub.take(events);

    hostLock.failNextRelease(deviceA);
    const cleanupError = yield* Effect.flip(manager.releaseThread(threadId));
    expect(cleanupError).toMatchObject({
      _tag: "SimulatorRuntimeUnavailableError",
      leaseId: opening.session.leaseId,
      operation: "device-lock-release",
    });
    expect((yield* manager.status({ threadId })).session).toMatchObject({
      leaseId: opening.session.leaseId,
    });

    yield* manager.releaseThread(threadId);
    expect(yield* PubSub.take(events)).toMatchObject({
      type: "released",
      leaseId: opening.session.leaseId,
    });
    expect(hostLock.held.size).toBe(0);
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("fails closed when a lock release fails and retries only the remaining cleanup", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);
    supervisor.ready(deviceA);
    yield* PubSub.take(events);

    hostLock.failNextRelease(deviceA);
    const cleanupError = yield* Effect.flip(
      manager.release({
        threadId,
        leaseId: opening.session.leaseId,
        generation: opening.session.generation,
      }),
    );
    expect(cleanupError).toMatchObject({
      _tag: "SimulatorRuntimeUnavailableError",
      leaseId: opening.session.leaseId,
      operation: "device-lock-release",
    });
    expect(supervisor.closed).toEqual([deviceA]);
    expect(hostLock.held.size).toBe(2);
    expect((yield* manager.status({ threadId })).session).toMatchObject({
      leaseId: opening.session.leaseId,
    });

    yield* manager.release({
      threadId,
      leaseId: opening.session.leaseId,
      generation: opening.session.generation,
    });
    const released = yield* PubSub.take(events);
    expect(released).toMatchObject({
      type: "released",
      sequence: 3,
      leaseId: opening.session.leaseId,
    });
    expect(supervisor.closed).toEqual([deviceA]);
    expect(hostLock.held.size).toBe(0);
    expect(hostLock.released).toEqual([deviceA, capacityLockUdid]);
    expect((yield* manager.status({ threadId })).session).toBeNull();
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("cancels and awaits a blocked start before it reports the lease released", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.gen(function* () {
    const manager = yield* SimulatorManager.SimulatorManager;
    const events = yield* manager.subscribeEvents;
    const threadId = freshThreadId();
    const opening = yield* manager.acquire({ threadId, udid: deviceA });
    yield* PubSub.take(events);
    yield* Effect.promise(() => supervisor.waitForStart(deviceA));
    expect(hostLock.held.size).toBe(2);

    const released = yield* manager.release({
      threadId,
      leaseId: opening.session.leaseId,
      generation: opening.session.generation,
    });
    expect(released).toEqual({
      released: true,
      leaseId: opening.session.leaseId,
      generation: opening.session.generation,
    });
    expect(yield* PubSub.take(events)).toMatchObject({
      type: "released",
      sequence: 2,
      leaseId: opening.session.leaseId,
    });
    expect(supervisor.stopped).toContain(deviceA);
    expect(hostLock.held.size).toBe(0);
    expect((yield* manager.status({ threadId })).session).toBeNull();
  }).pipe(Effect.provide(testLayer({ supervisor, hostLock })));
});

it.effect("cancels and awaits a blocked start when the manager layer closes", () => {
  const supervisor = new FakeServeSimSupervisor();
  const hostLock = makeFakeHostLock();
  return Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* SimulatorManager.SimulatorManager;
      const opening = yield* manager.acquire({ threadId: freshThreadId(), udid: deviceA });
      expect(opening.session.state).toBe("starting");
      yield* Effect.promise(() => supervisor.waitForStart(deviceA));
      expect(hostLock.held.size).toBe(2);
    }).pipe(Effect.provide(testLayer({ supervisor, hostLock }))),
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(supervisor.stopped).toContain(deviceA);
        expect(hostLock.held.size).toBe(0);
        expect(hostLock.released).toEqual([deviceA, capacityLockUdid]);
      }),
    ),
  );
});
