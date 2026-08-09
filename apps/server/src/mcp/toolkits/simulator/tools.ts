import {
  EnvironmentId,
  PositiveInt,
  SimulatorAcquireResult,
  SimulatorCapabilities,
  SimulatorError,
  SimulatorLeaseId,
  SimulatorListResult,
  SimulatorStatusResult,
  SimulatorUdid,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SimulatorAutomation from "../../../simulator/Automation.ts";
import * as SimulatorManager from "../../../simulator/Manager.ts";

/**
 * MCP tools deliberately depend on the complete simulator boundary. This
 * keeps capability negotiation, lease ownership, workspace resolution, and
 * XcodeBuildMCP execution in one authenticated invocation scope.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  SimulatorManager.SimulatorManager,
  SimulatorAutomation.SimulatorAutomation,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

/** A local error for threads that no longer have a usable workspace context. */
export class McpSimulatorWorkspaceUnavailableError extends Schema.TaggedErrorClass<McpSimulatorWorkspaceUnavailableError>()(
  "McpSimulatorWorkspaceUnavailableError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No workspace context is available for simulator thread ${this.threadId}.`;
  }
}

const iosSessionOpenInput = Schema.Struct({
  udid: SimulatorUdid.annotate({
    description:
      "The exact iOS Simulator UDID to lease. Use ios_list_simulators first; do not pass a device name or infer a UDID.",
  }),
});

export type IosSessionOpenInput = typeof iosSessionOpenInput.Type;

const leaseInput = {
  leaseId: SimulatorLeaseId.annotate({
    description: "The exact leaseId returned by ios_session_open.",
  }),
  generation: PositiveInt.annotate({
    description:
      "The current lease generation returned by ios_session_open or ios_session_status; stale generations are rejected.",
  }),
};

const iosSessionStatusInput = Schema.Struct({
  leaseId: Schema.optional(
    SimulatorLeaseId.annotate({
      description:
        "Optional lease id to verify. Omit it to return this authenticated thread's current simulator session.",
    }),
  ),
});

export type IosSessionStatusInput = typeof iosSessionStatusInput.Type;

const iosSessionCloseInput = Schema.Struct(leaseInput);

export type IosSessionCloseInput = typeof iosSessionCloseInput.Type;

const boundedDelay = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
const boundedDuration = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 120_000 }));
const boundedDistance = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }));
const boundedPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const boundedArgument = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const boundedText = Schema.String.check(Schema.isMaxLength(32_000));

const iosBuildRunInput = Schema.Struct({
  ...leaseInput,
  projectPath: Schema.optional(
    boundedPath.annotate({ description: "Project path relative to the thread workspace." }),
  ),
  workspacePath: Schema.optional(
    boundedPath.annotate({ description: "Workspace path relative to the thread workspace." }),
  ),
  scheme: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "The Xcode scheme to build and run.",
  }),
  configuration: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  derivedDataPath: Schema.optional(boundedPath),
  launchArgs: Schema.optional(Schema.Array(boundedArgument).check(Schema.isMaxLength(64))),
  useLatestOS: Schema.optional(Schema.Boolean),
  preferXcodebuild: Schema.optional(Schema.Boolean),
});

const iosLaunchAppInput = Schema.Struct({
  ...leaseInput,
  bundleId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "The bundle identifier to launch on the leased exact simulator UDID.",
  }),
  launchArgs: Schema.optional(Schema.Array(boundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optional(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      Schema.String.check(Schema.isMaxLength(4_096)),
    ),
  ),
});

const iosStopAppInput = Schema.Struct({
  ...leaseInput,
  bundleId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});

const iosSnapshotUiInput = Schema.Struct({
  ...leaseInput,
  sinceScreenHash: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});

const iosScreenshotInput = Schema.Struct({
  ...leaseInput,
  returnFormat: Schema.optional(Schema.Literals(["path", "base64"])),
});

const iosTapInput = Schema.Struct({
  ...leaseInput,
  elementRef: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
    description:
      "The semantic accessibility elementRef from ios_snapshot_ui. Coordinates are not accepted.",
  }),
  preDelay: Schema.optional(boundedDelay),
  postDelay: Schema.optional(boundedDelay),
});

const iosTypeTextInput = Schema.Struct({
  ...leaseInput,
  elementRef: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
    description:
      "The semantic accessibility elementRef from ios_snapshot_ui. Coordinates are not accepted.",
  }),
  text: boundedText,
  replaceExisting: Schema.optional(Schema.Boolean),
});

const iosWaitForUiInput = Schema.Struct({
  ...leaseInput,
  predicate: Schema.Literals(["exists", "gone", "enabled", "focused", "textContains", "settled"]),
  elementRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
  identifier: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  timeoutMs: Schema.optional(boundedDuration),
  pollIntervalMs: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 10, maximum: 10_000 })),
  ),
  settledDurationMs: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 50, maximum: 10_000 })),
  ),
});

const iosSwipeInput = Schema.Struct({
  ...leaseInput,
  withinElementRef: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
    description:
      "The semantic accessibility elementRef that bounds the swipe. Coordinates are not accepted.",
  }),
  direction: Schema.Literals(["up", "down", "left", "right"]),
  duration: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  distance: Schema.optional(boundedDistance),
  preDelay: Schema.optional(boundedDelay),
  postDelay: Schema.optional(boundedDelay),
});

export const IosSessionCloseResult = Schema.Struct({
  released: Schema.Literal(true),
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
});

const simulatorFailure = Schema.Union([
  SimulatorError,
  McpInvocationContext.McpCapabilityUnavailableError,
  McpSimulatorWorkspaceUnavailableError,
  SimulatorAutomation.SimulatorAutomationLeaseError,
  SimulatorAutomation.SimulatorAutomationCwdError,
  SimulatorAutomation.SimulatorAutomationInputError,
  SimulatorAutomation.SimulatorAutomationToolError,
]);

const automationFailure = simulatorFailure;
// XcodeBuildMCP guarantees a structured MCP payload but owns the operation-
// specific fields. Preserve those fields while still advertising an object
// output schema to MCP clients.
const xcodeBuildMcpResult = Schema.Record(Schema.String, Schema.Unknown);

export const IosCapabilitiesTool = Tool.make("ios_capabilities", {
  description:
    "Report iOS Simulator host support, exact-device enumeration, live streaming, human input, and XcodeBuildMCP agent automation readiness.",
  parameters: Schema.Struct({}),
  success: SimulatorCapabilities,
  failure: simulatorFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get iOS Simulator capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const IosListSimulatorsTool = Tool.make("ios_list_simulators", {
  description:
    "List available iOS Simulators by exact UDID and report authenticated thread sessions. Use the returned UDID with ios_session_open.",
  parameters: Schema.Struct({}),
  success: SimulatorListResult,
  failure: simulatorFailure,
  dependencies,
})
  .annotate(Tool.Title, "List iOS Simulators")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const IosSessionOpenTool = Tool.make("ios_session_open", {
  description:
    "Lease one exact iOS Simulator UDID for this authenticated agent thread. The call returns immediately with a queued or starting session; use ios_session_status until it is ready before invoking automation.",
  parameters: iosSessionOpenInput,
  success: SimulatorAcquireResult,
  failure: simulatorFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open iOS Simulator session")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const IosSessionStatusTool = Tool.make("ios_session_status", {
  description:
    "Report this authenticated agent thread's current iOS Simulator lease, ready state, exact UDID, and signed live-stream metadata.",
  parameters: iosSessionStatusInput,
  success: SimulatorStatusResult,
  failure: simulatorFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get iOS Simulator session status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const IosSessionCloseTool = Tool.make("ios_session_close", {
  description:
    "Close the current exact simulator lease owned by this authenticated thread. The server first closes the lease-scoped XcodeBuildMCP child, then stops serve-sim and releases host/device locks.",
  parameters: iosSessionCloseInput,
  success: IosSessionCloseResult,
  failure: simulatorFailure,
  dependencies,
})
  .annotate(Tool.Title, "Close iOS Simulator session")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

const automationTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

export const IosBuildRunTool = automationTool(
  Tool.make("ios_build_run", {
    description:
      "Build and run an iOS project or workspace from this authenticated thread's workspace on the leased exact simulator UDID. The server confines paths to the thread workspace and uses isolated derived data.",
    parameters: iosBuildRunInput,
    success: xcodeBuildMcpResult,
    failure: automationFailure,
    dependencies,
  }).annotate(Tool.Title, "Build and run on iOS Simulator"),
);

export const IosLaunchAppTool = automationTool(
  Tool.make("ios_launch_app", {
    description:
      "Launch an already-installed iOS app by bundle identifier on the leased exact simulator UDID. Pass the bundle identifier, not a device name or coordinate.",
    parameters: iosLaunchAppInput,
    success: xcodeBuildMcpResult,
    failure: automationFailure,
    dependencies,
  }).annotate(Tool.Title, "Launch iOS app"),
);

export const IosStopAppTool = automationTool(
  Tool.make("ios_stop_app", {
    description:
      "Stop an installed iOS app by bundle identifier on the leased exact simulator UDID.",
    parameters: iosStopAppInput,
    success: xcodeBuildMcpResult,
    failure: automationFailure,
    dependencies,
  }).annotate(Tool.Title, "Stop iOS app"),
);

export const IosSnapshotUiTool = Tool.make("ios_snapshot_ui", {
  description:
    "Return the current semantic accessibility snapshot from the leased exact simulator UDID. Use elementRef values from this snapshot for tap, type, and swipe; raw serve-sim routes are never exposed.",
  parameters: iosSnapshotUiInput,
  success: xcodeBuildMcpResult,
  failure: automationFailure,
  dependencies,
})
  .annotate(Tool.Title, "Snapshot iOS accessibility tree")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const IosScreenshotTool = Tool.make("ios_screenshot", {
  description:
    "Capture the leased exact simulator as a bounded XcodeBuildMCP screenshot artifact. Choose path for a local artifact reference or base64 when the agent needs image data.",
  parameters: iosScreenshotInput,
  success: xcodeBuildMcpResult,
  failure: automationFailure,
  dependencies,
})
  .annotate(Tool.Title, "Capture iOS Simulator screenshot")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const IosTapTool = automationTool(
  Tool.make("ios_tap", {
    description:
      "Tap one semantic accessibility element from ios_snapshot_ui on the leased exact simulator UDID. This tool accepts elementRef only and never accepts coordinates.",
    parameters: iosTapInput,
    success: xcodeBuildMcpResult,
    failure: automationFailure,
    dependencies,
  }).annotate(Tool.Title, "Tap iOS accessibility element"),
);

export const IosTypeTextTool = automationTool(
  Tool.make("ios_type_text", {
    description:
      "Type literal text into one semantic accessibility element from ios_snapshot_ui on the leased exact simulator UDID. This tool accepts elementRef only and never accepts coordinates.",
    parameters: iosTypeTextInput,
    success: xcodeBuildMcpResult,
    failure: automationFailure,
    dependencies,
  }).annotate(Tool.Title, "Type into iOS accessibility element"),
);

export const IosWaitForUiTool = Tool.make("ios_wait_for_ui", {
  description:
    "Wait for a semantic accessibility condition on the leased exact simulator UDID. Prefer elementRef, identifier, label, role, or text predicates; coordinates and arbitrary code are not accepted.",
  parameters: iosWaitForUiInput,
  success: xcodeBuildMcpResult,
  failure: automationFailure,
  dependencies,
})
  .annotate(Tool.Title, "Wait for iOS accessibility state")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const IosSwipeTool = automationTool(
  Tool.make("ios_swipe", {
    description:
      "Swipe within one semantic accessibility element from ios_snapshot_ui on the leased exact simulator UDID. This tool accepts withinElementRef and direction only, never coordinates.",
    parameters: iosSwipeInput,
    success: xcodeBuildMcpResult,
    failure: automationFailure,
    dependencies,
  }).annotate(Tool.Title, "Swipe iOS accessibility container"),
);

export const IosSimulatorToolkit = Toolkit.make(
  IosCapabilitiesTool,
  IosListSimulatorsTool,
  IosSessionOpenTool,
  IosSessionStatusTool,
  IosSessionCloseTool,
  IosBuildRunTool,
  IosLaunchAppTool,
  IosStopAppTool,
  IosSnapshotUiTool,
  IosScreenshotTool,
  IosTapTool,
  IosTypeTextTool,
  IosWaitForUiTool,
  IosSwipeTool,
);
