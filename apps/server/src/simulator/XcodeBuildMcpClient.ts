// @effect-diagnostics nodeBuiltinImport:off
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { Stream } from "node:stream";
import { promisify } from "node:util";

const XCODE_BUILD_MCP_VERSION = "2.6.2";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_STDERR_TAIL_BYTES = 32 * 1024;

const XCODE_BUILD_MCP_WORKFLOWS = "simulator,ui-automation,debugging";
const XCODE_BUILD_MCP_SCHEMA_VERSION = "2";
const XCODE_BUILD_MCP_BUILD_RESULT_SCHEMA = "xcodebuildmcp.output.build-result";
const XCODE_BUILD_MCP_APP_PATH_SCHEMA = "xcodebuildmcp.output.app-path";
const XCODE_BUILD_MCP_BUNDLE_ID_SCHEMA = "xcodebuildmcp.output.bundle-id";
const XCODE_BUILD_MCP_INSTALL_RESULT_SCHEMA = "xcodebuildmcp.output.install-result";
const XCODE_BUILD_MCP_LAUNCH_RESULT_SCHEMA = "xcodebuildmcp.output.launch-result";
const DEFAULT_SIMULATOR_PLATFORM = "iOS Simulator";
const SIMULATOR_UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const DEFAULT_TERMINATE_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

const resolveXcodeBuildMcpCli = (): string => {
  const require = createRequire(import.meta.url);
  return require.resolve("xcodebuildmcp");
};

/**
 * The subset of an MCP transport exposed by StdioClientTransport that this
 * adapter needs. Keeping it small makes process behavior testable without
 * starting npx in unit tests.
 */
export interface XcodeBuildMcpTransport extends Transport {
  readonly stderr?: Stream | null;
  readonly pid?: number | null;
}

export interface XcodeBuildMcpClientLike {
  readonly connect: (transport: Transport, options?: RequestOptions) => Promise<void>;
  readonly callTool: (
    params: { readonly name: string; readonly arguments?: Record<string, unknown> },
    resultSchema?: Parameters<Client["callTool"]>[1],
    options?: RequestOptions,
  ) => Promise<XcodeBuildMcpToolResult>;
  readonly close: () => Promise<void>;
}

export type XcodeBuildMcpToolResult = {
  readonly content?:
    | ReadonlyArray<{ readonly type: string; readonly text?: string | undefined }>
    | undefined;
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown | undefined;
  /** Compatibility responses from older MCP servers. */
  readonly toolResult?: unknown | undefined;
};

export interface XcodeBuildMcpClientOptions {
  /** Exact worktree that owns this build preparation or simulator lease. */
  readonly cwd: string;
  /** Exact simulator UDID selected before and retained by the lease manager. */
  readonly simulatorId: string;
  readonly command?: string;
  readonly npxArgs?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly stderrTailBytes?: number;
  /** Test seam for the exact-UDID cleanup fallback. */
  readonly terminateBundle?: (simulatorId: string, bundleId: string, cwd: string) => Promise<void>;
  readonly createTransport?: (parameters: StdioServerParameters) => XcodeBuildMcpTransport;
  readonly createClient?: () => XcodeBuildMcpClientLike;
}

/** Request cancellation supported by @modelcontextprotocol/sdk 1.30.0. */
export interface XcodeBuildMcpRequestOptions {
  readonly signal?: AbortSignal;
}

export interface XcodeBuildMcpProjectInput extends XcodeBuildMcpRequestOptions {
  readonly projectPath?: string;
  readonly workspacePath?: string;
  readonly scheme: string;
  readonly configuration?: string;
  readonly derivedDataPath?: string;
  readonly useLatestOS?: boolean;
}

/** The exact values accepted by XcodeBuildMCP 2.6.2's get_sim_app_path tool. */
export type XcodeBuildMcpSimulatorPlatform =
  | "iOS Simulator"
  | "watchOS Simulator"
  | "tvOS Simulator"
  | "visionOS Simulator";

/** Compile only. This deliberately maps to build_sim, not build_run_sim. */
export interface XcodeBuildMcpBuildInput extends XcodeBuildMcpProjectInput {
  readonly extraArgs?: ReadonlyArray<string>;
  readonly preferXcodebuild?: boolean;
}

/** Resolve the app built by build_sim without booting, installing, or launching it. */
export interface XcodeBuildMcpGetSimAppPathInput extends XcodeBuildMcpProjectInput {
  /** T3's Simulator boundary is iOS-only, so iOS Simulator is the safe default. */
  readonly platform?: XcodeBuildMcpSimulatorPlatform;
}

export interface XcodeBuildMcpGetAppBundleIdInput extends XcodeBuildMcpRequestOptions {
  readonly appPath: string;
}

export interface XcodeBuildMcpInstallInput extends XcodeBuildMcpRequestOptions {
  readonly appPath: string;
}

export interface XcodeBuildMcpBuildRunInput extends XcodeBuildMcpProjectInput {
  readonly launchArgs?: ReadonlyArray<string>;
  readonly preferXcodebuild?: boolean;
}

export interface XcodeBuildMcpLaunchInput extends XcodeBuildMcpRequestOptions {
  readonly bundleId: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface XcodeBuildMcpTapInput extends XcodeBuildMcpRequestOptions {
  readonly elementRef: string;
  readonly preDelay?: number;
  readonly postDelay?: number;
}

export interface XcodeBuildMcpTypeTextInput extends XcodeBuildMcpRequestOptions {
  readonly elementRef: string;
  readonly text: string;
  readonly replaceExisting?: boolean;
}

export interface XcodeBuildMcpWaitForUiInput extends XcodeBuildMcpRequestOptions {
  readonly predicate: "exists" | "gone" | "enabled" | "focused" | "textContains" | "settled";
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

export interface XcodeBuildMcpSwipeInput extends XcodeBuildMcpRequestOptions {
  readonly withinElementRef: string;
  readonly direction: "up" | "down" | "left" | "right";
  readonly duration?: number;
  readonly distance?: number;
  readonly preDelay?: number;
  readonly postDelay?: number;
}

export interface XcodeBuildMcpEnvelope<T = unknown> {
  readonly schema?: string;
  readonly schemaVersion?: string;
  readonly didError?: boolean;
  readonly error?: string | null;
  readonly data?: T;
  readonly nextSteps?: ReadonlyArray<string>;
}

export interface XcodeBuildMcpParseOptions {
  readonly expectedSimulatorId?: string;
  readonly expectedSchema?: string;
  readonly expectedSchemaVersion?: string;
  readonly requireData?: boolean;
  readonly requireSuccessfulSummary?: boolean;
  readonly requiredArtifact?: string;
  readonly requiredArtifacts?: ReadonlyArray<string>;
}

export type XcodeBuildMcpErrorCode =
  | "closed"
  | "connection"
  | "transport"
  | "tool-error"
  | "protocol"
  | "schema-mismatch"
  | "simulator-mismatch"
  | "failed"
  | "missing-artifact"
  | "artifact-mismatch";

type XcodeBuildMcpSuccessfulSummary = Readonly<Record<string, unknown>> & {
  readonly status: "SUCCEEDED";
};

type XcodeBuildMcpArtifacts = Readonly<Record<string, unknown>>;

export interface XcodeBuildMcpBuildResult extends Record<string, unknown> {
  readonly summary: XcodeBuildMcpSuccessfulSummary;
  readonly artifacts: XcodeBuildMcpArtifacts & { readonly buildLogPath: string };
}

export interface XcodeBuildMcpAppPathResult extends Record<string, unknown> {
  readonly summary: XcodeBuildMcpSuccessfulSummary;
  readonly artifacts: XcodeBuildMcpArtifacts & { readonly appPath: string };
}

export interface XcodeBuildMcpBundleIdResult extends Record<string, unknown> {
  readonly artifacts: XcodeBuildMcpArtifacts & {
    readonly appPath: string;
    readonly bundleId: string;
  };
}

export interface XcodeBuildMcpInstallResult extends Record<string, unknown> {
  readonly summary: XcodeBuildMcpSuccessfulSummary;
  readonly artifacts: XcodeBuildMcpArtifacts & {
    readonly appPath: string;
    readonly simulatorId: string;
  };
}

export interface XcodeBuildMcpLaunchResult extends Record<string, unknown> {
  readonly summary: XcodeBuildMcpSuccessfulSummary;
  readonly artifacts: XcodeBuildMcpArtifacts & {
    readonly bundleId: string;
    readonly simulatorId: string;
  };
}

/** A bounded, structured error for the XcodeBuildMCP child and tool boundary. */
export class XcodeBuildMcpError extends Error {
  readonly code: XcodeBuildMcpErrorCode;
  readonly toolName?: string;
  readonly stderrTail?: string;
  readonly details?: unknown;

  constructor(
    code: XcodeBuildMcpErrorCode,
    message: string,
    options: {
      readonly toolName?: string;
      readonly stderrTail?: string;
      readonly details?: unknown;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "XcodeBuildMcpError";
    this.code = code;
    if (options.toolName !== undefined) this.toolName = options.toolName;
    if (options.stderrTail !== undefined) this.stderrTail = options.stderrTail;
    if (options.details !== undefined) this.details = options.details;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseJsonText = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const extractPayload = (result: XcodeBuildMcpToolResult): unknown => {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.toolResult !== undefined) return result.toolResult;

  const text = result.content?.find((item) => item.type === "text");
  if (text?.type === "text" && typeof text.text === "string") {
    const parsed = parseJsonText(text.text);
    return parsed ?? { text: text.text };
  }
  return undefined;
};

const envelopeData = <T>(payload: unknown): { envelope: XcodeBuildMcpEnvelope<T>; data: T } => {
  if (!isRecord(payload)) {
    throw new XcodeBuildMcpError("protocol", "XcodeBuildMCP returned a non-object result.");
  }
  if ("data" in payload) {
    return {
      envelope: payload as XcodeBuildMcpEnvelope<T>,
      data: payload.data as T,
    };
  }
  return { envelope: payload as XcodeBuildMcpEnvelope<T>, data: payload as T };
};

const artifactValue = (data: unknown, artifact: string): unknown => {
  if (!isRecord(data) || !isRecord(data.artifacts)) return undefined;
  return data.artifacts[artifact];
};

const requireArtifactString = (toolName: string, data: unknown, artifact: string): string => {
  const value = artifactValue(data, artifact);
  if (typeof value === "string" && value.length > 0) return value;
  throw new XcodeBuildMcpError(
    "missing-artifact",
    `XcodeBuildMCP tool '${toolName}' did not return a non-empty '${artifact}' artifact.`,
    { toolName, details: data },
  );
};

const requireMatchingArtifactString = (
  toolName: string,
  data: unknown,
  artifact: string,
  expected: string,
): void => {
  const received = requireArtifactString(toolName, data, artifact);
  if (received !== expected) {
    throw new XcodeBuildMcpError(
      "artifact-mismatch",
      `XcodeBuildMCP tool '${toolName}' returned ${artifact} '${received}', expected '${expected}'.`,
      { toolName, details: { artifact, expected, received } },
    );
  }
};

/**
 * Normalize the structured and text-compatible result forms emitted by MCP.
 * This function is deliberately exported so protocol handling can be tested
 * without spawning the pinned child process.
 */
export function parseXcodeBuildMcpToolResult<T = Record<string, unknown>>(
  toolName: string,
  result: XcodeBuildMcpToolResult,
  options: XcodeBuildMcpParseOptions = {},
): { readonly envelope: XcodeBuildMcpEnvelope<T>; readonly data: T } {
  if (result.isError === true) {
    throw new XcodeBuildMcpError(
      "tool-error",
      `XcodeBuildMCP tool '${toolName}' returned an error.`,
      {
        toolName,
      },
    );
  }

  const payload = extractPayload(result);
  if (payload === undefined) {
    throw new XcodeBuildMcpError(
      "protocol",
      `XcodeBuildMCP tool '${toolName}' returned no result.`,
      {
        toolName,
      },
    );
  }

  let parsed: { readonly envelope: XcodeBuildMcpEnvelope<T>; readonly data: T };
  try {
    parsed = envelopeData<T>(payload);
  } catch (error) {
    if (error instanceof XcodeBuildMcpError) {
      throw new XcodeBuildMcpError(error.code, error.message, { toolName, cause: error });
    }
    throw error;
  }

  const { envelope, data } = parsed;
  if (envelope.didError === true || (envelope.error !== undefined && envelope.error !== null)) {
    throw new XcodeBuildMcpError(
      "tool-error",
      envelope.error ?? `XcodeBuildMCP tool '${toolName}' failed.`,
      { toolName, details: data },
    );
  }

  if (options.expectedSchema !== undefined && envelope.schema !== options.expectedSchema) {
    throw new XcodeBuildMcpError(
      "schema-mismatch",
      `XcodeBuildMCP tool '${toolName}' returned schema '${envelope.schema ?? "missing"}', expected '${options.expectedSchema}'.`,
      { toolName, details: { expected: options.expectedSchema, received: envelope.schema } },
    );
  }

  if (
    options.expectedSchemaVersion !== undefined &&
    envelope.schemaVersion !== options.expectedSchemaVersion
  ) {
    throw new XcodeBuildMcpError(
      "schema-mismatch",
      `XcodeBuildMCP tool '${toolName}' returned schema version '${envelope.schemaVersion ?? "missing"}', expected '${options.expectedSchemaVersion}'.`,
      {
        toolName,
        details: { expected: options.expectedSchemaVersion, received: envelope.schemaVersion },
      },
    );
  }

  if (options.requireData && data === undefined) {
    throw new XcodeBuildMcpError("protocol", `XcodeBuildMCP tool '${toolName}' omitted data.`, {
      toolName,
    });
  }

  if (options.expectedSimulatorId !== undefined) {
    const artifactSimulatorId = asNonEmptyString(artifactValue(data, "simulatorId"));
    const dataSimulatorId = isRecord(data) ? asNonEmptyString(data.simulatorId) : undefined;
    const receivedSimulatorId = artifactSimulatorId ?? dataSimulatorId;
    if (receivedSimulatorId !== undefined && receivedSimulatorId !== options.expectedSimulatorId) {
      throw new XcodeBuildMcpError(
        "simulator-mismatch",
        `XcodeBuildMCP returned simulator '${receivedSimulatorId}', expected '${options.expectedSimulatorId}'.`,
        {
          toolName,
          details: { expected: options.expectedSimulatorId, received: receivedSimulatorId },
        },
      );
    }
  }

  if (options.requireSuccessfulSummary) {
    const summary = isRecord(data) && isRecord(data.summary) ? data.summary : undefined;
    if (summary === undefined || summary.status !== "SUCCEEDED") {
      throw new XcodeBuildMcpError(
        "failed",
        `XcodeBuildMCP tool '${toolName}' did not report a successful operation.`,
        { toolName, details: summary ?? data },
      );
    }
  }

  const requiredArtifacts = [
    ...(options.requiredArtifact === undefined ? [] : [options.requiredArtifact]),
    ...(options.requiredArtifacts ?? []),
  ];
  for (const artifact of requiredArtifacts) {
    if (artifactValue(data, artifact) === undefined) {
      throw new XcodeBuildMcpError(
        "missing-artifact",
        `XcodeBuildMCP tool '${toolName}' did not return artifact '${artifact}'.`,
        { toolName, details: data },
      );
    }
  }

  return parsed;
}

class BoundedTextTail {
  #text = "";
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  append(value: unknown): void {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    this.#text = `${this.#text}${text}`;
    const bytes = Buffer.byteLength(this.#text, "utf8");
    if (bytes <= this.maxBytes) return;
    const suffix = Buffer.from(this.#text, "utf8").subarray(-this.maxBytes);
    this.#text = suffix.toString("utf8");
  }

  get value(): string {
    return this.#text;
  }
}

const SAFE_CHILD_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "DEVELOPER_DIR",
  "SDKROOT",
  "LANG",
  "TERM",
  "CI",
]);

const defaultEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && (SAFE_CHILD_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))) {
      allowed[key] = value;
    }
  }
  return allowed;
};

const defaultTransport = (parameters: StdioServerParameters): XcodeBuildMcpTransport =>
  new StdioClientTransport(parameters);

const defaultClient = (): XcodeBuildMcpClientLike =>
  new Client({ name: "t3-code-ios-simulator", version: "1.0.0" }, { capabilities: {} });

const copyArray = (values: ReadonlyArray<string> | undefined): Array<string> | undefined =>
  values === undefined ? undefined : [...values];

const requireProjectOrWorkspace = (input: {
  readonly projectPath?: string;
  readonly workspacePath?: string;
}): void => {
  if ((input.projectPath === undefined) === (input.workspacePath === undefined)) {
    throw new XcodeBuildMcpError(
      "protocol",
      "XcodeBuildMCP requires exactly one of projectPath or workspacePath.",
    );
  }
};

/**
 * Private, simulator-scoped XcodeBuildMCP client.
 *
 * The process is lazy (the first operation starts it), lives for the adapter
 * instance, and is closed by the owner after build preparation or when its
 * simulator lease ends. Every operation is serialized because XcodeBuildMCP
 * keeps session defaults and UI snapshots as process-local state.
 */
export class XcodeBuildMcpClient {
  readonly simulatorId: string;
  readonly cwd: string;

  #client: XcodeBuildMcpClientLike | undefined;
  #transport: XcodeBuildMcpTransport | undefined;
  #connected = false;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #connectTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #stderr: BoundedTextTail;
  readonly #options: XcodeBuildMcpClientOptions;

  constructor(options: XcodeBuildMcpClientOptions) {
    if (options.cwd.length === 0) throw new Error("XcodeBuildMCP cwd cannot be empty.");
    if (options.simulatorId.length === 0)
      throw new Error("XcodeBuildMCP simulatorId cannot be empty.");
    this.cwd = options.cwd;
    this.simulatorId = options.simulatorId;
    this.#options = options;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#stderr = new BoundedTextTail(options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES);
  }

  get pid(): number | undefined {
    return this.#transport?.pid ?? undefined;
  }

  get stderrTail(): string {
    return this.#stderr.value;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async connect(options: XcodeBuildMcpRequestOptions = {}): Promise<void> {
    await this.#serialized(async () => {
      await this.#ensureConnected(options);
    });
  }

  /**
   * Compile an app without leasing, booting, installing, or launching a
   * Simulator. A caller can resolve and validate its artifact before it asks
   * the manager to spend the single serve-sim slot.
   */
  async build(input: XcodeBuildMcpBuildInput): Promise<XcodeBuildMcpBuildResult> {
    return this.#serialized(async () => {
      requireProjectOrWorkspace(input);
      const args: Record<string, unknown> = {
        scheme: input.scheme,
        simulatorId: this.simulatorId,
      };
      if (input.projectPath !== undefined) args.projectPath = input.projectPath;
      if (input.workspacePath !== undefined) args.workspacePath = input.workspacePath;
      if (input.configuration !== undefined) args.configuration = input.configuration;
      if (input.derivedDataPath !== undefined) args.derivedDataPath = input.derivedDataPath;
      if (input.extraArgs !== undefined) args.extraArgs = copyArray(input.extraArgs);
      if (input.useLatestOS !== undefined) args.useLatestOS = input.useLatestOS;
      if (input.preferXcodebuild !== undefined) args.preferXcodebuild = input.preferXcodebuild;
      const { data } = await this.#call(
        "build_sim",
        args,
        {
          expectedSchema: XCODE_BUILD_MCP_BUILD_RESULT_SCHEMA,
          expectedSchemaVersion: XCODE_BUILD_MCP_SCHEMA_VERSION,
          requireData: true,
          requireSuccessfulSummary: true,
          requiredArtifact: "buildLogPath",
        },
        input,
      );
      requireArtifactString("build_sim", data, "buildLogPath");
      return data as XcodeBuildMcpBuildResult;
    });
  }

  /** Resolve the build artifact path without touching the Simulator runtime. */
  async getSimAppPath(input: XcodeBuildMcpGetSimAppPathInput): Promise<XcodeBuildMcpAppPathResult> {
    return this.#serialized(async () => {
      requireProjectOrWorkspace(input);
      const args: Record<string, unknown> = {
        scheme: input.scheme,
        platform: input.platform ?? DEFAULT_SIMULATOR_PLATFORM,
        simulatorId: this.simulatorId,
      };
      if (input.projectPath !== undefined) args.projectPath = input.projectPath;
      if (input.workspacePath !== undefined) args.workspacePath = input.workspacePath;
      if (input.configuration !== undefined) args.configuration = input.configuration;
      if (input.derivedDataPath !== undefined) args.derivedDataPath = input.derivedDataPath;
      if (input.useLatestOS !== undefined) args.useLatestOS = input.useLatestOS;
      const { data } = await this.#call(
        "get_sim_app_path",
        args,
        {
          expectedSchema: XCODE_BUILD_MCP_APP_PATH_SCHEMA,
          expectedSchemaVersion: XCODE_BUILD_MCP_SCHEMA_VERSION,
          requireData: true,
          requireSuccessfulSummary: true,
          requiredArtifact: "appPath",
        },
        input,
      );
      requireArtifactString("get_sim_app_path", data, "appPath");
      return data as XcodeBuildMcpAppPathResult;
    });
  }

  /** Extract the bundle identifier from the exact app bundle selected above. */
  async getAppBundleId(
    input: XcodeBuildMcpGetAppBundleIdInput,
  ): Promise<XcodeBuildMcpBundleIdResult> {
    return this.#serialized(async () => {
      const { data } = await this.#call(
        "get_app_bundle_id",
        { appPath: input.appPath },
        {
          expectedSchema: XCODE_BUILD_MCP_BUNDLE_ID_SCHEMA,
          expectedSchemaVersion: XCODE_BUILD_MCP_SCHEMA_VERSION,
          requireData: true,
          requiredArtifacts: ["appPath", "bundleId"],
        },
        input,
      );
      requireMatchingArtifactString("get_app_bundle_id", data, "appPath", input.appPath);
      requireArtifactString("get_app_bundle_id", data, "bundleId");
      return data as XcodeBuildMcpBundleIdResult;
    });
  }

  /** Install a previously validated app bundle on this client's exact UDID. */
  async install(input: XcodeBuildMcpInstallInput): Promise<XcodeBuildMcpInstallResult> {
    return this.#serialized(async () => {
      const { data } = await this.#call(
        "install_app_sim",
        {
          simulatorId: this.simulatorId,
          appPath: input.appPath,
        },
        {
          expectedSchema: XCODE_BUILD_MCP_INSTALL_RESULT_SCHEMA,
          expectedSchemaVersion: XCODE_BUILD_MCP_SCHEMA_VERSION,
          requireData: true,
          requireSuccessfulSummary: true,
          requiredArtifacts: ["simulatorId", "appPath"],
        },
        input,
      );
      requireMatchingArtifactString("install_app_sim", data, "simulatorId", this.simulatorId);
      requireMatchingArtifactString("install_app_sim", data, "appPath", input.appPath);
      return data as XcodeBuildMcpInstallResult;
    });
  }

  async buildRun(input: XcodeBuildMcpBuildRunInput): Promise<unknown> {
    return this.#serialized(async () => {
      requireProjectOrWorkspace(input);
      const args: Record<string, unknown> = {
        scheme: input.scheme,
        simulatorId: this.simulatorId,
      };
      if (input.projectPath !== undefined) args.projectPath = input.projectPath;
      if (input.workspacePath !== undefined) args.workspacePath = input.workspacePath;
      if (input.configuration !== undefined) args.configuration = input.configuration;
      if (input.derivedDataPath !== undefined) args.derivedDataPath = input.derivedDataPath;
      if (input.launchArgs !== undefined) args.launchArgs = copyArray(input.launchArgs);
      if (input.useLatestOS !== undefined) args.useLatestOS = input.useLatestOS;
      if (input.preferXcodebuild !== undefined) args.preferXcodebuild = input.preferXcodebuild;
      const { data } = await this.#call(
        "build_run_sim",
        args,
        {
          requireSuccessfulSummary: true,
          requiredArtifact: "appPath",
        },
        input,
      );
      return data;
    });
  }

  async launch(input: XcodeBuildMcpLaunchInput): Promise<XcodeBuildMcpLaunchResult> {
    return this.#serialized(async () => {
      const args: Record<string, unknown> = {
        simulatorId: this.simulatorId,
        bundleId: input.bundleId,
      };
      if (input.launchArgs !== undefined) args.launchArgs = copyArray(input.launchArgs);
      if (input.env !== undefined) args.env = { ...input.env };
      const { data } = await this.#call(
        "launch_app_sim",
        args,
        {
          expectedSchema: XCODE_BUILD_MCP_LAUNCH_RESULT_SCHEMA,
          expectedSchemaVersion: XCODE_BUILD_MCP_SCHEMA_VERSION,
          requireData: true,
          requireSuccessfulSummary: true,
          requiredArtifacts: ["simulatorId", "bundleId"],
        },
        input,
      );
      requireMatchingArtifactString("launch_app_sim", data, "simulatorId", this.simulatorId);
      requireMatchingArtifactString("launch_app_sim", data, "bundleId", input.bundleId);
      return data as XcodeBuildMcpLaunchResult;
    });
  }

  async stop(bundleId: string, options: XcodeBuildMcpRequestOptions = {}): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call(
        "stop_app_sim",
        {
          simulatorId: this.simulatorId,
          bundleId,
        },
        {},
        options,
      );
      return data;
    });
  }

  /**
   * Last-resort app cleanup. This intentionally uses an argv-only xcrun call
   * pinned to this client's exact lease UDID; it is never exposed as an MCP
   * operation and cannot select another simulator.
   */
  async terminate(bundleId: string): Promise<void> {
    if (!SIMULATOR_UDID_PATTERN.test(this.simulatorId)) {
      throw new XcodeBuildMcpError("protocol", "Cannot terminate an invalid simulator UDID.");
    }
    if (bundleId.length === 0 || bundleId.length > 255 || /[\u0000-\u001f\u007f]/u.test(bundleId)) {
      throw new XcodeBuildMcpError("protocol", "Cannot terminate an invalid bundle identifier.");
    }
    const terminate = this.#options.terminateBundle;
    if (terminate !== undefined) {
      await terminate(this.simulatorId, bundleId, this.cwd);
      return;
    }
    try {
      await execFileAsync("xcrun", ["simctl", "terminate", this.simulatorId, bundleId], {
        cwd: this.cwd,
        env: defaultEnvironment({ ...process.env, ...this.#options.environment }),
        timeout: DEFAULT_TERMINATE_TIMEOUT_MS,
        maxBuffer: 8 * 1024,
      });
    } catch (cause) {
      throw new XcodeBuildMcpError(
        "transport",
        `Exact-UDID simulator app termination failed for '${bundleId}'.`,
        { cause },
      );
    }
  }

  async snapshotUi(
    input: { readonly sinceScreenHash?: string } & XcodeBuildMcpRequestOptions = {},
  ): Promise<unknown> {
    return this.#serialized(async () => {
      const args: Record<string, unknown> = { simulatorId: this.simulatorId };
      if (input.sinceScreenHash !== undefined) args.sinceScreenHash = input.sinceScreenHash;
      const { data } = await this.#call("snapshot_ui", args, {}, input);
      return data;
    });
  }

  async screenshot(
    returnFormat: "path" | "base64" = "path",
    options: XcodeBuildMcpRequestOptions = {},
  ): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call(
        "screenshot",
        {
          simulatorId: this.simulatorId,
          returnFormat,
        },
        {},
        options,
      );
      return data;
    });
  }

  async tap(input: XcodeBuildMcpTapInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { signal: _signal, ...tapInput } = input;
      const { data } = await this.#call(
        "tap",
        {
          simulatorId: this.simulatorId,
          ...tapInput,
        },
        {},
        input,
      );
      return data;
    });
  }

  async typeText(input: XcodeBuildMcpTypeTextInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { signal: _signal, ...typeTextInput } = input;
      const { data } = await this.#call(
        "type_text",
        {
          simulatorId: this.simulatorId,
          ...typeTextInput,
        },
        {},
        input,
      );
      return data;
    });
  }

  async waitForUi(input: XcodeBuildMcpWaitForUiInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { signal: _signal, ...waitForUiInput } = input;
      const { data } = await this.#call(
        "wait_for_ui",
        {
          simulatorId: this.simulatorId,
          ...waitForUiInput,
        },
        {},
        input,
      );
      return data;
    });
  }

  async swipe(input: XcodeBuildMcpSwipeInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { signal: _signal, ...swipeInput } = input;
      const { data } = await this.#call(
        "swipe",
        {
          simulatorId: this.simulatorId,
          ...swipeInput,
        },
        {},
        input,
      );
      return data;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#serialized(async () => {
      const client = this.#client;
      const transport = this.#transport;
      if (client !== undefined) {
        try {
          await client.close();
        } catch (error) {
          if (transport !== undefined) {
            try {
              await transport.close();
            } catch {
              // Preserve the first close failure.
            }
          }
          throw new XcodeBuildMcpError("transport", "Failed to close XcodeBuildMCP.", {
            cause: error,
            stderrTail: this.stderrTail,
          });
        }
      } else if (transport !== undefined) {
        try {
          await transport.close();
        } catch (error) {
          throw new XcodeBuildMcpError("transport", "Failed to close XcodeBuildMCP transport.", {
            cause: error,
            stderrTail: this.stderrTail,
          });
        }
      }
      this.#client = undefined;
      this.#transport = undefined;
      this.#connected = false;
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #ensureConnected(
    requestOptions: XcodeBuildMcpRequestOptions = {},
  ): Promise<XcodeBuildMcpClientLike> {
    if (this.#closed) {
      throw new XcodeBuildMcpError("closed", "XcodeBuildMCP client is closed.");
    }
    if (this.#connected && this.#client !== undefined) return this.#client;

    const command = this.#options.command ?? process.execPath;
    let childArgs: Array<string>;
    if (this.#options.npxArgs !== undefined) {
      childArgs = [...this.#options.npxArgs];
    } else {
      let cli: string;
      try {
        cli = resolveXcodeBuildMcpCli();
      } catch (cause) {
        throw new XcodeBuildMcpError(
          "connection",
          `XcodeBuildMCP ${XCODE_BUILD_MCP_VERSION} is unavailable. Install the iOS simulator dependencies on macOS before using this workflow.`,
          { cause },
        );
      }
      childArgs = [cli, "mcp"];
    }
    const environment = {
      ...defaultEnvironment({
        ...process.env,
        ...this.#options.environment,
      }),
      XCODEBUILDMCP_ENABLED_WORKFLOWS: XCODE_BUILD_MCP_WORKFLOWS,
      XCODEBUILDMCP_DISABLE_XCODE_AUTO_SYNC: "1",
      XCODEBUILDMCP_DISABLE_SESSION_DEFAULTS: "1",
      XCODEBUILDMCP_MCP_IDLE_TIMEOUT_MS: "0",
      XCODEBUILDMCP_SENTRY_DISABLED: "1",
      // T3 renders the simulator through serve-sim. Keep XcodeBuildMCP from
      // opening the shared native Simulator.app when build/run tools boot the
      // leased device.
      XCODEBUILDMCP_HEADLESS_LAUNCH: "1",
    };
    const parameters: StdioServerParameters = {
      command,
      args: childArgs,
      cwd: this.cwd,
      env: environment,
      stderr: "pipe",
    };

    const transport = (this.#options.createTransport ?? defaultTransport)(parameters);
    this.#transport = transport;
    if (transport.stderr !== undefined && transport.stderr !== null) {
      transport.stderr.on("data", (chunk) => this.#stderr.append(chunk));
    }

    const client = (this.#options.createClient ?? defaultClient)();
    this.#client = client;
    try {
      await client.connect(transport, {
        timeout: this.#connectTimeoutMs,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      this.#connected = true;
      return client;
    } catch (error) {
      this.#client = undefined;
      this.#connected = false;
      try {
        await transport.close();
      } catch {
        // Preserve the connection failure; the stderr tail remains available.
      }
      throw new XcodeBuildMcpError(
        "connection",
        `Failed to connect to XcodeBuildMCP ${XCODE_BUILD_MCP_VERSION}.`,
        { cause: error, stderrTail: this.stderrTail },
      );
    }
  }

  async #call(
    toolName: string,
    args: Record<string, unknown>,
    options: Omit<XcodeBuildMcpParseOptions, "expectedSimulatorId"> = {},
    requestOptions: XcodeBuildMcpRequestOptions = {},
  ): Promise<{ readonly envelope: XcodeBuildMcpEnvelope; readonly data: unknown }> {
    const client = await this.#ensureConnected(requestOptions);
    let result: XcodeBuildMcpToolResult;
    try {
      result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: this.#requestTimeoutMs,
        maxTotalTimeout: this.#requestTimeoutMs,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
    } catch (error) {
      throw new XcodeBuildMcpError(
        "transport",
        `XcodeBuildMCP tool '${toolName}' could not be invoked.`,
        { toolName, cause: error, stderrTail: this.stderrTail },
      );
    }
    try {
      return parseXcodeBuildMcpToolResult(toolName, result, {
        ...options,
        expectedSimulatorId: this.simulatorId,
      });
    } catch (error) {
      if (error instanceof XcodeBuildMcpError && error.stderrTail === undefined) {
        throw new XcodeBuildMcpError(error.code, error.message, {
          toolName,
          details: error.details,
          cause: error,
          stderrTail: this.stderrTail,
        });
      }
      throw error;
    }
  }
}
