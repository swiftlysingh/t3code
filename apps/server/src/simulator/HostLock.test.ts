// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics preferSchemaOverJson:off
import { expect, it } from "@effect/vitest";
import { EnvironmentId, SimulatorLeaseId, SimulatorUdid, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "node:fs/promises";
import * as OperatingSystem from "node:os";
import * as Path from "node:path";

import {
  make,
  SimulatorHostLockContendedError,
  SimulatorHostLockReleaseMismatchError,
  SimulatorHostLockUnknownOwnerError,
  type SimulatorHostLockInput,
  type SimulatorHostLockProcess,
  type SimulatorHostProcessIdentity,
  type SimulatorHostProcessState,
} from "./HostLock.ts";

const udid = SimulatorUdid.make("A1B2C3D4-E5F6-47A8-9012-34567890ABCD");
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

const input = (overrides: Partial<SimulatorHostLockInput> = {}): SimulatorHostLockInput => ({
  udid,
  environmentId,
  threadId,
  leaseId: SimulatorLeaseId.make("lease-1"),
  generation: 1,
  ...overrides,
});

const makeTempRoot = async (): Promise<string> =>
  OperatingSystem.tmpdir().length > 0
    ? FileSystem.mkdtemp(Path.join(OperatingSystem.tmpdir(), "t3-simulator-lock-test-"))
    : FileSystem.mkdtemp("t3-simulator-lock-test-");

const processIdentity = (
  pid: number,
  processStartIdentity: string,
): SimulatorHostProcessIdentity => ({
  pid,
  processStartIdentity,
});

const processApi = (
  currentIdentity: SimulatorHostProcessIdentity,
  states: ReadonlyMap<string, SimulatorHostProcessState>,
): SimulatorHostLockProcess => ({
  current: async () => currentIdentity,
  inspect: async (identity) =>
    states.get(`${identity.pid}:${identity.processStartIdentity}`) ?? "unknown",
});

const runAcquire = async (lock: ReturnType<typeof make>, value: SimulatorHostLockInput = input()) =>
  Effect.runPromise(lock.acquire(value));

it.effect("atomically acquires, records metadata, contends, and releases", () =>
  Effect.promise(async () => {
    const rootDirectory = await makeTempRoot();
    const current = processIdentity(1001, "start-a");
    const lock = make({
      rootDirectory,
      process: processApi(current, new Map([["1001:start-a", "alive"]])),
      randomToken: (() => {
        let count = 0;
        return () => `owner-token-${++count}`;
      })(),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });

    const lease = await runAcquire(lock);
    const metadata = JSON.parse(
      await FileSystem.readFile(Path.join(lease.path, "owner.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      version: 1,
      udid,
      ownerToken: "owner-token-1",
      environmentId,
      threadId,
      leaseId: "lease-1",
      generation: 1,
      pid: 1001,
      processStartIdentity: "start-a",
      createdAt: "2026-08-09T00:00:00.000Z",
      acquiredAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });

    const contender = make({
      rootDirectory,
      process: processApi(processIdentity(1002, "start-b"), new Map([["1001:start-a", "alive"]])),
    });
    const contention = await Effect.runPromise(
      contender.acquire(input({ leaseId: SimulatorLeaseId.make("lease-2") })).pipe(Effect.flip),
    );
    expect(contention).toBeInstanceOf(SimulatorHostLockContendedError);
    expect(contention).toMatchObject({ ownerPid: 1001, ownerProcessStartIdentity: "start-a" });

    await Effect.runPromise(lock.release(lease));
    await expect(
      runAcquire(contender, input({ leaseId: SimulatorLeaseId.make("lease-2") })),
    ).resolves.toMatchObject({
      metadata: { pid: 1002, processStartIdentity: "start-b" },
    });
    await FileSystem.rm(rootDirectory, { recursive: true, force: true });
  }),
);

it.effect("reclaims a lock only when the recorded process is provably dead", () =>
  Effect.promise(async () => {
    const rootDirectory = await makeTempRoot();
    const staleOwner = processIdentity(2001, "start-old");
    const oldLock = make({
      rootDirectory,
      process: processApi(staleOwner, new Map()),
      randomToken: () => "old-owner",
    });
    await runAcquire(oldLock, input({ leaseId: SimulatorLeaseId.make("old-lease") }));

    const replacement = make({
      rootDirectory,
      process: processApi(
        processIdentity(2002, "start-new"),
        new Map([["2001:start-old", "dead"]]),
      ),
      randomToken: () => "new-owner",
    });
    const lease = await runAcquire(
      replacement,
      input({ leaseId: SimulatorLeaseId.make("new-lease") }),
    );
    expect(lease.metadata).toMatchObject({ ownerToken: "new-owner", pid: 2002 });
    await Effect.runPromise(replacement.release(lease));
    await FileSystem.rm(rootDirectory, { recursive: true, force: true });
  }),
);

it.effect("reclaims on a proven PID identity mismatch, protecting against PID reuse", () =>
  Effect.promise(async () => {
    const rootDirectory = await makeTempRoot();
    const oldOwner = make({
      rootDirectory,
      process: processApi(processIdentity(3001, "start-old"), new Map()),
      randomToken: () => "old-owner",
    });
    await runAcquire(oldOwner);

    const replacement = make({
      rootDirectory,
      process: processApi(
        processIdentity(3002, "start-new"),
        new Map([["3001:start-old", "identity-mismatch"]]),
      ),
      randomToken: () => "replacement-owner",
    });
    const lease = await runAcquire(replacement);
    expect(lease.metadata.ownerToken).toBe("replacement-owner");
    await Effect.runPromise(replacement.release(lease));
    await FileSystem.rm(rootDirectory, { recursive: true, force: true });
  }),
);

it.effect("fails closed when owner identity cannot be verified", () =>
  Effect.promise(async () => {
    const rootDirectory = await makeTempRoot();
    const owner = make({
      rootDirectory,
      process: processApi(processIdentity(4001, "start-owner"), new Map()),
      randomToken: () => "owner",
    });
    await runAcquire(owner);

    const contender = make({
      rootDirectory,
      process: processApi(
        processIdentity(4002, "start-contender"),
        new Map([["4001:start-owner", "unknown"]]),
      ),
    });
    const error = await Effect.runPromise(
      contender.acquire(input({ leaseId: SimulatorLeaseId.make("contender") })).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SimulatorHostLockUnknownOwnerError);
    await FileSystem.rm(rootDirectory, { recursive: true, force: true });
  }),
);

it.effect("refuses release when the owner token does not match", () =>
  Effect.promise(async () => {
    const rootDirectory = await makeTempRoot();
    const current = processIdentity(5001, "start-owner");
    const lock = make({
      rootDirectory,
      process: processApi(current, new Map()),
      randomToken: () => "correct-owner",
    });
    const lease = await runAcquire(lock);
    const forgedLease = {
      ...lease,
      metadata: { ...lease.metadata, ownerToken: "wrong-owner" },
    };
    const error = await Effect.runPromise(lock.release(forgedLease).pipe(Effect.flip));
    expect(error).toBeInstanceOf(SimulatorHostLockReleaseMismatchError);
    await expect(
      FileSystem.readFile(Path.join(lease.path, "owner.json"), "utf8"),
    ).resolves.toContain("correct-owner");
    await Effect.runPromise(lock.release(lease));
    await FileSystem.rm(rootDirectory, { recursive: true, force: true });
  }),
);
