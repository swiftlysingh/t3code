/**
 * Lease-scoped, deliberately small adapter over XcodeBuildMCP.
 *
 * The Simulator manager owns device allocation and the serve-sim process. This
 * service owns the other process boundary: one private XcodeBuildMCP child for
 * one live simulator lease. It never accepts an arbitrary simulator identifier
 * or working directory from an automation operation.
 */
import { createHash } from "node:crypto";
import { type SimulatorSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  XcodeBuildMcpClient,
  XcodeBuildMcpError,
  type XcodeBuildMcpBuildRunInput,
  type XcodeBuildMcpClientOptions,
  type XcodeBuildMcpLaunchInput,
  type XcodeBuildMcpSwipeInput,
  type XcodeBuildMcpTapInput,
  type XcodeBuildMcpTypeTextInput,
  type XcodeBuildMcpWaitForUiInput,
} from "./XcodeBuildMcpClient.ts";

const MAX_PATH_LENGTH = 4_096;
const MAX_SCHEME_LENGTH = 256;
const MAX_BUNDLE_ID_LENGTH = 255;
const MAX_ELEMENT_REF_LENGTH = 512;
const MAX_SCREEN_HASH_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 16 * 1_024;
const MAX_ARGUMENT_COUNT = 64;
const MAX_ARGUMENT_LENGTH = 1_024;
const MAX_DELAY_MS = 60_000;
const MAX_WAIT_MS = 5 * 60_000;

const SimulatorAutomationLeaseErrorReason = Schema.Literals([
  "not-ready",
  "generation-mismatch",
  "udid-mismatch",
  "cwd-mismatch",
  "thread-mismatch",
]);
export type SimulatorAutomationLeaseErrorReason = typeof SimulatorAutomationLeaseErrorReason.Type;

/** The caller's session no longer names the private client it is trying to use. */
export class SimulatorAutomationLeaseError extends Schema.TaggedErrorClass<SimulatorAutomationLeaseError>()(
  "SimulatorAutomationLeaseError",
  {
    leaseId: Schema.String,
    reason: SimulatorAutomationLeaseErrorReason,
    expectedGeneration: Schema.optional(Schema.Number),
    receivedGeneration: Schema.Number,
    expectedUdid: Schema.optional(Schema.String),
    receivedUdid: Schema.String,
    expectedCwd: Schema.optional(Schema.String),
    receivedCwd: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-ready":
        return `Simulator lease ${this.leaseId} is not ready for automation.`;
      case "generation-mismatch":
        return `Simulator lease ${this.leaseId} generation is stale.`;
      case "udid-mismatch":
        return `Simulator lease ${this.leaseId} was requested for a different Simulator.`;
      case "cwd-mismatch":
        return `Simulator lease ${this.leaseId} was requested from a different worktree.`;
      case "thread-mismatch":
        return `Simulator lease ${this.leaseId} belongs to a different thread.`;
    }
  }
}

const SimulatorAutomationCwdErrorReason = Schema.Literals([
  "empty",
  "not-absolute",
  "not-resolved",
]);

/** Automation receives a resolved thread worktree, never a user-selected cwd. */
export class SimulatorAutomationCwdError extends Schema.TaggedErrorClass<SimulatorAutomationCwdError>()(
  "SimulatorAutomationCwdError",
  {
    cwd: Schema.String,
    reason: SimulatorAutomationCwdErrorReason,
  },
) {
  override get message(): string {
    return `Simulator automation requires an absolute, resolved thread worktree (${this.reason}).`;
  }
}

/** A bounded, validated input was rejected before it reached XcodeBuildMCP. */
export class SimulatorAutomationInputError extends Schema.TaggedErrorClass<SimulatorAutomationInputError>()(
  "SimulatorAutomationInputError",
  {
    operation: Schema.String,
    field: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid ${this.field} for simulator automation ${this.operation}: ${this.reason}.`;
  }
}

/** A curated XcodeBuildMCP operation failed without exposing its raw transport. */
export class SimulatorAutomationToolError extends Schema.TaggedErrorClass<SimulatorAutomationToolError>()(
  "SimulatorAutomationToolError",
  {
    operation: Schema.String,
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Simulator automation ${this.operation} failed (${this.code}): ${this.detail}`;
  }
}

export type SimulatorAutomationError =
  | SimulatorAutomationLeaseError
  | SimulatorAutomationCwdError
  | SimulatorAutomationInputError
  | SimulatorAutomationToolError;

export interface SimulatorAutomationLeaseInput {
  /** The latest session snapshot supplied by the lease manager. */
  readonly session: SimulatorSession;
  /** The exact resolved worktree for `session.threadId`. */
  readonly cwd: string;
}

export interface SimulatorAutomationBuildRunInput extends SimulatorAutomationLeaseInput {
  readonly projectPath?: string;
  readonly workspacePath?: string;
  readonly scheme: string;
  readonly configuration?: string;
  readonly derivedDataPath?: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly useLatestOS?: boolean;
  readonly preferXcodebuild?: boolean;
}

export interface SimulatorAutomationLaunchInput extends SimulatorAutomationLeaseInput {
  readonly bundleId: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SimulatorAutomationStopInput extends SimulatorAutomationLeaseInput {
  /** Omit to stop the last bundle launched/configured through this lease. */
  readonly bundleId?: string;
}

export interface SimulatorAutomationSnapshotUiInput extends SimulatorAutomationLeaseInput {
  readonly sinceScreenHash?: string;
}

export interface SimulatorAutomationScreenshotInput extends SimulatorAutomationLeaseInput {
  readonly returnFormat?: "path" | "base64";
}

export interface SimulatorAutomationTapInput extends SimulatorAutomationLeaseInput {
  readonly elementRef: string;
  readonly preDelay?: number;
  readonly postDelay?: number;
}

export interface SimulatorAutomationTypeTextInput extends SimulatorAutomationLeaseInput {
  readonly elementRef: string;
  readonly text: string;
  readonly replaceExisting?: boolean;
}

export interface SimulatorAutomationWaitForUiInput extends SimulatorAutomationLeaseInput {
  readonly predicate: XcodeBuildMcpWaitForUiInput["predicate"];
  readonly elementRef?: string;
  readonly identifier?: string;
  readonly label?: string;
  readonly role?: string;
  readonly value?: string;
  readonly text?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly settledDurationMs?: number;
}

export interface SimulatorAutomationSwipeInput extends SimulatorAutomationLeaseInput {
  readonly withinElementRef: string;
  readonly direction: XcodeBuildMcpSwipeInput["direction"];
  readonly duration?: number;
  readonly distance?: number;
  readonly preDelay?: number;
  readonly postDelay?: number;
}

/** The structural subset used by the service, intentionally easy to fake in tests. */
export interface SimulatorAutomationClient {
  readonly buildRun: (input: XcodeBuildMcpBuildRunInput) => Promise<unknown>;
  readonly launch: (input: XcodeBuildMcpLaunchInput) => Promise<unknown>;
  readonly stop: (bundleId: string) => Promise<unknown>;
  readonly terminate: (bundleId: string) => Promise<void>;
  readonly snapshotUi: (input?: { readonly sinceScreenHash?: string }) => Promise<unknown>;
  readonly screenshot: (returnFormat?: "path" | "base64") => Promise<unknown>;
  readonly tap: (input: XcodeBuildMcpTapInput) => Promise<unknown>;
  readonly typeText: (input: XcodeBuildMcpTypeTextInput) => Promise<unknown>;
  readonly waitForUi: (input: XcodeBuildMcpWaitForUiInput) => Promise<unknown>;
  readonly swipe: (input: XcodeBuildMcpSwipeInput) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export type SimulatorAutomationClientFactory = (
  options: XcodeBuildMcpClientOptions,
) => SimulatorAutomationClient;

export interface SimulatorAutomationOptions {
  /**
   * Optional T3-owned stable base for DerivedData. Each worktree gets a stable
   * hash directory beneath it. Without this, the worktree-local ignored `.t3`
   * directory is used.
   */
  readonly derivedDataBaseDir?: string;
  readonly createClient?: SimulatorAutomationClientFactory;
}

export class SimulatorAutomation extends Context.Service<
  SimulatorAutomation,
  {
    readonly buildRun: (
      input: SimulatorAutomationBuildRunInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly launch: (
      input: SimulatorAutomationLaunchInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly stop: (
      input: SimulatorAutomationStopInput,
    ) => Effect.Effect<unknown | undefined, SimulatorAutomationError>;
    readonly snapshotUi: (
      input: SimulatorAutomationSnapshotUiInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly screenshot: (
      input: SimulatorAutomationScreenshotInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly tap: (
      input: SimulatorAutomationTapInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly typeText: (
      input: SimulatorAutomationTypeTextInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly waitForUi: (
      input: SimulatorAutomationWaitForUiInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    readonly swipe: (
      input: SimulatorAutomationSwipeInput,
    ) => Effect.Effect<unknown, SimulatorAutomationError>;
    /** Close one client only when the caller still proves its exact lease identity. */
    readonly closeLease: (
      input: SimulatorAutomationLeaseInput,
    ) => Effect.Effect<
      void,
      SimulatorAutomationLeaseError | SimulatorAutomationCwdError | SimulatorAutomationToolError
    >;
    /** Close one exact Manager session without requiring a workspace path. */
    readonly closeSession: (
      session: SimulatorSession,
    ) => Effect.Effect<void, SimulatorAutomationLeaseError | SimulatorAutomationToolError>;
    readonly closeThread: (
      threadId: SimulatorSession["threadId"],
    ) => Effect.Effect<void, SimulatorAutomationToolError>;
    readonly closeAll: Effect.Effect<void>;
  }
>()("t3/simulator/Automation/SimulatorAutomation") {}

interface LeaseIdentity {
  readonly leaseId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly udid: string;
  readonly cwd: string;
}

interface NormalizedLeaseInput {
  readonly session: SimulatorSession;
  readonly identity: LeaseIdentity;
}

interface ClientRecord {
  readonly identity: LeaseIdentity;
  readonly client: SimulatorAutomationClient;
  lastBundleId: string | undefined;
  activeOperations: number;
  closing: boolean;
  idlePromise: Promise<void>;
  resolveIdle: (() => void) | undefined;
  closePromise: Promise<SimulatorAutomationToolError | undefined> | undefined;
}

interface AutomationState {
  readonly records: ReadonlyMap<string, ClientRecord>;
  readonly closedLeases: ReadonlyMap<string, LeaseIdentity>;
  readonly closedThreads: ReadonlySet<string>;
}

const initialState: AutomationState = {
  records: new Map(),
  closedLeases: new Map(),
  closedThreads: new Set(),
};

const noControlCharacters = (value: string): boolean => !/[\u0000-\u001f\u007f]/u.test(value);

const sanitiseDetail = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 512) || "unexpected failure";

const isWithin = (path: Path.Path, root: string, candidate: string): boolean => {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
};

const inputError = (
  operation: string,
  field: string,
  reason: string,
): SimulatorAutomationInputError => new SimulatorAutomationInputError({ operation, field, reason });

const toolError = (operation: string, cause: unknown): SimulatorAutomationToolError => {
  if (cause instanceof XcodeBuildMcpError) {
    return new SimulatorAutomationToolError({
      operation,
      code: cause.code,
      detail: sanitiseDetail(cause.message),
    });
  }
  return new SimulatorAutomationToolError({
    operation,
    code: "unexpected",
    detail: sanitiseDetail(cause instanceof Error ? cause.message : String(cause)),
  });
};

const optionalText = (
  operation: string,
  field: string,
  value: unknown,
  maxLength: number,
  options: { readonly trim?: boolean; readonly rejectControls?: boolean } = {},
): string | undefined | SimulatorAutomationInputError => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return inputError(operation, field, "must be a string");
  const normalized = options.trim === false ? value : value.trim();
  if (normalized.length === 0) return inputError(operation, field, "must not be empty");
  if (normalized.length > maxLength)
    return inputError(operation, field, `must be at most ${maxLength} characters`);
  if (options.rejectControls !== false && !noControlCharacters(normalized))
    return inputError(operation, field, "contains control characters");
  return normalized;
};

const requiredText = (
  operation: string,
  field: string,
  value: unknown,
  maxLength: number,
  options: { readonly trim?: boolean; readonly rejectControls?: boolean } = {},
): string | SimulatorAutomationInputError => {
  const result = optionalText(operation, field, value, maxLength, options);
  return result === undefined ? inputError(operation, field, "is required") : result;
};

const isInputError = Schema.is(SimulatorAutomationInputError);
const isCwdError = Schema.is(SimulatorAutomationCwdError);

const normaliseThreadCwd = (
  path: Path.Path,
  cwd: unknown,
): string | SimulatorAutomationCwdError => {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return new SimulatorAutomationCwdError({
      cwd: typeof cwd === "string" ? cwd : "",
      reason: "empty",
    });
  }
  if (!path.isAbsolute(cwd)) {
    return new SimulatorAutomationCwdError({ cwd, reason: "not-absolute" });
  }
  if (path.resolve(cwd) !== cwd || path.normalize(cwd) !== cwd) {
    return new SimulatorAutomationCwdError({ cwd, reason: "not-resolved" });
  }
  return cwd;
};

const makeLeaseError = (
  input: SimulatorAutomationLeaseInput,
  reason: SimulatorAutomationLeaseErrorReason,
  expected: Partial<LeaseIdentity> = {},
): SimulatorAutomationLeaseError =>
  new SimulatorAutomationLeaseError({
    leaseId: String(input.session.leaseId),
    reason,
    expectedGeneration: expected.generation,
    receivedGeneration: input.session.generation,
    expectedUdid: expected.udid,
    receivedUdid: String(input.session.udid),
    expectedCwd: expected.cwd,
    receivedCwd: input.cwd,
  });

const normaliseLease = (
  path: Path.Path,
  input: SimulatorAutomationLeaseInput,
  requireReady: boolean,
): Effect.Effect<
  NormalizedLeaseInput,
  SimulatorAutomationLeaseError | SimulatorAutomationCwdError
> =>
  Effect.sync(() => {
    const cwd = normaliseThreadCwd(path, input.cwd);
    if (isCwdError(cwd)) return { error: cwd } as const;
    if (requireReady && input.session.state !== "ready") {
      return { error: makeLeaseError(input, "not-ready") } as const;
    }
    return {
      value: {
        session: input.session,
        identity: {
          leaseId: String(input.session.leaseId),
          threadId: String(input.session.threadId),
          generation: input.session.generation,
          udid: String(input.session.udid),
          cwd,
        },
      },
    } as const;
  }).pipe(
    Effect.flatMap((result) =>
      "error" in result ? Effect.fail(result.error) : Effect.succeed(result.value),
    ),
  );

const compareIdentity = (
  expected: LeaseIdentity,
  input: NormalizedLeaseInput,
): SimulatorAutomationLeaseError | undefined => {
  if (expected.generation !== input.identity.generation) {
    return makeLeaseError(
      { session: input.session, cwd: input.identity.cwd },
      "generation-mismatch",
      expected,
    );
  }
  if (expected.udid !== input.identity.udid) {
    return makeLeaseError(
      { session: input.session, cwd: input.identity.cwd },
      "udid-mismatch",
      expected,
    );
  }
  if (expected.cwd !== input.identity.cwd) {
    return makeLeaseError(
      { session: input.session, cwd: input.identity.cwd },
      "cwd-mismatch",
      expected,
    );
  }
  if (expected.threadId !== input.identity.threadId) {
    return makeLeaseError(
      { session: input.session, cwd: input.identity.cwd },
      "thread-mismatch",
      expected,
    );
  }
  return undefined;
};

const compareSessionIdentity = (
  expected: LeaseIdentity,
  session: SimulatorSession,
): SimulatorAutomationLeaseError | undefined => {
  const input = { session, cwd: expected.cwd };
  if (expected.generation !== session.generation) {
    return makeLeaseError(input, "generation-mismatch", expected);
  }
  if (expected.udid !== String(session.udid)) {
    return makeLeaseError(input, "udid-mismatch", expected);
  }
  if (expected.threadId !== String(session.threadId)) {
    return makeLeaseError(input, "thread-mismatch", expected);
  }
  return undefined;
};

const realpathWithNearestExistingParent = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  operation: string,
  field: string,
  target: string,
): Effect.Effect<string, SimulatorAutomationInputError> =>
  Effect.gen(function* () {
    const missingSegments: string[] = [];
    let probe = target;
    while (true) {
      const exists = yield* fileSystem
        .exists(probe)
        .pipe(Effect.mapError(() => inputError(operation, field, "could not inspect the path")));
      if (exists) {
        const canonicalProbe = yield* fileSystem
          .realPath(probe)
          .pipe(Effect.mapError(() => inputError(operation, field, "could not resolve the path")));
        return missingSegments.reduceRight(
          (current, segment) => path.join(current, segment),
          canonicalProbe,
        );
      }

      const parent = path.dirname(probe);
      if (parent === probe) {
        return yield* Effect.fail(inputError(operation, field, "could not resolve the path"));
      }
      missingSegments.push(path.basename(probe));
      probe = parent;
    }
  });

const resolvePathInsideCwd = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  operation: string,
  field: "projectPath" | "workspacePath" | "derivedDataPath",
  cwd: string,
  raw: unknown,
): Effect.Effect<string, SimulatorAutomationInputError> =>
  Effect.gen(function* () {
    const value = requiredText(operation, field, raw, MAX_PATH_LENGTH);
    if (isInputError(value)) return yield* Effect.fail(value);
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
    if (!isWithin(path, cwd, resolved)) {
      return yield* Effect.fail(
        inputError(operation, field, "must remain inside the thread worktree"),
      );
    }
    if (field === "projectPath" && path.extname(resolved) !== ".xcodeproj") {
      return yield* Effect.fail(inputError(operation, field, "must name an .xcodeproj"));
    }
    if (field === "workspacePath" && path.extname(resolved) !== ".xcworkspace") {
      return yield* Effect.fail(inputError(operation, field, "must name an .xcworkspace"));
    }

    const [canonicalCwd, canonicalCandidate] = yield* Effect.all([
      realpathWithNearestExistingParent(fileSystem, path, operation, field, cwd),
      realpathWithNearestExistingParent(fileSystem, path, operation, field, resolved),
    ]);
    if (!isWithin(path, canonicalCwd, canonicalCandidate)) {
      return yield* Effect.fail(
        inputError(operation, field, "resolves outside the thread worktree"),
      );
    }
    return resolved;
  });

const normalizeProjectTarget = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  operation: string,
  cwd: string,
  input: { readonly projectPath?: string; readonly workspacePath?: string },
  required: boolean,
): Effect.Effect<
  Pick<XcodeBuildMcpBuildRunInput, "projectPath" | "workspacePath">,
  SimulatorAutomationInputError
> =>
  Effect.gen(function* () {
    const hasProject = input.projectPath !== undefined;
    const hasWorkspace = input.workspacePath !== undefined;
    if (hasProject && hasWorkspace) {
      return yield* Effect.fail(
        inputError(operation, "projectPath/workspacePath", "provide exactly one target"),
      );
    }
    if (!hasProject && !hasWorkspace) {
      if (required) {
        return yield* Effect.fail(
          inputError(operation, "projectPath/workspacePath", "provide exactly one target"),
        );
      }
      return {};
    }
    if (hasProject) {
      return {
        projectPath: yield* resolvePathInsideCwd(
          fileSystem,
          path,
          operation,
          "projectPath",
          cwd,
          input.projectPath,
        ),
      };
    }
    return {
      workspacePath: yield* resolvePathInsideCwd(
        fileSystem,
        path,
        operation,
        "workspacePath",
        cwd,
        input.workspacePath,
      ),
    };
  });

const normaliseDelay = (
  operation: string,
  field: string,
  value: unknown,
  maximum = MAX_DELAY_MS,
): number | undefined | SimulatorAutomationInputError => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    return inputError(operation, field, `must be a finite number between 0 and ${maximum}`);
  }
  return value;
};

const normaliseArguments = (
  operation: string,
  field: string,
  value: unknown,
): ReadonlyArray<string> | undefined | SimulatorAutomationInputError => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ARGUMENT_COUNT) {
    return inputError(operation, field, `must contain at most ${MAX_ARGUMENT_COUNT} strings`);
  }
  const arguments_: string[] = [];
  for (const argument of value) {
    const normalised = requiredText(operation, field, argument, MAX_ARGUMENT_LENGTH);
    if (isInputError(normalised)) return normalised;
    arguments_.push(normalised);
  }
  return arguments_;
};

const normaliseEnv = (
  operation: string,
  value: unknown,
): Readonly<Record<string, string>> | undefined | SimulatorAutomationInputError => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return inputError(operation, "env", "must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ARGUMENT_COUNT) {
    return inputError(operation, "env", `must contain at most ${MAX_ARGUMENT_COUNT} entries`);
  }
  const output: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const normalisedKey = requiredText(operation, "env key", key, MAX_ARGUMENT_LENGTH);
    const normalisedValue = requiredText(operation, "env value", rawValue, MAX_ARGUMENT_LENGTH, {
      trim: false,
      rejectControls: false,
    });
    if (isInputError(normalisedKey)) return normalisedKey;
    if (isInputError(normalisedValue)) return normalisedValue;
    if (normalisedValue.includes("\u0000")) {
      return inputError(operation, "env value", "contains a null byte");
    }
    output[normalisedKey] = normalisedValue;
  }
  return output;
};

const extractBundleId = (result: unknown): string | undefined => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const direct = "bundleId" in result ? result.bundleId : undefined;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const artifacts = "artifacts" in result ? result.artifacts : undefined;
  if (typeof artifacts !== "object" || artifacts === null || Array.isArray(artifacts)) {
    return undefined;
  }
  const bundleId = "bundleId" in artifacts ? artifacts.bundleId : undefined;
  return typeof bundleId === "string" && bundleId.length > 0 ? bundleId : undefined;
};

const derivedDataPathFor = (
  path: Path.Path,
  cwd: string,
  configuredBaseDir: string | undefined,
): string => {
  if (configuredBaseDir === undefined) {
    return path.join(cwd, ".t3", "simulator", "DerivedData");
  }
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return path.join(configuredBaseDir, `thread-${key}`, "DerivedData");
};

const deriveBaseDir = (path: Path.Path, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value) || path.resolve(value) !== value || path.normalize(value) !== value) {
    throw new Error("Simulator automation derivedDataBaseDir must be an absolute, resolved path.");
  }
  return value;
};

const defaultClientFactory: SimulatorAutomationClientFactory = (options) =>
  new XcodeBuildMcpClient(options);

export const makeWithOptions = (options: SimulatorAutomationOptions = {}) =>
  Effect.gen(function* SimulatorAutomationMake() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configuredBaseDir = deriveBaseDir(path, options.derivedDataBaseDir);
    const clientFactory = options.createClient ?? defaultClientFactory;
    const state = yield* SynchronizedRef.make<AutomationState>(initialState);

    const existingRecord = (
      lease: NormalizedLeaseInput,
    ): Effect.Effect<ClientRecord | undefined, SimulatorAutomationLeaseError> =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) => {
          const record = current.records.get(lease.identity.leaseId);
          if (record === undefined) return Effect.succeed(undefined);
          const mismatch = compareIdentity(record.identity, lease);
          return mismatch === undefined ? Effect.succeed(record) : Effect.fail(mismatch);
        }),
      );

    const ensureRecord = (
      lease: NormalizedLeaseInput,
    ): Effect.Effect<ClientRecord, SimulatorAutomationLeaseError | SimulatorAutomationToolError> =>
      SynchronizedRef.modifyEffect(
        state,
        (
          current,
        ): Effect.Effect<
          readonly [ClientRecord, AutomationState],
          SimulatorAutomationLeaseError | SimulatorAutomationToolError
        > => {
          const record = current.records.get(lease.identity.leaseId);
          if (record !== undefined) {
            const mismatch = compareIdentity(record.identity, lease);
            if (mismatch !== undefined) return Effect.fail(mismatch);
            if (record.closing) {
              return Effect.fail(
                new SimulatorAutomationToolError({
                  operation: "createClient",
                  code: "closed",
                  detail: "Simulator lease is closing.",
                }),
              );
            }
            return Effect.succeed([record, current] as const);
          }
          if (
            current.closedLeases.has(lease.identity.leaseId) ||
            current.closedThreads.has(lease.identity.threadId)
          ) {
            return Effect.fail(
              new SimulatorAutomationToolError({
                operation: "createClient",
                code: "closed",
                detail: "Simulator lease has already been closed.",
              }),
            );
          }
          return Effect.try({
            try: () =>
              clientFactory({
                cwd: lease.identity.cwd,
                simulatorId: lease.identity.udid,
              }),
            catch: (cause) => toolError("createClient", cause),
          }).pipe(
            Effect.map((client) => {
              const created: ClientRecord = {
                identity: lease.identity,
                client,
                lastBundleId: undefined,
                activeOperations: 0,
                closing: false,
                idlePromise: Promise.resolve(),
                resolveIdle: undefined,
                closePromise: undefined,
              };
              return [
                created,
                {
                  records: new Map(current.records).set(lease.identity.leaseId, created),
                  closedLeases: current.closedLeases,
                  closedThreads: current.closedThreads,
                },
              ] as const;
            }),
          );
        },
      );

    const beginOperation = (
      operation: string,
      record: ClientRecord,
    ): Effect.Effect<void, SimulatorAutomationToolError> =>
      SynchronizedRef.modifyEffect(
        state,
        (
          current,
        ): Effect.Effect<readonly [void, AutomationState], SimulatorAutomationToolError> => {
          if (current.records.get(record.identity.leaseId) !== record || record.closing) {
            return Effect.fail(
              new SimulatorAutomationToolError({
                operation,
                code: "closed",
                detail: "Simulator lease is closing.",
              }),
            );
          }
          if (record.activeOperations === 0) {
            let resolveIdle: (() => void) | undefined;
            const idlePromise = new Promise<void>((resolve) => {
              resolveIdle = resolve;
            });
            record.idlePromise = idlePromise;
            record.resolveIdle = resolveIdle;
          }
          record.activeOperations += 1;
          return Effect.succeed([undefined, current] as const);
        },
      );

    const endOperation = (record: ClientRecord): Effect.Effect<void> =>
      SynchronizedRef.update(state, (current) => {
        if (current.records.get(record.identity.leaseId) !== record) return current;
        record.activeOperations = Math.max(0, record.activeOperations - 1);
        if (record.activeOperations === 0) {
          const resolveIdle = record.resolveIdle;
          record.resolveIdle = undefined;
          record.idlePromise = Promise.resolve();
          resolveIdle?.();
        }
        return current;
      });

    const invoke = <A>(
      operation: string,
      client: ClientRecord,
      run: () => Promise<A>,
      onSuccess?: (result: A) => void,
    ): Effect.Effect<A, SimulatorAutomationToolError> =>
      Effect.gen(function* () {
        yield* beginOperation(operation, client);
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await run();
            onSuccess?.(result);
            return result;
          },
          catch: (cause) => toolError(operation, cause),
        }).pipe(Effect.ensuring(endOperation(client)));
      });

    const removeMatchingRecord = (
      lease: NormalizedLeaseInput,
    ): Effect.Effect<ClientRecord | undefined, SimulatorAutomationLeaseError> =>
      SynchronizedRef.modifyEffect(
        state,
        (
          current,
        ): Effect.Effect<
          readonly [ClientRecord | undefined, AutomationState],
          SimulatorAutomationLeaseError
        > => {
          const record = current.records.get(lease.identity.leaseId);
          if (record === undefined) {
            const closed = current.closedLeases.get(lease.identity.leaseId);
            if (closed !== undefined) {
              const mismatch = compareIdentity(closed, lease);
              if (mismatch !== undefined) return Effect.fail(mismatch);
              return Effect.succeed([undefined, current] as const);
            }
            const closedLeases = new Map(current.closedLeases);
            closedLeases.set(lease.identity.leaseId, lease.identity);
            return Effect.succeed([
              undefined,
              { records: current.records, closedLeases, closedThreads: current.closedThreads },
            ] as const);
          }
          const mismatch = compareIdentity(record.identity, lease);
          if (mismatch !== undefined) return Effect.fail(mismatch);
          record.closing = true;
          return Effect.succeed([record, current] as const);
        },
      );

    const removeMatchingSession = (
      session: SimulatorSession,
    ): Effect.Effect<ClientRecord | undefined, SimulatorAutomationLeaseError> =>
      SynchronizedRef.modifyEffect(
        state,
        (
          current,
        ): Effect.Effect<
          readonly [ClientRecord | undefined, AutomationState],
          SimulatorAutomationLeaseError
        > => {
          const leaseId = String(session.leaseId);
          const record = current.records.get(leaseId);
          if (record !== undefined) {
            const mismatch = compareSessionIdentity(record.identity, session);
            if (mismatch !== undefined) return Effect.fail(mismatch);
            record.closing = true;
            const closedLeases = new Map(current.closedLeases);
            closedLeases.set(leaseId, record.identity);
            return Effect.succeed([
              record,
              { records: current.records, closedLeases, closedThreads: current.closedThreads },
            ] as const);
          }

          const closed = current.closedLeases.get(leaseId);
          if (closed !== undefined) {
            const mismatch = compareSessionIdentity(closed, session);
            if (mismatch !== undefined) return Effect.fail(mismatch);
            return Effect.succeed([undefined, current] as const);
          }

          // No client exists yet, but this exact lease must still be fenced
          // against work that validated the session before this close.
          const closedLeases = new Map(current.closedLeases);
          closedLeases.set(leaseId, {
            leaseId,
            threadId: String(session.threadId),
            generation: session.generation,
            udid: String(session.udid),
            cwd: "",
          });
          return Effect.succeed([
            undefined,
            { records: current.records, closedLeases, closedThreads: current.closedThreads },
          ] as const);
        },
      );

    const closeRecord = (record: ClientRecord): Effect.Effect<void, SimulatorAutomationToolError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (record.closePromise === undefined) {
            record.closePromise = (async () => {
              let cleanupFailure: unknown;
              await record.idlePromise;
              if (record.lastBundleId !== undefined) {
                const bundleId = record.lastBundleId;
                try {
                  await record.client.stop(bundleId);
                  record.lastBundleId = undefined;
                } catch {
                  try {
                    await record.client.terminate(bundleId);
                    record.lastBundleId = undefined;
                  } catch (cause) {
                    cleanupFailure = cause;
                  }
                }
              }
              try {
                await record.client.close();
              } catch (cause) {
                cleanupFailure = cause;
              }
              if (cleanupFailure !== undefined) {
                return toolError("close", cleanupFailure);
              }
              return undefined;
            })();
          }
          const cleanupFailure = yield* Effect.promise(() => record.closePromise!);
          if (cleanupFailure !== undefined) {
            record.closePromise = undefined;
            return yield* Effect.fail(cleanupFailure);
          }
          yield* SynchronizedRef.update(state, (current) => {
            if (current.records.get(record.identity.leaseId) !== record) return current;
            const records = new Map(current.records);
            records.delete(record.identity.leaseId);
            const closedLeases = new Map(current.closedLeases);
            closedLeases.set(record.identity.leaseId, record.identity);
            return { records, closedLeases, closedThreads: current.closedThreads };
          });
        }),
      );

    const closeRecords = (
      records: ReadonlyArray<ClientRecord>,
    ): Effect.Effect<void, SimulatorAutomationToolError> =>
      Effect.forEach(records, closeRecord, { discard: true, concurrency: "unbounded" });

    const resolveDerivedDataPath = (
      operation: string,
      cwd: string,
      input: string | undefined,
    ): Effect.Effect<string, SimulatorAutomationInputError> =>
      input === undefined && configuredBaseDir !== undefined
        ? Effect.succeed(derivedDataPathFor(path, cwd, configuredBaseDir))
        : resolvePathInsideCwd(
            fileSystem,
            path,
            operation,
            "derivedDataPath",
            cwd,
            input ?? derivedDataPathFor(path, cwd, configuredBaseDir),
          );

    const buildRun: SimulatorAutomation["Service"]["buildRun"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const target = yield* normalizeProjectTarget(
          fileSystem,
          path,
          "buildRun",
          lease.identity.cwd,
          input,
          true,
        );
        const scheme = requiredText("buildRun", "scheme", input.scheme, MAX_SCHEME_LENGTH);
        const configuration = optionalText(
          "buildRun",
          "configuration",
          input.configuration,
          MAX_SCHEME_LENGTH,
        );
        const launchArgs = normaliseArguments("buildRun", "launchArgs", input.launchArgs);
        if (isInputError(scheme)) return yield* Effect.fail(scheme);
        if (isInputError(configuration)) return yield* Effect.fail(configuration);
        if (isInputError(launchArgs)) return yield* Effect.fail(launchArgs);
        const derivedDataPath = yield* resolveDerivedDataPath(
          "buildRun",
          lease.identity.cwd,
          input.derivedDataPath,
        );
        const record = yield* ensureRecord(lease);
        const result = yield* invoke(
          "buildRun",
          record,
          () =>
            record.client.buildRun({
              ...target,
              scheme,
              derivedDataPath,
              ...(configuration === undefined ? {} : { configuration }),
              ...(launchArgs === undefined ? {} : { launchArgs }),
              ...(input.useLatestOS === undefined ? {} : { useLatestOS: input.useLatestOS }),
              ...(input.preferXcodebuild === undefined
                ? {}
                : { preferXcodebuild: input.preferXcodebuild }),
            }),
          (built) => {
            record.lastBundleId = extractBundleId(built) ?? record.lastBundleId;
          },
        );
        return result;
      });

    const launch: SimulatorAutomation["Service"]["launch"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const bundleId = requiredText("launch", "bundleId", input.bundleId, MAX_BUNDLE_ID_LENGTH);
        const launchArgs = normaliseArguments("launch", "launchArgs", input.launchArgs);
        const env = normaliseEnv("launch", input.env);
        if (isInputError(bundleId)) return yield* Effect.fail(bundleId);
        if (isInputError(launchArgs)) return yield* Effect.fail(launchArgs);
        if (isInputError(env)) return yield* Effect.fail(env);
        const record = yield* ensureRecord(lease);
        const result = yield* invoke(
          "launch",
          record,
          () =>
            record.client.launch({
              bundleId,
              ...(launchArgs === undefined ? {} : { launchArgs }),
              ...(env === undefined ? {} : { env }),
            }),
          () => {
            record.lastBundleId = bundleId;
          },
        );
        return result;
      });

    const stop: SimulatorAutomation["Service"]["stop"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const requestedBundleId = optionalText(
          "stop",
          "bundleId",
          input.bundleId,
          MAX_BUNDLE_ID_LENGTH,
        );
        if (isInputError(requestedBundleId)) return yield* Effect.fail(requestedBundleId);
        const existing = yield* existingRecord(lease);
        const bundleId = requestedBundleId ?? existing?.lastBundleId;
        if (bundleId === undefined) {
          const closed = yield* SynchronizedRef.get(state).pipe(
            Effect.map(
              (current) =>
                current.records.get(lease.identity.leaseId)?.closing === true ||
                current.closedLeases.has(lease.identity.leaseId) ||
                current.closedThreads.has(lease.identity.threadId),
            ),
          );
          if (closed) {
            return yield* Effect.fail(
              new SimulatorAutomationToolError({
                operation: "stop",
                code: "closed",
                detail: "Simulator lease is closing.",
              }),
            );
          }
          return undefined;
        }
        const record = existing ?? (yield* ensureRecord(lease));
        const result = yield* invoke(
          "stop",
          record,
          () => record.client.stop(bundleId),
          () => {
            if (record.lastBundleId === bundleId) record.lastBundleId = undefined;
          },
        );
        return result;
      });

    const snapshotUi: SimulatorAutomation["Service"]["snapshotUi"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const sinceScreenHash = optionalText(
          "snapshotUi",
          "sinceScreenHash",
          input.sinceScreenHash,
          MAX_SCREEN_HASH_LENGTH,
        );
        if (isInputError(sinceScreenHash)) return yield* Effect.fail(sinceScreenHash);
        const record = yield* ensureRecord(lease);
        return yield* invoke("snapshotUi", record, () =>
          record.client.snapshotUi(sinceScreenHash === undefined ? {} : { sinceScreenHash }),
        );
      });

    const screenshot: SimulatorAutomation["Service"]["screenshot"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const returnFormat = input.returnFormat ?? "path";
        if (returnFormat !== "path" && returnFormat !== "base64") {
          return yield* Effect.fail(
            inputError("screenshot", "returnFormat", "must be path or base64"),
          );
        }
        const record = yield* ensureRecord(lease);
        return yield* invoke("screenshot", record, () => record.client.screenshot(returnFormat));
      });

    const tap: SimulatorAutomation["Service"]["tap"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const elementRef = requiredText(
          "tap",
          "elementRef",
          input.elementRef,
          MAX_ELEMENT_REF_LENGTH,
        );
        const preDelay = normaliseDelay("tap", "preDelay", input.preDelay);
        const postDelay = normaliseDelay("tap", "postDelay", input.postDelay);
        if (isInputError(elementRef)) return yield* Effect.fail(elementRef);
        if (isInputError(preDelay)) return yield* Effect.fail(preDelay);
        if (isInputError(postDelay)) return yield* Effect.fail(postDelay);
        const record = yield* ensureRecord(lease);
        return yield* invoke("tap", record, () =>
          record.client.tap({
            elementRef,
            ...(preDelay === undefined ? {} : { preDelay }),
            ...(postDelay === undefined ? {} : { postDelay }),
          }),
        );
      });

    const typeText: SimulatorAutomation["Service"]["typeText"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const elementRef = requiredText(
          "typeText",
          "elementRef",
          input.elementRef,
          MAX_ELEMENT_REF_LENGTH,
        );
        const text = optionalText("typeText", "text", input.text, MAX_TEXT_LENGTH, {
          trim: false,
          rejectControls: false,
        });
        if (isInputError(elementRef)) return yield* Effect.fail(elementRef);
        if (isInputError(text) || text === undefined) {
          return yield* Effect.fail(text ?? inputError("typeText", "text", "is required"));
        }
        if (text.includes("\u0000")) {
          return yield* Effect.fail(inputError("typeText", "text", "contains a null byte"));
        }
        const record = yield* ensureRecord(lease);
        return yield* invoke("typeText", record, () =>
          record.client.typeText({
            elementRef,
            text,
            ...(input.replaceExisting === undefined
              ? {}
              : { replaceExisting: input.replaceExisting }),
          }),
        );
      });

    const waitForUi: SimulatorAutomation["Service"]["waitForUi"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const predicate = input.predicate;
        const allowedPredicates: ReadonlyArray<XcodeBuildMcpWaitForUiInput["predicate"]> = [
          "exists",
          "gone",
          "enabled",
          "focused",
          "textContains",
          "settled",
        ];
        if (!allowedPredicates.includes(predicate)) {
          return yield* Effect.fail(inputError("waitForUi", "predicate", "is not supported"));
        }
        const elementRef = optionalText(
          "waitForUi",
          "elementRef",
          input.elementRef,
          MAX_ELEMENT_REF_LENGTH,
        );
        const identifier = optionalText(
          "waitForUi",
          "identifier",
          input.identifier,
          MAX_ELEMENT_REF_LENGTH,
        );
        const label = optionalText("waitForUi", "label", input.label, MAX_ELEMENT_REF_LENGTH);
        const role = optionalText("waitForUi", "role", input.role, MAX_ELEMENT_REF_LENGTH);
        const value = optionalText("waitForUi", "value", input.value, MAX_TEXT_LENGTH);
        const text = optionalText("waitForUi", "text", input.text, MAX_TEXT_LENGTH);
        const timeoutMs = normaliseDelay("waitForUi", "timeoutMs", input.timeoutMs, MAX_WAIT_MS);
        const pollIntervalMs = normaliseDelay(
          "waitForUi",
          "pollIntervalMs",
          input.pollIntervalMs,
          MAX_WAIT_MS,
        );
        const settledDurationMs = normaliseDelay(
          "waitForUi",
          "settledDurationMs",
          input.settledDurationMs,
          MAX_WAIT_MS,
        );
        if (isInputError(elementRef)) return yield* Effect.fail(elementRef);
        if (isInputError(identifier)) return yield* Effect.fail(identifier);
        if (isInputError(label)) return yield* Effect.fail(label);
        if (isInputError(role)) return yield* Effect.fail(role);
        if (isInputError(value)) return yield* Effect.fail(value);
        if (isInputError(text)) return yield* Effect.fail(text);
        if (isInputError(timeoutMs)) return yield* Effect.fail(timeoutMs);
        if (isInputError(pollIntervalMs)) return yield* Effect.fail(pollIntervalMs);
        if (isInputError(settledDurationMs)) return yield* Effect.fail(settledDurationMs);
        const record = yield* ensureRecord(lease);
        return yield* invoke("waitForUi", record, () =>
          record.client.waitForUi({
            predicate,
            ...(elementRef === undefined ? {} : { elementRef }),
            ...(identifier === undefined ? {} : { identifier }),
            ...(label === undefined ? {} : { label }),
            ...(role === undefined ? {} : { role }),
            ...(value === undefined ? {} : { value }),
            ...(text === undefined ? {} : { text }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
            ...(settledDurationMs === undefined ? {} : { settledDurationMs }),
          }),
        );
      });

    const swipe: SimulatorAutomation["Service"]["swipe"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, true);
        const withinElementRef = requiredText(
          "swipe",
          "withinElementRef",
          input.withinElementRef,
          MAX_ELEMENT_REF_LENGTH,
        );
        const directions: ReadonlyArray<XcodeBuildMcpSwipeInput["direction"]> = [
          "up",
          "down",
          "left",
          "right",
        ];
        if (!directions.includes(input.direction)) {
          return yield* Effect.fail(inputError("swipe", "direction", "is not supported"));
        }
        const duration = normaliseDelay("swipe", "duration", input.duration);
        const preDelay = normaliseDelay("swipe", "preDelay", input.preDelay);
        const postDelay = normaliseDelay("swipe", "postDelay", input.postDelay);
        if (isInputError(withinElementRef)) return yield* Effect.fail(withinElementRef);
        if (isInputError(duration)) return yield* Effect.fail(duration);
        if (isInputError(preDelay)) return yield* Effect.fail(preDelay);
        if (isInputError(postDelay)) return yield* Effect.fail(postDelay);
        if (
          input.distance !== undefined &&
          (typeof input.distance !== "number" ||
            !Number.isFinite(input.distance) ||
            input.distance <= 0 ||
            input.distance > 1)
        ) {
          return yield* Effect.fail(
            inputError("swipe", "distance", "must be a finite number greater than 0 and at most 1"),
          );
        }
        const record = yield* ensureRecord(lease);
        return yield* invoke("swipe", record, () =>
          record.client.swipe({
            withinElementRef,
            direction: input.direction,
            ...(duration === undefined ? {} : { duration }),
            ...(input.distance === undefined ? {} : { distance: input.distance }),
            ...(preDelay === undefined ? {} : { preDelay }),
            ...(postDelay === undefined ? {} : { postDelay }),
          }),
        );
      });

    const closeLease: SimulatorAutomation["Service"]["closeLease"] = (input) =>
      Effect.gen(function* () {
        const lease = yield* normaliseLease(path, input, false);
        const record = yield* removeMatchingRecord(lease);
        if (record !== undefined) yield* closeRecord(record);
      });

    const closeSession: SimulatorAutomation["Service"]["closeSession"] = (session) =>
      Effect.gen(function* () {
        const record = yield* removeMatchingSession(session);
        if (record !== undefined) yield* closeRecord(record);
      });

    const closeThread: SimulatorAutomation["Service"]["closeThread"] = (threadId) =>
      SynchronizedRef.modify(state, (current) => {
        const records: ClientRecord[] = [];
        for (const record of current.records.values()) {
          if (record.identity.threadId === threadId) {
            record.closing = true;
            records.push(record);
          }
        }
        const closedThreads = new Set(current.closedThreads).add(threadId);
        return [records, { ...current, closedThreads }] as const;
      }).pipe(Effect.flatMap(closeRecords));

    const closeAll: SimulatorAutomation["Service"]["closeAll"] = SynchronizedRef.modify(
      state,
      (current) => {
        const records = Array.from(current.records.values());
        for (const record of records) record.closing = true;
        return [records, current] as const;
      },
    ).pipe(Effect.flatMap(closeRecords), Effect.ignore);

    const service = SimulatorAutomation.of({
      buildRun,
      launch,
      stop,
      snapshotUi,
      screenshot,
      tap,
      typeText,
      waitForUi,
      swipe,
      closeLease,
      closeSession,
      closeThread,
      closeAll,
    });
    yield* Effect.addFinalizer(() => closeAll);
    return service;
  });

export const layerWithOptions = (options: SimulatorAutomationOptions = {}) =>
  Layer.effect(SimulatorAutomation, makeWithOptions(options));

export const layer = layerWithOptions();
