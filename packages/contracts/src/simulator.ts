import { Schema } from "effect";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const SimulatorUdid = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("SimulatorUdid"),
);
export type SimulatorUdid = typeof SimulatorUdid.Type;

export const SimulatorLeaseId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("SimulatorLeaseId"),
);
export type SimulatorLeaseId = typeof SimulatorLeaseId.Type;

export const SimulatorHostOs = Schema.Literals(["darwin", "linux", "windows", "unknown"]);
export type SimulatorHostOs = typeof SimulatorHostOs.Type;

export const SimulatorHostArch = Schema.Literals(["arm64", "x64", "other"]);
export type SimulatorHostArch = typeof SimulatorHostArch.Type;

export const SimulatorHostPlatform = Schema.Struct({
  os: SimulatorHostOs,
  arch: SimulatorHostArch,
});
export type SimulatorHostPlatform = typeof SimulatorHostPlatform.Type;

export const SimulatorCapabilityReason = Schema.Literals([
  "unsupported-platform",
  "dependency-unavailable",
]);
export type SimulatorCapabilityReason = typeof SimulatorCapabilityReason.Type;

export const SimulatorCapabilities = Schema.Struct({
  host: SimulatorHostPlatform,
  platformSupported: Schema.Boolean,
  executionReady: Schema.Boolean,
  deviceEnumeration: Schema.Boolean,
  liveStreaming: Schema.Boolean,
  humanInput: Schema.Boolean,
  agentAutomation: Schema.Boolean,
  maxActive: PositiveInt,
  reason: Schema.NullOr(SimulatorCapabilityReason),
});
export type SimulatorCapabilities = typeof SimulatorCapabilities.Type;

export const SimulatorDeviceState = Schema.Literals(["booted", "shutdown", "unknown"]);
export type SimulatorDeviceState = typeof SimulatorDeviceState.Type;

export const SimulatorDevice = Schema.Struct({
  udid: SimulatorUdid,
  name: TrimmedNonEmptyString,
  runtime: TrimmedNonEmptyString,
  state: SimulatorDeviceState,
});
export type SimulatorDevice = typeof SimulatorDevice.Type;

export const SimulatorRuntimeState = Schema.Literals(["queued", "starting", "ready", "failed"]);
export type SimulatorRuntimeState = typeof SimulatorRuntimeState.Type;

export const SimulatorOrientation = Schema.Literals([
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right",
]);
export type SimulatorOrientation = typeof SimulatorOrientation.Type;

export const SimulatorMediaSession = Schema.Struct({
  streamUrl: TrimmedNonEmptyString,
  width: NonNegativeInt,
  height: NonNegativeInt,
  orientation: SimulatorOrientation,
  expiresAt: Schema.Number,
});
export type SimulatorMediaSession = typeof SimulatorMediaSession.Type;

export const SimulatorFailure = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});
export type SimulatorFailure = typeof SimulatorFailure.Type;

export const SimulatorSession = Schema.Struct({
  leaseId: SimulatorLeaseId,
  threadId: ThreadId,
  udid: SimulatorUdid,
  generation: PositiveInt,
  state: SimulatorRuntimeState,
  queuePosition: Schema.optional(PositiveInt),
  media: Schema.optional(SimulatorMediaSession),
  failure: Schema.optional(SimulatorFailure),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SimulatorSession = typeof SimulatorSession.Type;

export const SimulatorAcquireInput = Schema.Struct({
  threadId: ThreadId,
  udid: SimulatorUdid,
});
export type SimulatorAcquireInput = typeof SimulatorAcquireInput.Type;

export const SimulatorAcquireResult = Schema.Struct({
  session: SimulatorSession,
});
export type SimulatorAcquireResult = typeof SimulatorAcquireResult.Type;

export const SimulatorListInput = Schema.Struct({});
export type SimulatorListInput = typeof SimulatorListInput.Type;

export const SimulatorListResult = Schema.Struct({
  capabilities: SimulatorCapabilities,
  devices: Schema.Array(SimulatorDevice),
  sessions: Schema.Array(SimulatorSession),
});
export type SimulatorListResult = typeof SimulatorListResult.Type;

export const SimulatorStatusInput = Schema.Struct({
  threadId: ThreadId,
  leaseId: Schema.optional(SimulatorLeaseId),
});
export type SimulatorStatusInput = typeof SimulatorStatusInput.Type;

export const SimulatorStatusResult = Schema.Struct({
  capabilities: SimulatorCapabilities,
  threadId: ThreadId,
  session: Schema.NullOr(SimulatorSession),
});
export type SimulatorStatusResult = typeof SimulatorStatusResult.Type;

export const SimulatorReleaseInput = Schema.Struct({
  threadId: ThreadId,
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
});
export type SimulatorReleaseInput = typeof SimulatorReleaseInput.Type;

export const SimulatorReleaseResult = Schema.Struct({
  released: Schema.Literal(true),
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
});
export type SimulatorReleaseResult = typeof SimulatorReleaseResult.Type;

export const SimulatorOpenInput = Schema.Struct({
  threadId: ThreadId,
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
});
export type SimulatorOpenInput = typeof SimulatorOpenInput.Type;

export const SimulatorOpenResult = Schema.Struct({ opened: Schema.Literal(true) });
export type SimulatorOpenResult = typeof SimulatorOpenResult.Type;

export const SimulatorTouchInput = Schema.Struct({
  type: Schema.Literal("touch"),
  phase: Schema.Literals(["begin", "move", "end"]),
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

export const SimulatorHomeInput = Schema.Struct({ type: Schema.Literal("home") });

export const SimulatorKeyboardInput = Schema.Struct({
  type: Schema.Literal("keyboard"),
  phase: Schema.Literals(["down", "up"]),
  usage: NonNegativeInt.check(Schema.isLessThanOrEqualTo(255)),
});

export const SimulatorOrientationInput = Schema.Struct({
  type: Schema.Literal("orientation"),
  orientation: SimulatorOrientation,
});

export const SimulatorScrollInput = Schema.Struct({
  type: Schema.Literal("scroll"),
  dx: Schema.Number,
  dy: Schema.Number,
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

export const SimulatorInputEvent = Schema.Union([
  SimulatorTouchInput,
  SimulatorHomeInput,
  SimulatorKeyboardInput,
  SimulatorOrientationInput,
  SimulatorScrollInput,
]);
export type SimulatorInputEvent = typeof SimulatorInputEvent.Type;

export const SimulatorSendInput = Schema.Struct({
  threadId: ThreadId,
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
  event: SimulatorInputEvent,
});
export type SimulatorSendInput = typeof SimulatorSendInput.Type;

export const SimulatorSendInputResult = Schema.Struct({ accepted: Schema.Literal(true) });
export type SimulatorSendInputResult = typeof SimulatorSendInputResult.Type;

const SimulatorEventBase = {
  sequence: PositiveInt,
  createdAt: IsoDateTime,
  environmentId: Schema.optional(EnvironmentId),
};

export const SimulatorSessionEvent = Schema.Struct({
  ...SimulatorEventBase,
  type: Schema.Literal("session"),
  session: SimulatorSession,
});

export const SimulatorReleasedEvent = Schema.Struct({
  ...SimulatorEventBase,
  type: Schema.Literal("released"),
  threadId: ThreadId,
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
});

export const SimulatorEvent = Schema.Union([SimulatorSessionEvent, SimulatorReleasedEvent]);
export type SimulatorEvent = typeof SimulatorEvent.Type;

export class SimulatorUnsupportedPlatformError extends Schema.TaggedErrorClass<SimulatorUnsupportedPlatformError>()(
  "SimulatorUnsupportedPlatformError",
  { host: SimulatorHostPlatform },
) {
  override get message() {
    return `iOS Simulator control requires darwin/arm64; this host is ${this.host.os}/${this.host.arch}.`;
  }
}

export class SimulatorDeviceNotFoundError extends Schema.TaggedErrorClass<SimulatorDeviceNotFoundError>()(
  "SimulatorDeviceNotFoundError",
  { udid: SimulatorUdid },
) {
  override get message() {
    return `No available iOS Simulator exists with UDID ${this.udid}.`;
  }
}

export class SimulatorThreadLeaseConflictError extends Schema.TaggedErrorClass<SimulatorThreadLeaseConflictError>()(
  "SimulatorThreadLeaseConflictError",
  { threadId: ThreadId, requestedUdid: SimulatorUdid, existingUdid: SimulatorUdid },
) {
  override get message() {
    return `Thread ${this.threadId} already owns or requests simulator ${this.existingUdid}.`;
  }
}

export class SimulatorLeaseNotFoundError extends Schema.TaggedErrorClass<SimulatorLeaseNotFoundError>()(
  "SimulatorLeaseNotFoundError",
  { threadId: ThreadId, leaseId: SimulatorLeaseId },
) {
  override get message() {
    return `No simulator lease ${this.leaseId} exists for thread ${this.threadId}.`;
  }
}

export class SimulatorLeaseGenerationMismatchError extends Schema.TaggedErrorClass<SimulatorLeaseGenerationMismatchError>()(
  "SimulatorLeaseGenerationMismatchError",
  { leaseId: SimulatorLeaseId, expectedGeneration: PositiveInt, receivedGeneration: PositiveInt },
) {
  override get message() {
    return `Simulator lease ${this.leaseId} generation is stale.`;
  }
}

export class SimulatorRuntimeUnavailableError extends Schema.TaggedErrorClass<SimulatorRuntimeUnavailableError>()(
  "SimulatorRuntimeUnavailableError",
  {
    leaseId: Schema.optional(SimulatorLeaseId),
    operation: TrimmedNonEmptyString,
    cause: TrimmedNonEmptyString,
  },
) {
  override get message() {
    return `Simulator ${this.operation} is unavailable${this.leaseId ? ` for lease ${this.leaseId}` : ""}: ${this.cause}`;
  }
}

export const SimulatorError = Schema.Union([
  SimulatorUnsupportedPlatformError,
  SimulatorDeviceNotFoundError,
  SimulatorThreadLeaseConflictError,
  SimulatorLeaseNotFoundError,
  SimulatorLeaseGenerationMismatchError,
  SimulatorRuntimeUnavailableError,
]);
export type SimulatorError = typeof SimulatorError.Type;
