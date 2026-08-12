// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import { delimiter } from "node:path";

import {
  encodeServeSimInput,
  isAllowedServeSimHelperPath,
  makeServeSimHelperUrls,
  ServeSimError,
  ServeSimInputError,
  ServeSimSupervisor,
  type ServeSimChild,
  type ServeSimFetch,
  type ServeSimReadable,
  type ServeSimSession,
  type ServeSimWebSocket,
} from "./ServeSimSupervisor.ts";

const udid = "2CD5E4A0-24C3-4F61-B751-8D0A74EE8A0F";

class FakeReadable implements ServeSimReadable {
  readonly #listeners: Array<(chunk: Uint8Array | string) => void> = [];

  on(_event: "data", listener: (chunk: Uint8Array | string) => void): this {
    this.#listeners.push(listener);
    return this;
  }

  emit(chunk: Uint8Array | string): void {
    for (const listener of this.#listeners) listener(chunk);
  }
}

class FakeChild implements ServeSimChild {
  readonly pid = 90210;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  readonly #listeners = new Map<"exit" | "error", Array<(...args: unknown[]) => void>>();
  readonly #exitsOnTerminate: boolean;

  constructor(exitsOnTerminate = true) {
    this.#exitsOnTerminate = exitsOnTerminate;
  }

  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: "exit" | "error", listener: (...args: unknown[]) => void): this {
    this.#listeners.set(
      event,
      (this.#listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }

  listenerCount(event: "exit" | "error"): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.#exitsOnTerminate && signal === "SIGTERM") this.emitExit(null, "SIGTERM");
    return true;
  }

  emitExit(code: number | null, signal: string | null): void {
    for (const listener of this.#listeners.get("exit") ?? []) listener(code, signal);
  }
}

class FakeSocket implements ServeSimWebSocket {
  readonly readyState = 1;
  readonly messages: Array<Uint8Array> = [];
  closed = false;

  send(data: Uint8Array): void {
    this.messages.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

class ThrowingSocket implements ServeSimWebSocket {
  readonly readyState = 1;
  closed = false;

  send(_data: Uint8Array): void {
    throw new Error("write failed");
  }

  close(): void {
    this.closed = true;
  }
}

class ErrorSocket implements ServeSimWebSocket {
  readonly readyState = 0;
  closed = false;
  readonly #listeners = new Map<"open" | "error" | "close", Array<(event?: unknown) => void>>();

  addEventListener(event: "open" | "error" | "close", listener: (event?: unknown) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  removeEventListener(
    event: "open" | "error" | "close",
    listener: (event?: unknown) => void,
  ): void {
    this.#listeners.set(
      event,
      (this.#listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  send(_data: Uint8Array): void {}

  close(): void {
    this.closed = true;
  }

  emitError(): void {
    for (const listener of this.#listeners.get("error") ?? []) listener();
  }

  emitClose(): void {
    for (const listener of this.#listeners.get("close") ?? []) listener();
  }

  listenerCount(): number {
    return Array.from(this.#listeners.values()).reduce(
      (count, listeners) => count + listeners.length,
      0,
    );
  }
}

const jsonResponse = (value: unknown) => ({
  ok: true,
  status: 200,
  json: async () => value,
});

const streamResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  body: {
    getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array([0xff, 0xd8, 0xff]) }),
      cancel: async () => undefined,
    }),
  },
});

const readyFetch =
  (calls: Array<string>): ServeSimFetch =>
  async (url) => {
    calls.push(url);
    if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
    if (url.endsWith("/config"))
      return jsonResponse({ width: 390, height: 844, orientation: "portrait" });
    return streamResponse();
  };

describe("ServeSimSupervisor", () => {
  it("limits helper URLs to the device-scoped safe endpoint set", () => {
    const urls = makeServeSimHelperUrls("http://127.0.0.1:4555", udid);
    expect(urls.streamMjpeg).toBe(
      `http://127.0.0.1:4555/helper/${encodeURIComponent(udid)}/stream.mjpeg`,
    );
    expect(isAllowedServeSimHelperPath(new URL(urls.streamMjpeg).pathname, udid)).toBe(true);
    expect(isAllowedServeSimHelperPath(`/helper/${udid}/exec`, udid)).toBe(false);
    expect(isAllowedServeSimHelperPath(`/helper/${udid}/devtools/page/1`, udid)).toBe(false);
  });

  it("encodes the serve-sim binary HID protocol and rejects unsafe values", () => {
    const touch = encodeServeSimInput({ type: "touch", phase: "begin", x: 0.25, y: 0.75 });
    expect(touch[0]).toBe(0x03);
    expect(new TextDecoder().decode(touch.slice(1))).toBe(
      JSON.stringify({ type: "begin", x: 0.25, y: 0.75 }),
    );

    const keyboard = encodeServeSimInput({
      type: "keyboard",
      phase: "down",
      usage: 4,
    });
    expect(keyboard[0]).toBe(0x06);
    expect(new TextDecoder().decode(keyboard.slice(1))).toBe(
      JSON.stringify({ type: "down", usage: 4 }),
    );

    expect(() => encodeServeSimInput({ type: "touch", phase: "move", x: 1.1, y: 0.5 })).toThrow(
      ServeSimInputError,
    );
    expect(() => encodeServeSimInput({ type: "keyboard", phase: "up", usage: 256 })).toThrow(
      ServeSimInputError,
    );
    expect(() =>
      encodeServeSimInput({ type: "orientation", orientation: "diagonal" } as never),
    ).toThrow(/Unsupported orientation/);
    expect(() =>
      encodeServeSimInput({ type: "touch", phase: "tap", x: 0.5, y: 0.5 } as never),
    ).toThrow(/Unsupported touch phase/);
    expect(() =>
      encodeServeSimInput({ type: "keyboard", phase: "press", usage: 4 } as never),
    ).toThrow(/Unsupported keyboard phase/);
    expect(() => encodeServeSimInput(null as never)).toThrow(ServeSimInputError);
  });

  it("spawns the pinned local serve-sim binary and waits for health, config, and a frame", async () => {
    const child = new FakeChild();
    let shimCleanupCount = 0;
    const previousSecret = process.env.T3_SIMULATOR_SECRET;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousLocale = process.env.LC_T3_SIMULATOR_TEST;
    process.env.T3_SIMULATOR_SECRET = "not-for-child";
    process.env.NODE_OPTIONS = "--require=/tmp/attacker.js";
    process.env.LC_T3_SIMULATOR_TEST = "allowed";
    let invocation:
      | {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly options: unknown;
        }
      | undefined;
    const calls: Array<string> = [];
    let session: ServeSimSession | undefined;
    try {
      const supervisor = new ServeSimSupervisor({
        allocatePort: async () => 4555,
        resolveBinary: () => "/worktree/apps/server/node_modules/serve-sim/dist/serve-sim.js",
        createHeadlessOpenShim: async () => ({
          path: "/tmp/t3-serve-sim-headless-test",
          cleanup: async () => {
            shimCleanupCount += 1;
          },
        }),
        spawn: (command, args, options) => {
          invocation = { command, args, options };
          return child;
        },
        fetch: readyFetch(calls),
        sleep: async () => undefined,
        readyTimeoutMs: 100,
      });

      session = await supervisor.start(udid);
      expect(invocation?.command).toBe(
        "/worktree/apps/server/node_modules/serve-sim/dist/serve-sim.js",
      );
      expect(invocation?.args).toEqual([
        udid,
        "--port",
        "4555",
        "--host",
        "127.0.0.1",
        "--codec",
        "mjpeg",
        "--panes",
        "none",
      ]);
      expect(invocation?.options).toMatchObject({
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childEnvironment = (invocation?.options as { readonly env?: NodeJS.ProcessEnv }).env;
      expect(childEnvironment).toBeDefined();
      expect(childEnvironment?.PATH).toBe(
        ["/tmp/t3-serve-sim-headless-test", process.env.PATH].filter(Boolean).join(delimiter),
      );
      expect(childEnvironment).toMatchObject({ LC_T3_SIMULATOR_TEST: "allowed" });
      expect(childEnvironment).not.toHaveProperty("NODE_OPTIONS");
      expect(childEnvironment).not.toHaveProperty("T3_SIMULATOR_SECRET");
      const allowedKeys = new Set([
        "PATH",
        "HOME",
        "TMPDIR",
        "DEVELOPER_DIR",
        "SDKROOT",
        "LANG",
        "TERM",
        "CI",
      ]);
      for (const key of Object.keys(childEnvironment ?? {})) {
        expect(allowedKeys.has(key) || key.startsWith("LC_")).toBe(true);
      }
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        `/helper/${udid}/health`,
        `/helper/${udid}/stream.mjpeg`,
        `/helper/${udid}/config`,
      ]);
      expect(session.config.width).toBe(390);
    } finally {
      await session?.close();
      if (previousSecret === undefined) delete process.env.T3_SIMULATOR_SECRET;
      else process.env.T3_SIMULATOR_SECRET = previousSecret;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousLocale === undefined) delete process.env.LC_T3_SIMULATOR_TEST;
      else process.env.LC_T3_SIMULATOR_TEST = previousLocale;
    }
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(shimCleanupCount).toBe(1);
  });

  it("opens the native app only for an explicit exact-UDID request", async () => {
    const opened: string[] = [];
    const supervisor = new ServeSimSupervisor({
      openNativeSimulator: async (exactUdid) => {
        opened.push(exactUdid);
      },
    });

    await supervisor.openNative(udid);
    expect(opened).toEqual([udid]);
    await expect(supervisor.openNative("not-a-udid")).rejects.toBeInstanceOf(ServeSimError);
    expect(opened).toEqual([udid]);
  });

  it("observes manager cancellation before a pending port allocation can spawn a child", async () => {
    let resolvePort: ((port: number) => void) | undefined;
    const pendingPort = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    let spawnCount = 0;
    const controller = new AbortController();
    const supervisor = new ServeSimSupervisor({
      allocatePort: () => pendingPort,
      resolveBinary: () => "/serve-sim.js",
      spawn: () => {
        spawnCount += 1;
        return new FakeChild();
      },
      fetch: readyFetch([]),
    });

    const starting = supervisor.start(udid, { signal: controller.signal });
    controller.abort();
    resolvePort?.(4558);

    await expect(starting).rejects.toMatchObject({ code: "aborted" });
    expect(spawnCount).toBe(0);
  });

  it("reuses one private websocket for allowlisted input messages", async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    let socketCount = 0;
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4556,
      resolveBinary: () => "/serve-sim.js",
      spawn: () => child,
      fetch: readyFetch([]),
      webSocket: () => {
        socketCount += 1;
        return socket;
      },
      sleep: async () => undefined,
      readyTimeoutMs: 100,
    });
    const session = await supervisor.start(udid);

    await session.sendInput({ type: "home" });
    await session.sendInput({ type: "memory-warning" });
    await session.sendInput({
      type: "orientation",
      orientation: "landscape_left",
    });

    expect(socketCount).toBe(1);
    expect(socket.messages.map((message) => message[0])).toEqual([0x04, 0x09, 0x07]);
    expect(new TextDecoder().decode(socket.messages[0]!.slice(1))).toBe(
      JSON.stringify({ button: "home" }),
    );
    await session.close();
    expect(socket.closed).toBe(true);
  });

  it("closes a socket when opening the private input channel fails", async () => {
    const child = new FakeChild();
    const socket = new ErrorSocket();
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4558,
      resolveBinary: () => "/serve-sim.js",
      spawn: () => child,
      fetch: readyFetch([]),
      webSocket: () => {
        queueMicrotask(() => socket.emitError());
        return socket;
      },
      sleep: async () => undefined,
      readyTimeoutMs: 100,
      requestTimeoutMs: 100,
    });
    const session = await supervisor.start(udid);

    await expect(session.sendInput({ type: "home" })).rejects.toMatchObject({ code: "websocket" });
    expect(socket.closed).toBe(true);
    expect(socket.listenerCount()).toBe(0);
    await session.close();
  });

  it("does not wait for an input socket that closes before opening", async () => {
    const child = new FakeChild();
    const socket = new ErrorSocket();
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4560,
      resolveBinary: () => "/serve-sim.js",
      spawn: () => child,
      fetch: readyFetch([]),
      webSocket: () => {
        queueMicrotask(() => socket.emitClose());
        return socket;
      },
      sleep: async () => undefined,
      readyTimeoutMs: 100,
      requestTimeoutMs: 100,
    });
    const session = await supervisor.start(udid);

    await expect(session.sendInput({ type: "home" })).rejects.toMatchObject({ code: "websocket" });
    expect(socket.closed).toBe(true);
    expect(socket.listenerCount()).toBe(0);
    await session.close();
  });

  it("closes and replaces a socket that fails while sending input", async () => {
    const child = new FakeChild();
    const failedSocket = new ThrowingSocket();
    const replacementSocket = new FakeSocket();
    const sockets = [failedSocket, replacementSocket];
    let socketIndex = 0;
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4561,
      resolveBinary: () => "/serve-sim.js",
      spawn: () => child,
      fetch: readyFetch([]),
      webSocket: () => sockets[socketIndex++]!,
      sleep: async () => undefined,
      readyTimeoutMs: 100,
    });
    const session = await supervisor.start(udid);

    await expect(session.sendInput({ type: "home" })).rejects.toMatchObject({ code: "websocket" });
    expect(failedSocket.closed).toBe(true);
    await session.sendInput({ type: "home" });
    expect(replacementSocket.messages).toHaveLength(1);
    await session.close();
  });

  it("removes timed-out child exit waiters", async () => {
    const child = new FakeChild(false);
    let shimCleanupCount = 0;
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4559,
      resolveBinary: () => "/serve-sim.js",
      createHeadlessOpenShim: async () => ({
        path: "/tmp/t3-serve-sim-headless-test",
        cleanup: async () => {
          shimCleanupCount += 1;
        },
      }),
      spawn: () => child,
      fetch: readyFetch([]),
      sleep: async () => undefined,
      readyTimeoutMs: 100,
      gracefulStopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
    });
    const session = await supervisor.start(udid);

    await expect(session.close()).rejects.toMatchObject({ code: "stop-timeout" });
    expect(child.listenerCount("exit")).toBe(1);
    child.emitExit(null, "SIGKILL");
    await Promise.resolve();
    expect(shimCleanupCount).toBe(1);
  });

  it("reports an unexpected child exit with bounded output tails", async () => {
    const child = new FakeChild();
    const exits: Array<{ readonly unexpected: boolean; readonly stderrTail: string }> = [];
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4557,
      resolveBinary: () => "/serve-sim.js",
      spawn: () => child,
      fetch: readyFetch([]),
      sleep: async () => undefined,
      readyTimeoutMs: 100,
      onUnexpectedExit: (event) =>
        exits.push({ unexpected: event.unexpected, stderrTail: event.stderrTail }),
    });
    await supervisor.start(udid);
    child.stderr.emit("serve-sim failed\n");
    child.emitExit(17, "SIGKILL");
    expect(exits).toEqual([{ unexpected: true, stderrTail: "serve-sim failed\n" }]);
    expect(supervisor.get(udid)).toBeUndefined();
  });
});
