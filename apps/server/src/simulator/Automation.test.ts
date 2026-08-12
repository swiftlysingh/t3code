import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SimulatorLeaseId,
  type SimulatorSession,
  SimulatorUdid,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  makeWithOptions,
  type SimulatorAutomationClient,
  type SimulatorAutomationClientFactory,
} from "./Automation.ts";

const udid = SimulatorUdid.make("2CD5E4A0-24C3-4F61-B751-8D0A74EE8A0F");

const makeSession = (overrides: Partial<SimulatorSession> = {}): SimulatorSession => ({
  leaseId: SimulatorLeaseId.make("sim-lease-automation-test"),
  threadId: ThreadId.make("simulator-automation-thread"),
  udid,
  generation: 1,
  state: "ready",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

class FakeClient implements SimulatorAutomationClient {
  readonly calls: Array<{ readonly name: string; readonly input?: unknown }> = [];

  async build(input: Parameters<SimulatorAutomationClient["build"]>[0]): Promise<unknown> {
    this.calls.push({ name: "build", input });
    return { artifacts: { buildLogPath: "/tmp/build.log" } };
  }

  async getSimAppPath(
    input: Parameters<SimulatorAutomationClient["getSimAppPath"]>[0],
  ): Promise<unknown> {
    this.calls.push({ name: "getSimAppPath", input });
    return {
      artifacts: {
        appPath: `${input.derivedDataPath}/Build/Products/Debug-iphonesimulator/App.app`,
      },
    };
  }

  async getAppBundleId(
    input: Parameters<SimulatorAutomationClient["getAppBundleId"]>[0],
  ): Promise<unknown> {
    this.calls.push({ name: "getAppBundleId", input });
    return { artifacts: { appPath: input.appPath, bundleId: "com.example.built" } };
  }

  async install(input: Parameters<SimulatorAutomationClient["install"]>[0]): Promise<unknown> {
    this.calls.push({ name: "install", input });
    return { artifacts: { appPath: input.appPath, simulatorId: udid } };
  }

  async buildRun(input: Parameters<SimulatorAutomationClient["buildRun"]>[0]): Promise<unknown> {
    this.calls.push({ name: "buildRun", input });
    return { artifacts: { bundleId: "com.example.built" } };
  }

  async launch(input: Parameters<SimulatorAutomationClient["launch"]>[0]): Promise<unknown> {
    this.calls.push({ name: "launch", input });
    return {};
  }

  async stop(bundleId: string): Promise<unknown> {
    this.calls.push({ name: "stop", input: bundleId });
    return {};
  }

  async terminate(bundleId: string): Promise<void> {
    this.calls.push({ name: "terminate", input: bundleId });
  }

  async snapshotUi(
    input?: Parameters<SimulatorAutomationClient["snapshotUi"]>[0],
  ): Promise<unknown> {
    this.calls.push({ name: "snapshotUi", input });
    return {};
  }

  async screenshot(
    returnFormat?: Parameters<SimulatorAutomationClient["screenshot"]>[0],
  ): Promise<unknown> {
    this.calls.push({ name: "screenshot", input: returnFormat });
    return {};
  }

  async tap(input: Parameters<SimulatorAutomationClient["tap"]>[0]): Promise<unknown> {
    this.calls.push({ name: "tap", input });
    return {};
  }

  async typeText(input: Parameters<SimulatorAutomationClient["typeText"]>[0]): Promise<unknown> {
    this.calls.push({ name: "typeText", input });
    return {};
  }

  async waitForUi(input: Parameters<SimulatorAutomationClient["waitForUi"]>[0]): Promise<unknown> {
    this.calls.push({ name: "waitForUi", input });
    return {};
  }

  async swipe(input: Parameters<SimulatorAutomationClient["swipe"]>[0]): Promise<unknown> {
    this.calls.push({ name: "swipe", input });
    return {};
  }

  async close(): Promise<void> {
    this.calls.push({ name: "close" });
  }
}

class BlockingBuildClient extends FakeClient {
  readonly buildStarted: Promise<void>;
  readonly releaseBuild: () => void;

  constructor() {
    super();
    let resolveBuildStarted: (() => void) | undefined;
    this.buildStarted = new Promise((resolve) => {
      resolveBuildStarted = resolve;
    });
    let release: (() => void) | undefined;
    const buildReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseBuild = () => release?.();
    this.#resolveBuildStarted = () => resolveBuildStarted?.();
    this.#buildReleased = buildReleased;
  }

  #resolveBuildStarted: () => void;
  #buildReleased: Promise<void>;

  override async buildRun(
    input: Parameters<SimulatorAutomationClient["buildRun"]>[0],
  ): Promise<unknown> {
    this.calls.push({ name: "buildRun", input });
    this.#resolveBuildStarted();
    await this.#buildReleased;
    return { artifacts: { bundleId: "com.example.built" } };
  }
}

class FailingStopClient extends FakeClient {
  override async stop(bundleId: string): Promise<unknown> {
    this.calls.push({ name: "stop", input: bundleId });
    throw new Error("MCP stop failed");
  }
}

class FailingCloseClient extends FakeClient {
  closeAttempts = 0;

  override async close(): Promise<void> {
    this.calls.push({ name: "close" });
    this.closeAttempts += 1;
    if (this.closeAttempts === 1) throw new Error("child close failed");
  }
}

const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-simulator-automation-" });
  const clients: FakeClient[] = [];
  const options: Parameters<SimulatorAutomationClientFactory>[0][] = [];
  const automation = yield* makeWithOptions({
    createClient: (input) => {
      const client = new FakeClient();
      options.push(input);
      clients.push(client);
      return client;
    },
  });
  return { automation, clients, cwd, options };
});

describe("SimulatorAutomation", () => {
  it.effect("builds and validates an app before creating a lease-scoped client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { automation, clients, cwd, options } = yield* makeHarness;
        const projectPath = path.join(cwd, "App.xcodeproj");
        const derivedDataPath = path.join(cwd, ".t3", "simulator", "DerivedData");
        const appPath = path.join(
          derivedDataPath,
          "Build",
          "Products",
          "Debug-iphonesimulator",
          "App.app",
        );
        yield* fileSystem.makeDirectory(projectPath, { recursive: true });
        yield* fileSystem.makeDirectory(appPath, { recursive: true });
        const canonicalAppPath = yield* fileSystem.realPath(appPath);
        const canonicalDerivedDataPath = yield* fileSystem.realPath(derivedDataPath);

        const prepared = yield* automation.prepareBuild({
          cwd,
          udid,
          projectPath: "App.xcodeproj",
          scheme: "App",
        });

        expect(prepared).toEqual({
          appPath: canonicalAppPath,
          bundleId: "com.example.built",
          derivedDataPath: canonicalDerivedDataPath,
        });
        expect(options).toEqual([{ cwd, simulatorId: udid }]);
        expect(clients[0]?.calls.map((call) => call.name)).toEqual([
          "build",
          "getSimAppPath",
          "getAppBundleId",
          "close",
        ]);
        expect(clients[0]?.calls[0]?.input).toMatchObject({
          projectPath,
          scheme: "App",
          derivedDataPath,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("is lazy, reuses one exact-UDID client per lease, and normalizes build paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { automation, clients, cwd, options } = yield* makeHarness;
        const session = makeSession();

        expect(clients).toHaveLength(0);
        yield* automation.buildRun({
          session,
          cwd,
          projectPath: "App.xcodeproj",
          scheme: "App",
        });
        yield* automation.tap({ session, cwd, elementRef: "element-1" });

        expect(clients).toHaveLength(1);
        expect(options).toEqual([{ cwd, simulatorId: udid }]);
        expect(clients[0]?.calls.slice(0, 2)).toMatchObject([
          {
            name: "buildRun",
            input: {
              projectPath: path.join(cwd, "App.xcodeproj"),
              scheme: "App",
              derivedDataPath: path.join(cwd, ".t3", "simulator", "DerivedData"),
            },
          },
          { name: "tap", input: { elementRef: "element-1" } },
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a path traversal before constructing an XcodeBuildMCP client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const result = yield* automation
          .buildRun({
            session: makeSession(),
            cwd,
            projectPath: "../outside/App.xcodeproj",
            scheme: "App",
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(result.failure).toMatchObject({
          _tag: "SimulatorAutomationInputError",
          field: "projectPath",
        });
        expect(clients).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a worktree symlink that canonically resolves outside the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { automation, clients, cwd } = yield* makeHarness;
        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-simulator-automation-outside-",
        });
        const outsideProject = path.join(outside, "Outside.xcodeproj");
        const link = path.join(cwd, "Linked.xcodeproj");
        yield* fileSystem.makeDirectory(outsideProject);
        yield* fileSystem.symlink(outsideProject, link);

        const result = yield* automation
          .buildRun({
            session: makeSession(),
            cwd,
            projectPath: "Linked.xcodeproj",
            scheme: "App",
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(result.failure).toMatchObject({
          _tag: "SimulatorAutomationInputError",
          field: "projectPath",
          reason: "resolves outside the thread worktree",
        });
        expect(clients).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a missing path below a symlinked worktree directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { automation, clients, cwd } = yield* makeHarness;
        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-simulator-automation-outside-",
        });
        const link = path.join(cwd, "DerivedLink");
        yield* fileSystem.symlink(outside, link);

        const result = yield* automation
          .buildRun({
            session: makeSession(),
            cwd,
            projectPath: "App.xcodeproj",
            scheme: "App",
            derivedDataPath: "DerivedLink/Generated/DerivedData",
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(result.failure).toMatchObject({
          _tag: "SimulatorAutomationInputError",
          field: "derivedDataPath",
          reason: "resolves outside the thread worktree",
        });
        expect(clients).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects the default DerivedData path when .t3 is a symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { automation, clients, cwd } = yield* makeHarness;
        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-simulator-automation-outside-",
        });
        yield* fileSystem.symlink(outside, path.join(cwd, ".t3"));

        const result = yield* automation
          .buildRun({
            session: makeSession(),
            cwd,
            projectPath: "App.xcodeproj",
            scheme: "App",
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(result.failure).toMatchObject({
          _tag: "SimulatorAutomationInputError",
          field: "derivedDataPath",
          reason: "resolves outside the thread worktree",
        });
        expect(clients).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fences a stale generation before it reaches the private client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const current = makeSession();
        yield* automation.snapshotUi({ session: current, cwd });

        const result = yield* automation
          .tap({
            session: makeSession({ generation: 2 }),
            cwd,
            elementRef: "element-1",
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(result.failure).toMatchObject({
          _tag: "SimulatorAutomationLeaseError",
          reason: "generation-mismatch",
        });
        expect(clients).toHaveLength(1);
        expect(clients[0]?.calls.map((call) => call.name)).toEqual(["snapshotUi"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drains an in-flight operation before closing and tombstones the lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd } = yield* makeHarness;
        const client = new BlockingBuildClient();
        const automation = yield* makeWithOptions({ createClient: () => client });
        const session = makeSession();
        const buildFiber = yield* automation
          .buildRun({ session, cwd, projectPath: "App.xcodeproj", scheme: "App" })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => client.buildStarted);

        const closeFiber = yield* automation.closeLease({ session, cwd }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const rejected = yield* automation.snapshotUi({ session, cwd }).pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected)) {
          expect(rejected.failure).toMatchObject({
            _tag: "SimulatorAutomationToolError",
            code: "closed",
          });
        }
        expect(client.calls.map((call) => call.name)).toEqual(["buildRun"]);

        client.releaseBuild();
        yield* Fiber.join(buildFiber);
        yield* Fiber.join(closeFiber);
        expect(client.calls.map((call) => call.name)).toEqual(["buildRun", "stop", "close"]);

        const stale = yield* automation.snapshotUi({ session, cwd }).pipe(Effect.result);
        expect(Result.isFailure(stale)).toBe(true);
        if (Result.isFailure(stale)) {
          expect(stale.failure).toMatchObject({
            _tag: "SimulatorAutomationToolError",
            code: "closed",
          });
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fences a lease and thread even when no private client was created", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const session = makeSession();

        yield* automation.closeLease({ session, cwd });
        const closedLease = yield* automation.snapshotUi({ session, cwd }).pipe(Effect.result);
        expect(Result.isFailure(closedLease)).toBe(true);
        expect(clients).toHaveLength(0);

        const otherSession = makeSession({
          leaseId: SimulatorLeaseId.make("sim-lease-automation-thread-close"),
        });
        yield* automation.closeThread(otherSession.threadId);
        const closedThread = yield* automation
          .snapshotUi({
            session: otherSession,
            cwd,
          })
          .pipe(Effect.result);
        expect(Result.isFailure(closedThread)).toBe(true);
        expect(clients).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("closes an exact session without fencing a later lease for the same thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const first = makeSession();

        // A release can race the first automation call. The exact session
        // must be tombstoned even though no client exists yet.
        yield* automation.closeSession(first);
        const stale = yield* automation.snapshotUi({ session: first, cwd }).pipe(Effect.result);
        expect(Result.isFailure(stale)).toBe(true);
        const staleStop = yield* automation.stop({ session: first, cwd }).pipe(Effect.result);
        expect(Result.isFailure(staleStop)).toBe(true);
        if (Result.isFailure(staleStop)) {
          expect(staleStop.failure).toMatchObject({
            _tag: "SimulatorAutomationToolError",
            code: "closed",
          });
        }

        // Releasing one lease must not permanently fence future work for the
        // same thread after Manager grants a new lease.
        const next = makeSession({
          leaseId: SimulatorLeaseId.make("sim-lease-automation-next"),
        });
        yield* automation.snapshotUi({ session: next, cwd });
        expect(clients).toHaveLength(1);
        yield* automation.closeSession(next);
        expect(clients[0]?.calls.map((call) => call.name)).toEqual(["snapshotUi", "close"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a stale session identity without closing the current client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const current = makeSession();
        yield* automation.snapshotUi({ session: current, cwd });

        const stale = yield* automation
          .closeSession(makeSession({ generation: 2 }))
          .pipe(Effect.result);
        expect(Result.isFailure(stale)).toBe(true);
        if (Result.isFailure(stale)) {
          expect(stale.failure).toMatchObject({
            _tag: "SimulatorAutomationLeaseError",
            reason: "generation-mismatch",
          });
        }
        expect(clients[0]?.calls.map((call) => call.name)).toEqual(["snapshotUi"]);

        yield* automation.closeSession(current);
        expect(clients[0]?.calls.map((call) => call.name)).toEqual(["snapshotUi", "close"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not let a stale explicit close rewrite a lease tombstone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const current = makeSession();
        yield* automation.closeLease({ session: current, cwd });

        const stale = yield* automation
          .closeLease({ session: makeSession({ generation: 2 }), cwd })
          .pipe(Effect.result);
        expect(Result.isFailure(stale)).toBe(true);
        if (Result.isFailure(stale)) {
          expect(stale.failure).toMatchObject({
            _tag: "SimulatorAutomationLeaseError",
            reason: "generation-mismatch",
          });
        }
        expect(clients).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops the last launched app before closing an explicit lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { automation, clients, cwd } = yield* makeHarness;
        const session = makeSession();
        yield* automation.launch({ session, cwd, bundleId: "com.example.app" });
        yield* automation.closeLease({ session, cwd });

        expect(clients[0]?.calls.map((call) => call.name)).toEqual(["launch", "stop", "close"]);
        expect(clients[0]?.calls[1]).toEqual({ name: "stop", input: "com.example.app" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses exact-UDID termination when MCP app stop fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-simulator-automation-",
        });
        const client = new FailingStopClient();
        const automation = yield* makeWithOptions({ createClient: () => client });
        const session = makeSession();

        yield* automation.launch({ session, cwd, bundleId: "com.example.app" });
        yield* automation.closeLease({ session, cwd });

        expect(client.calls.map((call) => call.name)).toEqual([
          "launch",
          "stop",
          "terminate",
          "close",
        ]);
        expect(client.calls[2]).toEqual({ name: "terminate", input: "com.example.app" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a failed cleanup lease fenced and retryable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-simulator-automation-",
        });
        const client = new FailingCloseClient();
        const automation = yield* makeWithOptions({ createClient: () => client });
        const session = makeSession();
        yield* automation.launch({ session, cwd, bundleId: "com.example.app" });

        const first = yield* automation.closeLease({ session, cwd }).pipe(Effect.result);
        expect(Result.isFailure(first)).toBe(true);
        if (Result.isFailure(first)) {
          expect(first.failure).toMatchObject({
            _tag: "SimulatorAutomationToolError",
            operation: "close",
          });
        }

        yield* automation.closeLease({ session, cwd });
        expect(client.calls.map((call) => call.name)).toEqual(["launch", "stop", "close", "close"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("runs the same stop-then-close cleanup when its layer scope ends", () =>
    Effect.gen(function* () {
      let calls: ReadonlyArray<{ readonly name: string; readonly input?: unknown }> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { automation, clients, cwd } = yield* makeHarness;
          yield* automation.launch({
            session: makeSession(),
            cwd,
            bundleId: "com.example.app",
          });
          calls = clients[0]?.calls ?? [];
        }),
      );

      expect(calls.map((call) => call.name)).toEqual(["launch", "stop", "close"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
