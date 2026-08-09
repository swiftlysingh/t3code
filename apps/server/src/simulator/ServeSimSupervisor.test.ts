// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import {
  encodeServeSimInput,
  isAllowedServeSimHelperPath,
  makeServeSimHelperUrls,
  ServeSimInputError,
  ServeSimSupervisor,
  type ServeSimChild,
  type ServeSimFetch,
  type ServeSimReadable,
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

  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM") this.emitExit(null, "SIGTERM");
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
  });

  it("spawns the pinned local serve-sim binary and waits for health, config, and a frame", async () => {
    const child = new FakeChild();
    let invocation:
      | {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly options: unknown;
        }
      | undefined;
    const calls: Array<string> = [];
    const supervisor = new ServeSimSupervisor({
      allocatePort: async () => 4555,
      resolveBinary: () => "/worktree/apps/server/node_modules/serve-sim/dist/serve-sim.js",
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return child;
      },
      fetch: readyFetch(calls),
      sleep: async () => undefined,
      readyTimeoutMs: 100,
    });

    const session = await supervisor.start(udid);
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
    expect(childEnvironment).not.toHaveProperty("NODE_OPTIONS");
    expect(childEnvironment).not.toHaveProperty("T3_SIMULATOR_SECRET");
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      `/helper/${udid}/health`,
      `/helper/${udid}/stream.mjpeg`,
      `/helper/${udid}/config`,
    ]);
    expect(session.config.width).toBe(390);
    await session.close();
    expect(child.signals).toEqual(["SIGTERM"]);
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
