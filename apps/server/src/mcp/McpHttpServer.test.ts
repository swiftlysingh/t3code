import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  SimulatorDevice,
  SimulatorDeviceNotFoundError,
  SimulatorLeaseGenerationMismatchError,
  SimulatorLeaseId,
  SimulatorLeaseNotFoundError,
  SimulatorUdid,
  ThreadId,
  type SimulatorCapabilities,
  type SimulatorEvent,
  type SimulatorSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SimulatorAutomation from "../simulator/Automation.ts";
import * as SimulatorManager from "../simulator/Manager.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "ios-simulator"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const simulatorUdid = SimulatorUdid.make("11111111-1111-4111-8111-111111111111");
const simulatorLeaseId = SimulatorLeaseId.make("sim-lease-mcp-test");
const workspaceRoot = "/tmp/t3-mcp-simulator-worktree";
const simulatorCapabilities: SimulatorCapabilities = {
  host: { os: "darwin", arch: "arm64" },
  platformSupported: true,
  executionReady: true,
  deviceEnumeration: true,
  liveStreaming: true,
  humanInput: true,
  agentAutomation: true,
  maxActive: 1,
  reason: null,
};
const simulatorDevice: SimulatorDevice = {
  udid: simulatorUdid,
  name: "iPhone MCP Test",
  runtime: "iOS 26.4",
  state: "shutdown",
};

const makeReadySession = (thread: ThreadId): SimulatorSession => ({
  leaseId: simulatorLeaseId,
  threadId: thread,
  udid: simulatorUdid,
  generation: 1,
  state: "ready",
  media: {
    streamUrl: `/api/simulator/test-stream-${thread}/stream.mjpeg`,
    width: 1_206,
    height: 2_622,
    orientation: "portrait",
    expiresAt: 1_000_000_000_000,
  },
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});

const automationCalls: Array<{ readonly operation: string; readonly input: unknown }> = [];

const TestSimulatorManagerLayer = Layer.succeed(
  SimulatorManager.SimulatorManager,
  (() => {
    let session: SimulatorSession | null = null;
    const service: SimulatorManager.SimulatorManager["Service"] = {
      capabilities: Effect.succeed(simulatorCapabilities),
      list: () =>
        Effect.succeed({
          capabilities: simulatorCapabilities,
          devices: [simulatorDevice],
          sessions: session === null ? [] : [session],
        }),
      acquire: (input) =>
        Effect.gen(function* () {
          if (input.udid !== simulatorUdid) {
            return yield* new SimulatorDeviceNotFoundError({ udid: input.udid });
          }
          if (session !== null && session.threadId !== input.threadId) {
            return yield* new SimulatorLeaseNotFoundError({
              threadId: input.threadId,
              leaseId: session.leaseId,
            });
          }
          session ??= makeReadySession(input.threadId);
          return { session };
        }),
      open: () => Effect.succeed({ opened: true }),
      status: (input) =>
        Effect.gen(function* () {
          if (
            input.leaseId !== undefined &&
            (session === null ||
              session.leaseId !== input.leaseId ||
              session.threadId !== input.threadId)
          ) {
            return yield* new SimulatorLeaseNotFoundError({
              threadId: input.threadId,
              leaseId: input.leaseId,
            });
          }
          return {
            capabilities: simulatorCapabilities,
            threadId: input.threadId,
            session: session?.threadId === input.threadId ? session : null,
          };
        }),
      release: (input) =>
        Effect.gen(function* () {
          if (
            session === null ||
            session.leaseId !== input.leaseId ||
            session.threadId !== input.threadId
          ) {
            return yield* new SimulatorLeaseNotFoundError({
              threadId: input.threadId,
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
          session = null;
          return { released: true, leaseId: input.leaseId, generation: input.generation };
        }),
      releaseThread: (thread) =>
        Effect.sync(() => {
          if (session?.threadId === thread) session = null;
        }),
      sendInput: () => Effect.succeed({ accepted: true }),
      resolveStream: () => Effect.succeed(null),
      events: Stream.empty,
      subscribeEvents: Effect.die("unused in MCP registration tests"),
    };
    return service;
  })(),
);

const TestSimulatorAutomationLayer = Layer.succeed(
  SimulatorAutomation.SimulatorAutomation,
  SimulatorAutomation.SimulatorAutomation.of({
    buildRun: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "buildRun", input });
        return { built: true };
      }),
    launch: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "launch", input });
        return { launched: true };
      }),
    stop: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "stop", input });
        return { stopped: true };
      }),
    snapshotUi: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "snapshotUi", input });
        return { elements: [] };
      }),
    screenshot: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "screenshot", input });
        return { path: "/tmp/t3-mcp-simulator.png" };
      }),
    tap: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "tap", input });
        return { tapped: true };
      }),
    typeText: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "typeText", input });
        return { typed: true };
      }),
    waitForUi: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "waitForUi", input });
        return { matched: true };
      }),
    swipe: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "swipe", input });
        return { swiped: true };
      }),
    closeLease: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "closeLease", input });
      }),
    closeSession: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "closeSession", input });
      }),
    closeThread: (thread) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "closeThread", input: thread });
      }),
    closeAll: Effect.void,
  }),
);

const TestProjectionSnapshotQueryLayer = Layer.succeed(
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  {
    getThreadCheckpointContext: (requestedThreadId: ThreadId) =>
      Effect.succeed(
        requestedThreadId === threadId
          ? Option.some({
              threadId,
              projectId: ProjectId.make("project-mcp-test"),
              workspaceRoot,
              worktreePath: null,
              checkpoints: [],
            })
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
);

const TestLayer = McpHttpServer.McpToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provide(TestSimulatorManagerLayer),
  Layer.provide(TestSimulatorAutomationLayer),
  Layer.provide(TestProjectionSnapshotQueryLayer),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const iosCapabilitiesTool = server.tools.find(({ tool }) => tool.name === "ios_capabilities");
      expect(iosCapabilitiesTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(iosCapabilitiesTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(iosCapabilitiesTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(iosCapabilitiesTool?.tool.description).toContain("agent automation readiness");

      const iosListTool = server.tools.find(({ tool }) => tool.name === "ios_list_simulators");
      expect(iosListTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(iosListTool?.tool.annotations?.idempotentHint).toBe(true);

      const iosOpenTool = server.tools.find(({ tool }) => tool.name === "ios_session_open");
      expect(iosOpenTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(iosOpenTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(iosOpenTool?.tool.description).toContain("exact iOS Simulator UDID");

      const iosStatusTool = server.tools.find(({ tool }) => tool.name === "ios_session_status");
      expect(iosStatusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(iosStatusTool?.tool.annotations?.idempotentHint).toBe(true);

      const iosCloseTool = server.tools.find(({ tool }) => tool.name === "ios_session_close");
      expect(iosCloseTool?.tool.annotations?.destructiveHint).toBe(false);

      const iosAutomationTools = [
        "ios_build_run",
        "ios_launch_app",
        "ios_stop_app",
        "ios_snapshot_ui",
        "ios_screenshot",
        "ios_tap",
        "ios_type_text",
        "ios_wait_for_ui",
        "ios_swipe",
      ];
      for (const name of iosAutomationTools) {
        const tool = server.tools.find(({ tool }) => tool.name === name);
        expect(tool).toBeDefined();
        expect(tool?.tool.annotations?.destructiveHint).toBe(
          name === "ios_snapshot_ui" || name === "ios_screenshot" || name === "ios_wait_for_ui"
            ? false
            : true,
        );
      }
      expect(server.tools.find(({ tool }) => tool.name === "ios_tap")?.tool.description).toContain(
        "never accepts coordinates",
      );

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);

      const iosCapabilities = yield* server
        .callTool({ name: "ios_capabilities", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(iosCapabilities.isError).toBe(false);
      expect(iosCapabilities.structuredContent).toMatchObject({
        host: { os: "darwin", arch: "arm64" },
        platformSupported: true,
        executionReady: true,
        deviceEnumeration: true,
        liveStreaming: true,
        humanInput: true,
        agentAutomation: true,
        maxActive: 1,
        reason: null,
      });
      expect(
        (iosCapabilities.structuredContent as Record<string, unknown>).controlPlaneOnly,
      ).toBeUndefined();

      const iosList = yield* server
        .callTool({ name: "ios_list_simulators", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(iosList.isError).toBe(false);
      expect(iosList.structuredContent).toMatchObject({
        capabilities: { executionReady: true, agentAutomation: true },
        devices: [simulatorDevice],
        sessions: [],
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps iOS simulator leases scoped to the authenticated invocation thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const alternateInvocation = {
        ...invocation,
        threadId: ThreadId.make("thread-mcp-alternate"),
      };
      const call = (name: string, args: Record<string, unknown>, scope = invocation) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const opened = yield* call("ios_session_open", { udid: simulatorUdid });
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as { readonly session: SimulatorSession };
      expect(openedContent.session.state).toBe("ready");
      expect(openedContent.session.threadId).toBe(invocation.threadId);
      expect(openedContent.session.udid).toBe(simulatorUdid);
      expect(openedContent.session.generation).toBe(1);

      const status = yield* call("ios_session_status", {});
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        threadId: invocation.threadId,
        session: { leaseId: openedContent.session.leaseId },
      });

      const crossThreadStatus = yield* call(
        "ios_session_status",
        { leaseId: openedContent.session.leaseId },
        alternateInvocation,
      );
      expect(crossThreadStatus.isError).toBe(true);

      const crossThreadClose = yield* call(
        "ios_session_close",
        {
          leaseId: openedContent.session.leaseId,
          generation: openedContent.session.generation,
        },
        alternateInvocation,
      );
      expect(crossThreadClose.isError).toBe(true);

      const stillOwned = yield* call("ios_session_status", {});
      expect(stillOwned.isError).toBe(false);
      expect(stillOwned.structuredContent).toMatchObject({
        session: { leaseId: openedContent.session.leaseId },
      });

      const staleClose = yield* call("ios_session_close", {
        leaseId: openedContent.session.leaseId,
        generation: openedContent.session.generation + 1,
      });
      expect(staleClose.isError).toBe(true);

      const tap = yield* call("ios_tap", {
        leaseId: openedContent.session.leaseId,
        generation: openedContent.session.generation,
        elementRef: "button:continue",
      });
      expect(tap.isError).toBe(false);
      expect(tap.structuredContent).toMatchObject({ tapped: true });
      const tapCall = automationCalls.find((call) => call.operation === "tap");
      expect(tapCall).toBeDefined();
      expect(tapCall?.input).toMatchObject({
        session: {
          threadId: invocation.threadId,
          leaseId: openedContent.session.leaseId,
          udid: simulatorUdid,
          generation: openedContent.session.generation,
        },
        cwd: workspaceRoot,
        elementRef: "button:continue",
      });
      const tapInput = tapCall?.input as { readonly x?: unknown; readonly y?: unknown };
      expect(tapInput.x).toBeUndefined();
      expect(tapInput.y).toBeUndefined();

      const closed = yield* call("ios_session_close", {
        leaseId: openedContent.session.leaseId,
        generation: openedContent.session.generation,
      });
      expect(closed.isError).toBe(false);
      expect(closed.structuredContent).toMatchObject({
        released: true,
        leaseId: openedContent.session.leaseId,
        generation: openedContent.session.generation,
      });
      const closeCall = automationCalls.find((call) => call.operation === "closeSession");
      expect(closeCall?.input).toMatchObject({
        threadId: invocation.threadId,
        udid: simulatorUdid,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);
