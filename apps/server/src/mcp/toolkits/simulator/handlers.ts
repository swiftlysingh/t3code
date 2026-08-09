import {
  SimulatorLeaseGenerationMismatchError,
  SimulatorLeaseNotFoundError,
  SimulatorRuntimeUnavailableError,
  type SimulatorLeaseId,
  type SimulatorSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SimulatorAutomation from "../../../simulator/Automation.ts";
import * as SimulatorManager from "../../../simulator/Manager.ts";
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

const compact = (input: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

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

const withAutomation = <A>(
  input: LeaseInput,
  operation: string,
  action: (
    automation: SimulatorAutomation.SimulatorAutomation["Service"],
    context: { readonly session: SimulatorSession; readonly cwd: string },
  ) => Effect.Effect<A, SimulatorAutomation.SimulatorAutomationError>,
) =>
  Effect.gen(function* () {
    const invocation = yield* requireSimulator();
    const session = yield* requireReadySession(invocation, input, operation);
    const cwd = yield* resolveThreadWorkspace(invocation);
    const automation = yield* SimulatorAutomation.SimulatorAutomation;
    return yield* action(automation, { session, cwd });
  });

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
  ios_session_open: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireSimulator();
      const manager = yield* SimulatorManager.SimulatorManager;
      return yield* manager.acquire({ threadId: invocation.threadId, udid: input.udid });
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
      const automation = yield* SimulatorAutomation.SimulatorAutomation;
      const manager = yield* SimulatorManager.SimulatorManager;
      // Stop the lease-scoped XcodeBuildMCP child before Manager tears down
      // serve-sim and releases the host/device lock.
      const status = yield* manager.status({
        threadId: invocation.threadId,
        leaseId: input.leaseId,
      });
      const session = status.session;
      if (session !== null) {
        if (session.generation !== input.generation) {
          return yield* new SimulatorLeaseGenerationMismatchError({
            leaseId: input.leaseId,
            expectedGeneration: session.generation,
            receivedGeneration: input.generation,
          });
        }
        // The Manager snapshot is the authoritative exact lease identity.
        // Closing by session avoids trusting a separately resolved workspace
        // path and fences a release that raced the first automation call.
        yield* automation.closeSession(session);
      }
      return yield* manager.release({
        threadId: invocation.threadId,
        leaseId: input.leaseId,
        generation: input.generation,
      });
    }),
  ios_build_run: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "build-run", (automation, context) =>
      automation.buildRun({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationBuildRunInput),
    );
  },
  ios_launch_app: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "launch-app", (automation, context) =>
      automation.launch({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationLaunchInput),
    );
  },
  ios_stop_app: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "stop-app", (automation, context) =>
      automation.stop({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationStopInput),
    );
  },
  ios_snapshot_ui: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "snapshot-ui", (automation, context) =>
      automation.snapshotUi({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationSnapshotUiInput),
    );
  },
  ios_screenshot: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "screenshot", (automation, context) =>
      automation.screenshot({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationScreenshotInput),
    );
  },
  ios_tap: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "tap", (automation, context) =>
      automation.tap({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationTapInput),
    );
  },
  ios_type_text: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "type-text", (automation, context) =>
      automation.typeText({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationTypeTextInput),
    );
  },
  ios_wait_for_ui: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "wait-for-ui", (automation, context) =>
      automation.waitForUi({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationWaitForUiInput),
    );
  },
  ios_swipe: (input) => {
    const { leaseId, generation, ...operationInput } = input;
    return withAutomation({ leaseId, generation }, "swipe", (automation, context) =>
      automation.swipe({
        ...compact({ ...context, ...operationInput }),
      } as unknown as SimulatorAutomation.SimulatorAutomationSwipeInput),
    );
  },
} satisfies Parameters<typeof IosSimulatorToolkit.toLayer>[0];

export const IosSimulatorToolkitHandlersLive = IosSimulatorToolkit.toLayer(handlers);
