// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
/**
 * A small, deliberately boring process boundary around serve-sim.
 *
 * serve-sim is a native macOS process (and it can expose a shell-exec route in
 * its preview). The rest of the simulator stack should therefore only ever
 * receive the exact device helper URLs below and the small, validated HID
 * protocol implemented here. In particular, this class never forwards a
 * request to an arbitrary serve-sim path and never uses `serve-sim --kill`.
 */
import { createRequire } from "node:module";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const SERVE_SIM_VERSION = "0.1.45";
const LOOPBACK_HOST = "127.0.0.1";
// A cold CoreSimulator boot can take well beyond 30 seconds while SpringBoard
// and the framebuffer services initialize. Keep the wait bounded, but long
// enough for a first boot on a development Mac.
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_OUTPUT_TAIL_BYTES = 32 * 1024;
const MAX_INPUT_BYTES = 8 * 1024;

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

/**
 * serve-sim 0.1.45 unconditionally runs `open -ga Simulator` while booting a
 * device. T3 owns the browser stream, so opening the shared native
 * Simulator.app is surprising (and can steal focus from another project).
 * The shim is prepended to the child PATH and suppresses only that exact argv;
 * any other `open` invocation is forwarded to the system binary unchanged.
 */
export interface ServeSimHeadlessOpenShim {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

const createHeadlessOpenShim = async (): Promise<ServeSimHeadlessOpenShim> => {
  const directory = await mkdtemp(join(tmpdir(), "t3-serve-sim-headless-"));
  const openPath = join(directory, "open");
  try {
    await writeFile(
      openPath,
      [
        "#!/bin/sh",
        'if [ "$#" -eq 2 ] && [ "$1" = "-ga" ] && [ "$2" = "Simulator" ]; then',
        "  exit 0",
        "fi",
        'exec /usr/bin/open "$@"',
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    // `mode` is honored by Node and Bun, but chmod makes this explicit for
    // filesystems that apply a restrictive umask to temporary files.
    await chmod(openPath, 0o700);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

const openNativeSimulator = (udid: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/open",
      ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid],
      { timeout: 10_000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });

const safeChildEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && (SAFE_CHILD_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))) {
      allowed[key] = value;
    }
  }
  return allowed;
};

const simulatorUdidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** The helper routes that may be exposed by a T3 proxy. */
export const SERVE_SIM_HELPER_ENDPOINTS = [
  "stream.mjpeg",
  "config",
  "health",
  "ax",
  "foreground",
] as const;

export type ServeSimHelperEndpoint = (typeof SERVE_SIM_HELPER_ENDPOINTS)[number];

export interface ServeSimHelperUrls {
  readonly streamMjpeg: string;
  readonly config: string;
  readonly health: string;
  readonly ax: string;
  readonly foreground: string;
  /** Loopback-only control socket. Do not serialize this into a public URL. */
  readonly privateWebSocket: string;
}

export interface ServeSimConfig {
  readonly width?: number;
  readonly height?: number;
  readonly orientation?: string;
  readonly [key: string]: unknown;
}

export interface ServeSimExitEvent {
  readonly udid: string;
  readonly pid: number;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly unexpected: boolean;
}

export type ServeSimInput =
  | {
      readonly type: "touch";
      readonly phase: "begin" | "move" | "end";
      readonly x: number;
      readonly y: number;
      readonly edge?: number;
    }
  | { readonly type: "home" }
  | {
      readonly type: "keyboard";
      readonly phase: "down" | "up";
      readonly usage: number;
    }
  | {
      readonly type: "orientation";
      readonly orientation:
        | "portrait"
        | "portrait_upside_down"
        | "landscape_left"
        | "landscape_right";
    }
  | {
      readonly type: "scroll";
      readonly dx: number;
      readonly dy: number;
      readonly x?: number;
      readonly y?: number;
    }
  | { readonly type: "memory-warning" };

export interface ServeSimSession {
  readonly udid: string;
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly urls: ServeSimHelperUrls;
  readonly config: ServeSimConfig;
  readonly stdoutTail: () => string;
  readonly stderrTail: () => string;
  readonly sendInput: (input: ServeSimInput) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface ServeSimReadable {
  readonly on?: (event: "data", listener: (chunk: Uint8Array | string) => void) => unknown;
}

export interface ServeSimChild {
  readonly pid: number | undefined;
  readonly stdout: ServeSimReadable | null | undefined;
  readonly stderr: ServeSimReadable | null | undefined;
  readonly once: (event: "exit" | "error", listener: (...args: unknown[]) => void) => unknown;
  readonly on?: (event: "exit" | "error", listener: (...args: unknown[]) => void) => unknown;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
}

export type ServeSimSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ServeSimChild;

export interface ServeSimHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly body?: {
    readonly getReader?: () => {
      readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
      readonly cancel?: () => Promise<void> | void;
    };
  } | null;
}

export type ServeSimFetch = (
  url: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<ServeSimHttpResponse>;

export interface ServeSimWebSocket {
  readonly readyState: number;
  readonly send: (data: Uint8Array) => void;
  readonly close: (code?: number) => void;
  onopen?: ((event?: unknown) => void) | null;
  onerror?: ((event?: unknown) => void) | null;
  onclose?: ((event?: unknown) => void) | null;
  readonly addEventListener?: (
    event: "open" | "error" | "close",
    listener: (event?: unknown) => void,
  ) => void;
  readonly on?: (
    event: "open" | "error" | "close",
    listener: (...args: unknown[]) => void,
  ) => unknown;
}

export type ServeSimWebSocketFactory = (url: string) => ServeSimWebSocket;

export interface ServeSimSupervisorDependencies {
  readonly allocatePort?: () => Promise<number>;
  readonly spawn?: ServeSimSpawn;
  readonly fetch?: ServeSimFetch;
  readonly webSocket?: ServeSimWebSocketFactory;
  readonly resolveBinary?: () => string;
  /** Test seam for the temporary PATH shim that suppresses native Simulator.app. */
  readonly createHeadlessOpenShim?: () => Promise<ServeSimHeadlessOpenShim>;
  /** Test seam for the explicit native Simulator.app action. */
  readonly openNativeSimulator?: (udid: string) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly gracefulStopTimeoutMs?: number;
  readonly forceStopTimeoutMs?: number;
  readonly onUnexpectedExit?: (event: ServeSimExitEvent) => void;
}

/** A manager-owned cancellation signal for a startup that has no session yet. */
export interface ServeSimStartOptions {
  readonly signal?: AbortSignal;
}

export class ServeSimError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServeSimError";
    this.code = code;
  }
}

export class ServeSimInputError extends ServeSimError {
  constructor(message: string) {
    super("invalid-input", message);
    this.name = "ServeSimInputError";
  }
}

const throwIfStartAborted = (udid: string, signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new ServeSimError("aborted", `serve-sim startup was cancelled for ${udid}.`);
  }
};

class BoundedTail {
  #value = "";

  append(chunk: Uint8Array | string): void {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.#value = `${this.#value}${text}`;
    if (Buffer.byteLength(this.#value, "utf8") > MAX_OUTPUT_TAIL_BYTES) {
      const bytes = Buffer.from(this.#value, "utf8");
      this.#value = bytes.subarray(bytes.length - MAX_OUTPUT_TAIL_BYTES).toString("utf8");
    }
  }

  value(): string {
    return this.#value;
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultAllocatePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port for serve-sim."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const resolveServeSimBinary = (): string => {
  // Resolving the package through its installed export keeps this tied to the
  // lockfile version. It never invokes npx and never downloads at runtime.
  const require = createRequire(import.meta.url);
  const middlewarePath = require.resolve("serve-sim/middleware");
  return join(dirname(middlewarePath), "serve-sim.js");
};

const defaultWebSocket: ServeSimWebSocketFactory = (url) => {
  const require = createRequire(import.meta.url);
  let WebSocketConstructor: new (value: string) => ServeSimWebSocket;
  try {
    const middlewarePath = require.resolve("serve-sim/middleware");
    const serveSimRequire = createRequire(middlewarePath);
    WebSocketConstructor = serveSimRequire("ws").WebSocket as new (
      value: string,
    ) => ServeSimWebSocket;
  } catch {
    const Constructor = (globalThis as { WebSocket?: new (value: string) => ServeSimWebSocket })
      .WebSocket;
    if (!Constructor)
      throw new Error("No WebSocket implementation is available for serve-sim input.");
    WebSocketConstructor = Constructor;
  }
  return new WebSocketConstructor(url);
};

const defaultFetch: ServeSimFetch = async (url, init) =>
  fetch(url, init) as Promise<ServeSimHttpResponse>;

const normalizeBaseUrl = (port: number): string => `http://${LOOPBACK_HOST}:${port}`;

export const makeServeSimHelperUrls = (baseUrl: string, udid: string): ServeSimHelperUrls => {
  const base = baseUrl.replace(/\/$/, "");
  const devicePath = `/helper/${encodeURIComponent(udid)}`;
  return {
    streamMjpeg: `${base}${devicePath}/stream.mjpeg`,
    config: `${base}${devicePath}/config`,
    health: `${base}${devicePath}/health`,
    ax: `${base}${devicePath}/ax`,
    foreground: `${base}${devicePath}/foreground`,
    privateWebSocket: `ws://${LOOPBACK_HOST}:${new URL(base).port}${devicePath}/ws`,
  };
};

/**
 * Returns true only for the helper endpoint set. This is useful to callers
 * building the authenticated T3 HTTP proxy; `/exec`, `/devtools`, `/grid`,
 * and every other serve-sim route are intentionally rejected.
 */
export const isAllowedServeSimHelperPath = (pathname: string, udid: string): boolean => {
  const expectedPrefix = `/helper/${encodeURIComponent(udid)}/`;
  return SERVE_SIM_HELPER_ENDPOINTS.some((endpoint) => pathname === `${expectedPrefix}${endpoint}`);
};

const ensureFiniteNumber = (value: number, label: string): void => {
  if (!Number.isFinite(value)) throw new ServeSimInputError(`${label} must be finite.`);
};

const ensureNormalized = (value: number, label: string): void => {
  ensureFiniteNumber(value, label);
  if (value < 0 || value > 1) {
    throw new ServeSimInputError(`${label} must be between 0 and 1.`);
  }
};

const ensureInteger = (value: number, label: string, max: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ServeSimInputError(`${label} must be an integer between 0 and ${max}.`);
  }
};

const encodeInput = (input: ServeSimInput): Uint8Array => {
  let tag: number;
  let payload: Record<string, unknown> | undefined;
  switch (input.type) {
    case "touch":
      ensureNormalized(input.x, "touch.x");
      ensureNormalized(input.y, "touch.y");
      if (input.edge !== undefined) ensureInteger(input.edge, "touch.edge", 255);
      tag = 0x03;
      payload = {
        type: input.phase,
        x: input.x,
        y: input.y,
        ...(input.edge === undefined ? {} : { edge: input.edge }),
      };
      break;
    case "home":
      tag = 0x04;
      payload = { button: "home" };
      break;
    case "keyboard":
      ensureInteger(input.usage, "keyboard.usage", 255);
      tag = 0x06;
      payload = { type: input.phase, usage: input.usage };
      break;
    case "orientation":
      tag = 0x07;
      payload = { orientation: input.orientation };
      break;
    case "scroll":
      ensureFiniteNumber(input.dx, "scroll.dx");
      ensureFiniteNumber(input.dy, "scroll.dy");
      if (Math.abs(input.dx) > 10_000 || Math.abs(input.dy) > 10_000) {
        throw new ServeSimInputError("scroll deltas must be between -10000 and 10000.");
      }
      if (input.x !== undefined) ensureNormalized(input.x, "scroll.x");
      if (input.y !== undefined) ensureNormalized(input.y, "scroll.y");
      tag = 0x0b;
      payload = {
        dx: input.dx,
        dy: input.dy,
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
      };
      break;
    case "memory-warning":
      tag = 0x09;
      payload = undefined;
      break;
    default:
      throw new ServeSimInputError("Unsupported serve-sim input.");
  }

  const encoded =
    payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.byteLength + 1 > MAX_INPUT_BYTES) {
    throw new ServeSimInputError("serve-sim input is too large.");
  }
  const message = new Uint8Array(encoded.byteLength + 1);
  message[0] = tag;
  message.set(encoded, 1);
  return message;
};

export const encodeServeSimInput = encodeInput;

const attachStream = (stream: ServeSimReadable | null | undefined, tail: BoundedTail): void => {
  stream?.on?.("data", (chunk) => tail.append(chunk));
};

const waitForEvent = (
  child: ServeSimChild,
  event: "exit" | "error",
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    child.once(event, () => finish(true));
    setTimeout(() => finish(false), timeoutMs);
  });

const waitForSocketOpen = (socket: ServeSimWebSocket, timeoutMs: number): Promise<void> => {
  const openState = 1;
  if (socket.readyState === openState) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () =>
      finish(new ServeSimError("websocket", "serve-sim input socket failed to open."));
    if (socket.addEventListener) {
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    } else if (socket.on) {
      socket.on("open", onOpen);
      socket.on("error", onError);
    } else {
      socket.onopen = onOpen;
      socket.onerror = onError;
    }
    setTimeout(
      () =>
        finish(new ServeSimError("websocket-timeout", "Timed out opening serve-sim input socket.")),
      timeoutMs,
    );
  });
};

const closeSocket = (socket: ServeSimWebSocket | undefined): void => {
  if (!socket) return;
  try {
    socket.close(1000);
  } catch {
    // Closing is best effort; serve-sim itself is still stopped by the child
    // process boundary.
  }
};

const readJson = async (
  fetcher: ServeSimFetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> => {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok)
      throw new ServeSimError("http", `serve-sim ${url} returned HTTP ${response.status}.`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ServeSimError("http-timeout", `Timed out reading ${url}.`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const probeStream = async (
  fetcher: ServeSimFetch,
  url: string,
  timeoutMs: number,
): Promise<void> => {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok)
      throw new ServeSimError("stream", `serve-sim stream returned HTTP ${response.status}.`);
    const reader = response.body?.getReader?.();
    if (!reader)
      throw new ServeSimError("stream", "serve-sim stream did not expose a readable body.");
    const firstChunk = await reader.read();
    if (firstChunk.done || !firstChunk.value || firstChunk.value.byteLength === 0) {
      throw new ServeSimError("stream", "serve-sim stream did not produce a frame.");
    }
    await reader.cancel?.();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ServeSimError("stream-timeout", "Timed out waiting for the first serve-sim frame.");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const parseConfig = (value: unknown): ServeSimConfig => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ServeSimConfig;
};

interface ActiveSession {
  readonly udid: string;
  readonly pid: number;
  readonly port: number;
  readonly urls: ServeSimHelperUrls;
  readonly child: ServeSimChild;
  readonly stdout: BoundedTail;
  readonly stderr: BoundedTail;
  readonly headlessOpenShim: ServeSimHeadlessOpenShim;
  config: ServeSimConfig;
  socket: ServeSimWebSocket | undefined;
  socketPromise: Promise<ServeSimWebSocket> | undefined;
  stopping: boolean;
  exited: boolean;
  exitEvent?: ServeSimExitEvent;
  closePromise: Promise<void> | undefined;
}

export class ServeSimSupervisor {
  readonly #allocatePort: () => Promise<number>;
  readonly #spawn: ServeSimSpawn;
  readonly #fetch: ServeSimFetch;
  readonly #webSocket: ServeSimWebSocketFactory;
  readonly #resolveBinary: () => string;
  readonly #createHeadlessOpenShim: () => Promise<ServeSimHeadlessOpenShim>;
  readonly #openNativeSimulator: (udid: string) => Promise<void>;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #readyTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #gracefulStopTimeoutMs: number;
  readonly #forceStopTimeoutMs: number;
  readonly #onUnexpectedExit: ((event: ServeSimExitEvent) => void) | undefined;
  readonly #sessions = new Map<string, ActiveSession>();

  constructor(dependencies: ServeSimSupervisorDependencies = {}) {
    this.#allocatePort = dependencies.allocatePort ?? defaultAllocatePort;
    this.#spawn =
      dependencies.spawn ??
      ((command, args, options) => spawn(command, [...args], options) as ServeSimChild);
    this.#fetch = dependencies.fetch ?? defaultFetch;
    this.#webSocket = dependencies.webSocket ?? defaultWebSocket;
    this.#resolveBinary = dependencies.resolveBinary ?? resolveServeSimBinary;
    this.#createHeadlessOpenShim = dependencies.createHeadlessOpenShim ?? createHeadlessOpenShim;
    this.#openNativeSimulator = dependencies.openNativeSimulator ?? openNativeSimulator;
    this.#now = dependencies.now ?? Date.now;
    this.#sleep = dependencies.sleep ?? defaultSleep;
    this.#readyTimeoutMs = dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.#requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#gracefulStopTimeoutMs =
      dependencies.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
    this.#forceStopTimeoutMs = dependencies.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS;
    this.#onUnexpectedExit = dependencies.onUnexpectedExit;
  }

  async start(udid: string, options: ServeSimStartOptions = {}): Promise<ServeSimSession> {
    if (!simulatorUdidPattern.test(udid)) {
      throw new ServeSimError("invalid-udid", `Invalid simulator UDID: ${udid}.`);
    }
    if (this.#sessions.has(udid)) {
      throw new ServeSimError("already-running", `serve-sim is already running for ${udid}.`);
    }
    const signal = options.signal;
    const stopOnAbort = () => {
      // Before port allocation there is no child to stop. The checks below
      // observe this same signal before spawning, and once active `stop` owns
      // the exact child record.
      void this.stop(udid).catch(() => undefined);
    };
    signal?.addEventListener("abort", stopOnAbort, { once: true });

    try {
      throwIfStartAborted(udid, signal);
      const port = await this.#allocatePort();
      throwIfStartAborted(udid, signal);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new ServeSimError(
          "invalid-port",
          `Port allocator returned an invalid port: ${port}.`,
        );
      }
      let headlessOpenShim: ServeSimHeadlessOpenShim;
      try {
        const createdShim = await this.#createHeadlessOpenShim();
        let cleanedUp = false;
        headlessOpenShim = {
          path: createdShim.path,
          cleanup: async () => {
            if (cleanedUp) return;
            cleanedUp = true;
            await createdShim.cleanup();
          },
        };
      } catch (error) {
        throw new ServeSimError(
          "headless",
          `Could not prepare the headless serve-sim environment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        throwIfStartAborted(udid, signal);
      } catch (error) {
        await headlessOpenShim.cleanup().catch(() => undefined);
        throw error;
      }

      const childEnvironment = safeChildEnvironment(process.env);
      childEnvironment.PATH = [headlessOpenShim.path, childEnvironment.PATH]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(delimiter);

      let child: ServeSimChild;
      try {
        child = this.#spawn(
          this.#resolveBinary(),
          [
            udid,
            "--port",
            String(port),
            "--host",
            LOOPBACK_HOST,
            "--codec",
            "mjpeg",
            "--panes",
            "none",
          ],
          {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env: childEnvironment,
          },
        );
      } catch (error) {
        await headlessOpenShim.cleanup().catch(() => undefined);
        throw error;
      }
      if (!child.pid) {
        await headlessOpenShim.cleanup().catch(() => undefined);
        throw new ServeSimError("spawn", "serve-sim did not expose a child PID.");
      }

      const stdout = new BoundedTail();
      const stderr = new BoundedTail();
      attachStream(child.stdout, stdout);
      attachStream(child.stderr, stderr);
      const baseUrl = normalizeBaseUrl(port);
      const urls = makeServeSimHelperUrls(baseUrl, udid);
      const active: ActiveSession = {
        udid,
        pid: child.pid,
        port,
        urls,
        child,
        stdout,
        stderr,
        headlessOpenShim,
        config: {},
        socket: undefined,
        socketPromise: undefined,
        stopping: false,
        exited: false,
        closePromise: undefined,
      };
      // Install synchronously before yielding again. An abort delivered after
      // spawn now reaches this exact child rather than a future same-UDID run.
      this.#sessions.set(udid, active);
      const onExit = (code?: unknown, exitSignal?: unknown) => {
        if (active.exited) return;
        active.exited = true;
        const event: ServeSimExitEvent = {
          udid,
          pid: active.pid,
          code: typeof code === "number" ? code : null,
          signal: typeof exitSignal === "string" ? exitSignal : null,
          stdoutTail: stdout.value(),
          stderrTail: stderr.value(),
          unexpected: !active.stopping,
        };
        active.exitEvent = event;
        closeSocket(active.socket);
        if (!active.stopping) {
          this.#sessions.delete(udid);
          this.#onUnexpectedExit?.(event);
        }
        void active.headlessOpenShim.cleanup().catch(() => undefined);
      };
      child.once("exit", onExit);
      child.once("error", (error) => {
        if (!active.exited) onExit(null, error instanceof Error ? error.message : "error");
      });

      try {
        throwIfStartAborted(udid, signal);
        active.config = await this.#waitUntilReady(active, signal);
        throwIfStartAborted(udid, signal);
      } catch (error) {
        await this.stop(active.udid);
        throw error;
      }

      return {
        udid,
        pid: active.pid,
        port,
        baseUrl,
        urls,
        config: active.config,
        stdoutTail: () => stdout.value(),
        stderrTail: () => stderr.value(),
        sendInput: (input) => this.#sendInput(active, input),
        close: () => this.stop(udid),
      };
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
  }

  async stop(sessionOrUdid: ServeSimSession | string): Promise<void> {
    const udid = typeof sessionOrUdid === "string" ? sessionOrUdid : sessionOrUdid.udid;
    const active = this.#sessions.get(udid);
    if (!active) return;
    if (active.closePromise) return active.closePromise;
    const closePromise = this.#stopActive(active);
    active.closePromise = closePromise;
    try {
      await closePromise;
    } catch (error) {
      if (active.closePromise === closePromise) active.closePromise = undefined;
      throw error;
    }
  }

  async openNative(udid: string): Promise<void> {
    if (!simulatorUdidPattern.test(udid)) {
      throw new ServeSimError("native-open", "Cannot open an invalid Simulator UDID.");
    }
    try {
      await this.#openNativeSimulator(udid);
    } catch (error) {
      throw new ServeSimError(
        "native-open",
        `Could not open Simulator.app: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get(udid: string): ServeSimSession | undefined {
    const active = this.#sessions.get(udid);
    if (!active || active.exited || active.stopping) return undefined;
    return {
      udid,
      pid: active.pid,
      port: active.port,
      baseUrl: normalizeBaseUrl(active.port),
      urls: active.urls,
      config: active.config,
      stdoutTail: () => active.stdout.value(),
      stderrTail: () => active.stderr.value(),
      sendInput: (input) => this.#sendInput(active, input),
      close: () => this.stop(udid),
    };
  }

  async #waitUntilReady(
    active: ActiveSession,
    signal: AbortSignal | undefined,
  ): Promise<ServeSimConfig> {
    const deadline = this.#now() + this.#readyTimeoutMs;
    let lastError: unknown;
    do {
      throwIfStartAborted(active.udid, signal);
      if (active.exited) {
        throw new ServeSimError(
          "exited",
          `serve-sim exited before becoming ready for ${active.udid}. ${active.stderr.value()}`,
        );
      }
      try {
        const health = await readJson(this.#fetch, active.urls.health, this.#requestTimeoutMs);
        if (
          !health ||
          typeof health !== "object" ||
          (health as { status?: unknown }).status !== "ok"
        ) {
          throw new ServeSimError("health", "serve-sim health check was not ok.");
        }
        await probeStream(this.#fetch, active.urls.streamMjpeg, this.#requestTimeoutMs);
        // serve-sim initially reports a 0x0 framebuffer on a cold boot. Read
        // config only after the first frame so coordinate mapping is usable as
        // soon as the manager publishes the ready session.
        const config = parseConfig(
          await readJson(this.#fetch, active.urls.config, this.#requestTimeoutMs),
        );
        if (
          typeof config.width !== "number" ||
          !Number.isFinite(config.width) ||
          config.width <= 0 ||
          typeof config.height !== "number" ||
          !Number.isFinite(config.height) ||
          config.height <= 0
        ) {
          throw new ServeSimError("config", "serve-sim framebuffer dimensions are not ready.");
        }
        return config;
      } catch (error) {
        lastError = error;
        throwIfStartAborted(active.udid, signal);
        if (active.exited) throw error;
      }
      if (this.#now() >= deadline) break;
      await this.#sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(1, deadline - this.#now())));
    } while (this.#now() < deadline);
    throw new ServeSimError(
      "ready-timeout",
      `Timed out waiting for serve-sim readiness for ${active.udid}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async #sendInput(active: ActiveSession, input: ServeSimInput): Promise<void> {
    if (active.stopping || active.exited)
      throw new ServeSimError("closed", "serve-sim session is closed.");
    const message = encodeInput(input);
    if (!active.socketPromise) {
      active.socketPromise = (async () => {
        const socket = this.#webSocket(active.urls.privateWebSocket);
        await waitForSocketOpen(socket, this.#requestTimeoutMs);
        active.socket = socket;
        return socket;
      })().catch((error) => {
        active.socketPromise = undefined;
        throw error;
      });
    }
    const socket = await active.socketPromise;
    if (socket.readyState !== 1)
      throw new ServeSimError("websocket", "serve-sim input socket is not open.");
    socket.send(message);
  }

  async #stopActive(active: ActiveSession): Promise<void> {
    active.stopping = true;
    closeSocket(active.socket);
    if (!active.exited) {
      try {
        active.child.kill("SIGTERM");
      } catch {
        // The process may have exited between the readiness check and kill.
      }
      if (!active.exited) {
        await waitForEvent(active.child, "exit", this.#gracefulStopTimeoutMs);
      }
      if (!active.exited) {
        try {
          active.child.kill("SIGKILL");
        } catch {
          // ESRCH means it exited without delivering the event to this shim.
        }
        if (!active.exited) {
          await waitForEvent(active.child, "exit", this.#forceStopTimeoutMs);
        }
      }
    }
    if (!active.exited) {
      throw new ServeSimError(
        "stop-timeout",
        `Could not confirm serve-sim exited for ${active.udid}; retaining its exact ownership record.`,
      );
    }
    this.#sessions.delete(active.udid);
    await active.headlessOpenShim.cleanup().catch(() => undefined);
  }
}
