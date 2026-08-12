import {
  SimulatorLeaseGenerationMismatchError,
  SimulatorLeaseNotFoundError,
  SimulatorRuntimeUnavailableError,
  type SimulatorLeaseId,
  type SimulatorSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SimulatorAutomation from "../../../simulator/Automation.ts";
import * as SimulatorManager from "../../../simulator/Manager.ts";
import { releaseSimulatorLeaseAfterAutomationClose } from "../../../simulator/Release.ts";
import { IosSimulatorToolkit, McpSimulatorWorkspaceUnavailableError } from "./tools.ts";

const requireSimulator = () => McpInvocationContext.requireMcpCapability("ios-simulator");

const resolveThreadWorkspace = Effect.fn("IosSimulatorToolkit.resolveThreadWorkspace")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
) {
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const context = yield* query.getThreadCheckpointContext(invocation.threadId).pipe(
    Effect.mapError(
      () =>
        new McpSimulatorWorkspaceUnavailableError({
          environmentId: invocation.environmentId,
          threadId: invocation.threadId,
        }),
    ),
  );
  if (Option.isNone(context)) {
    return yield* new McpSimulatorWorkspaceUnavailableError({
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
    });
  }
  const cwd = context.value.worktreePath ?? context.value.workspaceRoot;
  if (cwd.trim().length === 0) {
    return yield* new McpSimulatorWorkspaceUnavailableError({
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
    });
  }
  return cwd;
});

type LeaseInput = {
  readonly leaseId: SimulatorLeaseId;
  readonly generation: number;
};

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

const compact = <T extends Readonly<Record<string, unknown>>>(input: T): Defined<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Defined<T>;

const requireReadySession = Effect.fn("IosSimulatorToolkit.requireReadySession")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
  input: LeaseInput,
  operation: string,
) {
  const manager = yield* SimulatorManager.SimulatorManager;
  const status = yield* manager.status({
    threadId: invocation.threadId,
    leaseId: input.leaseId,
  });
  const session = status.session;
  if (session === null) {
    return yield* new SimulatorLeaseNotFoundError({
      threadId: invocation.threadId,
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
  if (session.state !== "ready") {
    return yield* new SimulatorRuntimeUnavailableError({
      leaseId: input.leaseId,
      operation,
      cause:
        session.failure?.message ??
        `The simulator lease is ${session.state}; wait for ios_session_status to report ready.`,
    });
  }
  return session;
});

const withAutomation = (
  input: LeaseInput,
  operation: string,
  action: (
    automation: SimulatorAutomation.SimulatorAutomation["Service"],
    context: { readonly session: SimulatorSession; readonly cwd: string },
  ) => Effect.Effect<unknown, SimulatorAutomation.SimulatorAutomationError>,
) =>
  Effect.gen(function* () {
    const invocation = yield* requireSimulator();
    const session = yield* requireReadySession(invocation, input, operation);
    const cwd = yield* resolveThreadWorkspace(invocation);
    const automation = yield* SimulatorAutomation.SimulatorAutomation;
    const result = yield* action(automation, { session, cwd });
    if (!Predicate.isObject(result)) {
      return yield* new SimulatorAutomation.SimulatorAutomationToolError({
        operation,
        code: "invalid-response",
        detail: "XcodeBuildMCP returned a non-object result.",
      });
    }
    return result;
  });

/**
 * A successful build-and-run intentionally retains its ready session for the
 * follow-up semantic automation tools. If install or launch fails (including
 * interruption), only undo a lease created by this invocation. A manually
 * opened or otherwise reused session stays under its original owner's control.
 */
const releaseNewlyAcquiredLease = (
  manager: Pick<SimulatorManager.SimulatorManager["Service"], "release" | "status">,
  automation: Pick<SimulatorAutomation.SimulatorAutomation["Service"], "closeSession">,
  threadId: SimulatorSession["threadId"],
  acquired: { readonly session: SimulatorSession; readonly acquiredByCall: boolean },
) =>
  acquired.acquiredByCall
    ? releaseSimulatorLeaseAfterAutomationClose(manager, automation, {
        threadId,
        leaseId: acquired.session.leaseId,
        generation: acquired.session.generation,
      }).pipe(Effect.asVoid)
    : Effect.void;

const handlers = {
  ios_capabilities: (_input) =>
    Effect.gen(function* () {
      yield* requireSimulator();
      const manager = yield* SimulatorManager.SimulatorManager;
      return yield* manager.capabilities;
    }),
  ios_list_simulators: (_input) =>
    Effect.gen(function* () {
      const invocation = yield* requireSimulator();
      const manager = yield* SimulatorManager.SimulatorManager;
      const result = yield* manager.list({});
      // The manager already scopes sessions internally. Keep the MCP surface
      // thread-bound by returning only this invocation's own session.
      return {
        ...result,
        sessions: result.sessions.filter((session) => session.threadId === invocation.threadId),
      };
    }),
  ios_session_status: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireSimulator();
      const manager = yield* SimulatorManager.SimulatorManager;
      return yield* manager.status({ threadId: invocation.threadId, leaseId: input.leaseId });
    }),
  ios_session_close: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireSimulator();
      const manager = yield* SimulatorManager.SimulatorManager;
      const automation = yield* SimulatorAutomation.SimulatorAutomation;
      return yield* releaseSimulatorLeaseAfterAutomationClose(manager, automation, {
        threadId: invocation.threadId,
        leaseId: input.leaseId,
        generation: input.generation,
      });
    }),
  ios_build_run: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireSimulator();
      const cwd = yield* resolveThreadWorkspace(invocation);
      const automation = yield* SimulatorAutomation.SimulatorAutomation;
      const manager = yield* SimulatorManager.SimulatorManager;
      const { launchArgs, env, ...buildInput } = input;

      // Do the expensive build and .app/bundle validation before occupying
      // the single shared Simulator slot.
      const preparedBuild = yield* automation.prepareBuild(compact({ cwd, ...buildInput }));

      return yield* Effect.acquireUseRelease(
        manager.acquireReady({ threadId: invocation.threadId, udid: input.udid }),
        (acquired) =>
          automation
            .installLaunch(
              compact({
                session: acquired.session,
                cwd,
                preparedBuild,
                launchArgs,
                env,
              }),
            )
            .pipe(
              Effect.map((results) => ({
                session: acquired.session,
                appPath: preparedBuild.appPath,
                bundleId: preparedBuild.bundleId,
                results,
              })),
            ),
        (acquired, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : releaseNewlyAcquiredLease(manager, automation, invocation.threadId, acquired),
      );
    }),
  ios_launch_app: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "launch-app", (automation, context) =>
      automation.launch(compact({ ...operationInput, ...context })),
    );
  },
  ios_stop_app: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "stop-app", (automation, context) =>
      automation.stop(compact({ ...operationInput, ...context })),
    );
  },
  ios_snapshot_ui: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "snapshot-ui", (automation, context) =>
      automation.snapshotUi(compact({ ...operationInput, ...context })),
    );
  },
  ios_screenshot: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "screenshot", (automation, context) =>
      automation.screenshot(compact({ ...operationInput, ...context })),
    );
  },
  ios_tap: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "tap", (automation, context) =>
      automation.tap(compact({ ...operationInput, ...context })),
    );
  },
  ios_type_text: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "type-text", (automation, context) =>
      automation.typeText(compact({ ...operationInput, ...context })),
    );
  },
  ios_wait_for_ui: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "wait-for-ui", (automation, context) =>
      automation.waitForUi(compact({ ...operationInput, ...context })),
    );
  },
  ios_swipe: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "swipe", (automation, context) =>
      automation.swipe(compact({ ...operationInput, ...context })),
    );
  },
} satisfies Parameters<typeof IosSimulatorToolkit.toLayer>[0];

export const IosSimulatorToolkitHandlersLive = IosSimulatorToolkit.toLayer(handlers);
