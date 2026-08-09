import { describe, expect, it } from "@effect/vitest";
import { Readable } from "node:stream";

import {
  XcodeBuildMcpClient,
  XcodeBuildMcpError,
  type XcodeBuildMcpClientLike,
  type XcodeBuildMcpToolResult,
  type XcodeBuildMcpTransport,
  parseXcodeBuildMcpToolResult,
} from "./XcodeBuildMcpClient.ts";

const simulatorId = "2CD5E4A0-24C3-4F61-B751-8D0A74EE8A0F";

const success = (data: Record<string, unknown>): XcodeBuildMcpToolResult => ({
  content: [{ type: "text", text: "ok" }],
  structuredContent: {
    schema: "xcodebuildmcp.output.test",
    schemaVersion: "2",
    didError: false,
    error: null,
    data,
  },
});

class FakeTransport implements XcodeBuildMcpTransport {
  readonly stderr = Readable.from([]);
  readonly sent: Array<unknown> = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: () => void;

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: unknown): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

class FakeClient implements XcodeBuildMcpClientLike {
  connectCalls = 0;
  closeCalls = 0;
  readonly calls: Array<{ readonly name: string; readonly arguments?: Record<string, unknown> }> =
    [];
  callToolImpl: (
    name: string,
    args: Record<string, unknown> | undefined,
  ) => Promise<XcodeBuildMcpToolResult> = async () => success({});

  connect(): Promise<void> {
    this.connectCalls += 1;
    return Promise.resolve();
  }

  callTool(params: {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
  }): Promise<XcodeBuildMcpToolResult> {
    this.calls.push(params);
    return this.callToolImpl(params.name, params.arguments);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

const makeClient = (
  fakeClient: FakeClient,
  onTransport: (transport: FakeTransport, parameters: Record<string, unknown>) => void = () => {},
  environment?: NodeJS.ProcessEnv,
  terminateBundle?: (simulatorId: string, bundleId: string, cwd: string) => Promise<void>,
) =>
  new XcodeBuildMcpClient({
    cwd: "/worktrees/thread-a",
    simulatorId,
    ...(environment === undefined ? {} : { environment }),
    ...(terminateBundle === undefined ? {} : { terminateBundle }),
    createTransport: (parameters) => {
      const transport = new FakeTransport();
      onTransport(transport, parameters as unknown as Record<string, unknown>);
      return transport;
    },
    createClient: () => fakeClient,
  });

describe("XcodeBuildMcpClient", () => {
  it("starts one pinned child and injects the lease UDID into every call", async () => {
    const fakeClient = new FakeClient();
    let parameters: Record<string, unknown> | undefined;
    const client = makeClient(fakeClient, (_transport, received) => {
      parameters = received;
    });

    await client.connect();

    expect(fakeClient.connectCalls).toBe(1);
    expect(parameters).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("xcodebuildmcp"), "mcp"],
      cwd: "/worktrees/thread-a",
      stderr: "pipe",
    });
    expect(parameters?.env).toMatchObject({
      XCODEBUILDMCP_ENABLED_WORKFLOWS: "simulator,ui-automation,debugging",
      XCODEBUILDMCP_DISABLE_XCODE_AUTO_SYNC: "1",
      XCODEBUILDMCP_DISABLE_SESSION_DEFAULTS: "1",
      XCODEBUILDMCP_MCP_IDLE_TIMEOUT_MS: "0",
      XCODEBUILDMCP_SENTRY_DISABLED: "1",
    });
    expect(parameters?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(fakeClient.calls).toEqual([]);

    await client.close();
    expect(fakeClient.closeCalls).toBe(1);
  });

  it("does not forward arbitrary parent environment values to the child", async () => {
    const fakeClient = new FakeClient();
    let parameters: Record<string, unknown> | undefined;
    const client = makeClient(
      fakeClient,
      (_transport, received) => {
        parameters = received;
      },
      {
        T3_SIMULATOR_SECRET: "not-for-child",
        NODE_OPTIONS: "--require=/tmp/attacker.js",
        PATH: "/usr/bin",
      },
    );

    await client.connect();
    expect(parameters?.env).toMatchObject({ PATH: "/usr/bin" });
    expect(parameters?.env).not.toHaveProperty("T3_SIMULATOR_SECRET");
    expect(parameters?.env).not.toHaveProperty("NODE_OPTIONS");
    await client.close();
  });

  it("keeps the cleanup fallback pinned to the exact lease UDID", async () => {
    const fakeClient = new FakeClient();
    const calls: Array<{
      readonly simulatorId: string;
      readonly bundleId: string;
      readonly cwd: string;
    }> = [];
    const client = makeClient(
      fakeClient,
      () => {},
      undefined,
      async (receivedSimulatorId, bundleId, cwd) => {
        calls.push({ simulatorId: receivedSimulatorId, bundleId, cwd });
      },
    );

    await client.terminate("com.example.app");
    expect(calls).toEqual([
      {
        simulatorId,
        bundleId: "com.example.app",
        cwd: "/worktrees/thread-a",
      },
    ]);
  });

  it("serializes calls because XcodeBuildMCP session state is process-local", async () => {
    const fakeClient = new FakeClient();
    let releaseFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const started: Array<string> = [];
    fakeClient.callToolImpl = async (name) => {
      started.push(name);
      if (name === "snapshot_ui") {
        resolveFirstStarted?.();
        await firstFinished;
      }
      return success({});
    };
    const client = makeClient(fakeClient);

    const first = client.snapshotUi();
    const second = client.tap({ elementRef: "e1" });
    await firstStarted;
    expect(started).toEqual(["snapshot_ui"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(started).toEqual(["snapshot_ui", "tap"]);
    await client.close();
  });

  it("rejects stale simulator output, failed summaries, and missing build artifacts", () => {
    expect(() =>
      parseXcodeBuildMcpToolResult("snapshot_ui", success({ simulatorId: "wrong-simulator" }), {
        expectedSimulatorId: simulatorId,
      }),
    ).toThrow(/expected/);

    expect(() =>
      parseXcodeBuildMcpToolResult(
        "build_run_sim",
        success({ summary: { status: "FAILED" }, artifacts: {} }),
        { expectedSimulatorId: simulatorId, requireSuccessfulSummary: true },
      ),
    ).toThrow(/successful operation/);

    expect(() =>
      parseXcodeBuildMcpToolResult(
        "build_run_sim",
        success({ summary: { status: "SUCCEEDED" }, artifacts: {} }),
        { expectedSimulatorId: simulatorId, requiredArtifact: "appPath" },
      ),
    ).toThrow(/appPath/);
  });

  it("surfaces MCP didError and text-compatible error envelopes", () => {
    expect(() =>
      parseXcodeBuildMcpToolResult("list_sims", {
        content: [{ type: "text", text: "error" }],
        structuredContent: {
          schema: "xcodebuildmcp.output.error",
          schemaVersion: "1",
          didError: true,
          error: "Xcode is unavailable",
          data: { category: "runtime", code: "XCODE_UNAVAILABLE" },
        },
      }),
    ).toThrow("Xcode is unavailable");

    expect(() =>
      parseXcodeBuildMcpToolResult("list_sims", {
        content: [
          {
            type: "text",
            text: JSON.stringify({ didError: true, error: "text protocol failure", data: {} }),
          },
        ],
      }),
    ).toThrow("text protocol failure");
  });

  it("does not permit operations after close", async () => {
    const fakeClient = new FakeClient();
    const client = makeClient(fakeClient);
    await client.close();

    const error = await client.snapshotUi().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(XcodeBuildMcpError);
    expect((error as XcodeBuildMcpError).code).toBe("closed");
    expect(fakeClient.connectCalls).toBe(0);
  });
});
