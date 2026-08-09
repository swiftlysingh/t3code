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
const SIMULATOR_UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const DEFAULT_TERMINATE_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const XCODE_BUILD_MCP_CLI = require.resolve("xcodebuildmcp");

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
  /** Exact worktree that owns this simulator lease. */
  readonly cwd: string;
  /** Exact simulator UDID selected by the lease manager. */
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

export interface XcodeBuildMcpBuildRunInput {
  readonly projectPath?: string;
  readonly workspacePath?: string;
  readonly scheme: string;
  readonly configuration?: string;
  readonly derivedDataPath?: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly useLatestOS?: boolean;
  readonly preferXcodebuild?: boolean;
}

export interface XcodeBuildMcpLaunchInput {
  readonly bundleId: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface XcodeBuildMcpTapInput {
  readonly elementRef: string;
  readonly preDelay?: number;
  readonly postDelay?: number;
}

export interface XcodeBuildMcpTypeTextInput {
  readonly elementRef: string;
  readonly text: string;
  readonly replaceExisting?: boolean;
}

export interface XcodeBuildMcpWaitForUiInput {
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

export interface XcodeBuildMcpSwipeInput {
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
  readonly requireData?: boolean;
  readonly requireSuccessfulSummary?: boolean;
  readonly requiredArtifact?: string;
}

export type XcodeBuildMcpErrorCode =
  | "closed"
  | "connection"
  | "transport"
  | "tool-error"
  | "protocol"
  | "simulator-mismatch"
  | "failed"
  | "missing-artifact";

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

  if (
    options.requiredArtifact !== undefined &&
    artifactValue(data, options.requiredArtifact) === undefined
  ) {
    throw new XcodeBuildMcpError(
      "missing-artifact",
      `XcodeBuildMCP tool '${toolName}' did not return artifact '${options.requiredArtifact}'.`,
      { toolName, details: data },
    );
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
 * Private, lease-scoped XcodeBuildMCP client.
 *
 * The process is lazy (the first operation starts it), lives for the adapter
 * instance, and is closed by the owner when its simulator lease ends. Every
 * operation is serialized because XcodeBuildMCP keeps session defaults and
 * UI snapshots as process-local state.
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

  async connect(): Promise<void> {
    await this.#serialized(async () => {
      await this.#ensureConnected();
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
      const { data } = await this.#call("build_run_sim", args, {
        requireSuccessfulSummary: true,
        requiredArtifact: "appPath",
      });
      return data;
    });
  }

  async launch(input: XcodeBuildMcpLaunchInput): Promise<unknown> {
    return this.#serialized(async () => {
      const args: Record<string, unknown> = {
        simulatorId: this.simulatorId,
        bundleId: input.bundleId,
      };
      if (input.launchArgs !== undefined) args.launchArgs = copyArray(input.launchArgs);
      if (input.env !== undefined) args.env = { ...input.env };
      const { data } = await this.#call("launch_app_sim", args);
      return data;
    });
  }

  async stop(bundleId: string): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call("stop_app_sim", {
        simulatorId: this.simulatorId,
        bundleId,
      });
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

  async snapshotUi(input: { readonly sinceScreenHash?: string } = {}): Promise<unknown> {
    return this.#serialized(async () => {
      const args: Record<string, unknown> = { simulatorId: this.simulatorId };
      if (input.sinceScreenHash !== undefined) args.sinceScreenHash = input.sinceScreenHash;
      const { data } = await this.#call("snapshot_ui", args);
      return data;
    });
  }

  async screenshot(returnFormat: "path" | "base64" = "path"): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call("screenshot", {
        simulatorId: this.simulatorId,
        returnFormat,
      });
      return data;
    });
  }

  async tap(input: XcodeBuildMcpTapInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call("tap", {
        simulatorId: this.simulatorId,
        ...input,
      });
      return data;
    });
  }

  async typeText(input: XcodeBuildMcpTypeTextInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call("type_text", {
        simulatorId: this.simulatorId,
        ...input,
      });
      return data;
    });
  }

  async waitForUi(input: XcodeBuildMcpWaitForUiInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call("wait_for_ui", {
        simulatorId: this.simulatorId,
        ...input,
      });
      return data;
    });
  }

  async swipe(input: XcodeBuildMcpSwipeInput): Promise<unknown> {
    return this.#serialized(async () => {
      const { data } = await this.#call("swipe", {
        simulatorId: this.simulatorId,
        ...input,
      });
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

  async #ensureConnected(): Promise<XcodeBuildMcpClientLike> {
    if (this.#closed) {
      throw new XcodeBuildMcpError("closed", "XcodeBuildMCP client is closed.");
    }
    if (this.#connected && this.#client !== undefined) return this.#client;

    const command = this.#options.command ?? process.execPath;
    const childArgs = this.#options.npxArgs
      ? [...this.#options.npxArgs]
      : [XCODE_BUILD_MCP_CLI, "mcp"];
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
      await client.connect(transport, { timeout: this.#connectTimeoutMs });
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
  ): Promise<{ readonly envelope: XcodeBuildMcpEnvelope; readonly data: unknown }> {
    const client = await this.#ensureConnected();
    let result: XcodeBuildMcpToolResult;
    try {
      result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: this.#requestTimeoutMs,
        maxTotalTimeout: this.#requestTimeoutMs,
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
