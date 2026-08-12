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

const makeTestRuntime = (
  options: {
    readonly initialSession?: SimulatorSession | null;
    readonly installLaunchFails?: boolean;
  } = {},
) => {
  const automationCalls: Array<{ readonly operation: string; readonly input: unknown }> = [];
  const managerCalls: Array<{ readonly operation: string; readonly input: unknown }> = [];
  const operationOrder: Array<string> = [];
  let session: SimulatorSession | null = options.initialSession ?? null;

  const simulatorManagerLayer = Layer.mock(SimulatorManager.SimulatorManager)({
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
    acquireReady: (input) =>
      Effect.gen(function* () {
        managerCalls.push({ operation: "acquireReady", input });
        operationOrder.push("acquireReady");
        if (input.udid !== simulatorUdid) {
          return yield* new SimulatorDeviceNotFoundError({ udid: input.udid });
        }
        if (session !== null && session.threadId !== input.threadId) {
          return yield* new SimulatorLeaseNotFoundError({
            threadId: input.threadId,
            leaseId: session.leaseId,
          });
        }
        const acquiredByCall = session === null;
        session ??= makeReadySession(input.threadId);
        return { session, acquiredByCall };
      }),
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
        managerCalls.push({ operation: "release", input });
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
  });

  const simulatorAutomationLayer = Layer.mock(SimulatorAutomation.SimulatorAutomation)({
    prepareBuild: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "prepareBuild", input });
        operationOrder.push("prepareBuild");
        return {
          appPath: `${workspaceRoot}/.t3/DerivedData/McpApp.app`,
          bundleId: "codes.t3.mcp-test",
          derivedDataPath: `${workspaceRoot}/.t3/DerivedData`,
        };
      }),
    installLaunch: (input) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          automationCalls.push({ operation: "installLaunch", input });
          operationOrder.push("installLaunch");
        });
        if (options.installLaunchFails) {
          return yield* new SimulatorAutomation.SimulatorAutomationToolError({
            operation: "install-launch",
            code: "test-failure",
            detail: "simulated install failure",
          });
        }
        return { install: { installed: true }, launch: { launched: true } };
      }),
    tap: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "tap", input });
        return { tapped: true };
      }),
    closeSession: (input) =>
      Effect.sync(() => {
        automationCalls.push({ operation: "closeSession", input });
      }),
  });

  const projectionSnapshotQueryLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getThreadCheckpointContext: (requestedThreadId) =>
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
  });

  return {
    automationCalls,
    managerCalls,
    operationOrder,
    layer: McpHttpServer.McpToolkitRegistrationLive.pipe(
      // These are read by the test body; retain them while keeping the
      // simulator fakes private to each runtime.
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
      Layer.provide(simulatorManagerLayer),
      Layer.provide(simulatorAutomationLayer),
      Layer.provide(projectionSnapshotQueryLayer),
    ),
  };
};

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

it.effect("returns bounded structural preview snapshot failures", () => {
  const runtime = makeTestRuntime();
  return Effect.scoped(
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
  ).pipe(Effect.provide(runtime.layer));
});

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

it.effect("registers annotated tools and preserves authenticated request context", () => {
  const runtime = makeTestRuntime();
  return Effect.scoped(
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

      expect(server.tools.find(({ tool }) => tool.name === "ios_session_open")).toBeUndefined();

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
      const iosToolNames = [
        "ios_capabilities",
        "ios_list_simulators",
        "ios_session_status",
        "ios_session_close",
        ...iosAutomationTools,
      ];
      for (const name of iosToolNames) {
        expect(
          server.tools.find(({ tool }) => tool.name === name)?.tool.outputSchema,
        ).toMatchObject({
          type: "object",
        });
      }
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
  ).pipe(Effect.provide(runtime.layer));
});

it.effect("builds before acquiring a thread-scoped ready iOS simulator session", () => {
  const runtime = makeTestRuntime();
  return Effect.scoped(
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

      const buildRun = yield* call("ios_build_run", {
        udid: simulatorUdid,
        projectPath: "McpApp.xcodeproj",
        scheme: "McpApp",
        configuration: "Debug",
        launchArgs: ["-uiTesting"],
        env: { MCP_TEST: "1" },
      });
      expect(buildRun.isError).toBe(false);
      const buildRunContent = buildRun.structuredContent as {
        readonly session: SimulatorSession;
        readonly appPath: string;
        readonly bundleId: string;
        readonly results: { readonly install: unknown; readonly launch: unknown };
      };
      expect(buildRunContent).toMatchObject({
        session: {
          state: "ready",
          threadId: invocation.threadId,
          udid: simulatorUdid,
          generation: 1,
        },
        appPath: `${workspaceRoot}/.t3/DerivedData/McpApp.app`,
        bundleId: "codes.t3.mcp-test",
        results: { install: { installed: true }, launch: { launched: true } },
      });
      expect(runtime.operationOrder).toEqual(["prepareBuild", "acquireReady", "installLaunch"]);

      const prepareBuildCall = runtime.automationCalls.find(
        (call) => call.operation === "prepareBuild",
      );
      expect(prepareBuildCall?.input).toMatchObject({
        cwd: workspaceRoot,
        udid: simulatorUdid,
        projectPath: "McpApp.xcodeproj",
        scheme: "McpApp",
        configuration: "Debug",
      });
      const installLaunchCall = runtime.automationCalls.find(
        (call) => call.operation === "installLaunch",
      );
      expect(installLaunchCall?.input).toMatchObject({
        session: buildRunContent.session,
        cwd: workspaceRoot,
        preparedBuild: {
          appPath: buildRunContent.appPath,
          bundleId: buildRunContent.bundleId,
        },
        launchArgs: ["-uiTesting"],
        env: { MCP_TEST: "1" },
      });

      const status = yield* call("ios_session_status", {});
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        threadId: invocation.threadId,
        session: { leaseId: buildRunContent.session.leaseId },
      });

      const crossThreadStatus = yield* call(
        "ios_session_status",
        { leaseId: buildRunContent.session.leaseId },
        alternateInvocation,
      );
      expect(crossThreadStatus.isError).toBe(true);

      const crossThreadClose = yield* call(
        "ios_session_close",
        {
          leaseId: buildRunContent.session.leaseId,
          generation: buildRunContent.session.generation,
        },
        alternateInvocation,
      );
      expect(crossThreadClose.isError).toBe(true);

      const staleClose = yield* call("ios_session_close", {
        leaseId: buildRunContent.session.leaseId,
        generation: buildRunContent.session.generation + 1,
      });
      expect(staleClose.isError).toBe(true);

      const tap = yield* call("ios_tap", {
        leaseId: buildRunContent.session.leaseId,
        generation: buildRunContent.session.generation,
        elementRef: "button:continue",
      });
      expect(tap.isError).toBe(false);
      expect(tap.structuredContent).toMatchObject({ tapped: true });
      const tapCall = runtime.automationCalls.find((call) => call.operation === "tap");
      expect(tapCall?.input).toMatchObject({
        session: {
          threadId: invocation.threadId,
          leaseId: buildRunContent.session.leaseId,
          udid: simulatorUdid,
          generation: buildRunContent.session.generation,
        },
        cwd: workspaceRoot,
        elementRef: "button:continue",
      });
      const tapInput = tapCall?.input as { readonly x?: unknown; readonly y?: unknown };
      expect(tapInput.x).toBeUndefined();
      expect(tapInput.y).toBeUndefined();

      const closed = yield* call("ios_session_close", {
        leaseId: buildRunContent.session.leaseId,
        generation: buildRunContent.session.generation,
      });
      expect(closed.isError).toBe(false);
      expect(closed.structuredContent).toMatchObject({
        released: true,
        leaseId: buildRunContent.session.leaseId,
        generation: buildRunContent.session.generation,
      });
      const closeCall = runtime.automationCalls.find((call) => call.operation === "closeSession");
      expect(closeCall?.input).toMatchObject({
        threadId: invocation.threadId,
        udid: simulatorUdid,
      });
    }),
  ).pipe(Effect.provide(runtime.layer));
});

it.effect("releases only a newly-created iOS session when install or launch fails", () => {
  const createdRuntime = makeTestRuntime({ installLaunchFails: true });
  const manualSession = makeReadySession(threadId);
  const reusedRuntime = makeTestRuntime({
    initialSession: manualSession,
    installLaunchFails: true,
  });

  const assertFailureCleanup = (
    runtime: ReturnType<typeof makeTestRuntime>,
    expectedReleaseCount: number,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (name: string, args: Record<string, unknown>) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );

        const buildRun = yield* call("ios_build_run", { udid: simulatorUdid, scheme: "McpApp" });
        expect(buildRun.isError).toBe(true);
        expect(runtime.managerCalls.filter((call) => call.operation === "release")).toHaveLength(
          expectedReleaseCount,
        );

        const status = yield* call("ios_session_status", {});
        expect(status.isError).toBe(false);
        expect(status.structuredContent).toMatchObject({
          session: expectedReleaseCount === 1 ? null : { leaseId: manualSession.leaseId },
        });
      }),
    ).pipe(Effect.provide(runtime.layer));

  return Effect.gen(function* () {
    yield* assertFailureCleanup(createdRuntime, 1);
    yield* assertFailureCleanup(reusedRuntime, 0);
  });
});
