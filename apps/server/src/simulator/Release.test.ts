import {
  SimulatorLeaseId,
  SimulatorUdid,
  ThreadId,
  type SimulatorCapabilities,
  type SimulatorSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import * as SimulatorAutomation from "./Automation.ts";
import * as SimulatorManager from "./Manager.ts";
import { releaseSimulatorLeaseAfterAutomationClose } from "./Release.ts";

const threadId = ThreadId.make("thread-simulator-release");
const leaseId = SimulatorLeaseId.make("sim-lease-release");
const input = { threadId, leaseId, generation: 1 } satisfies Parameters<
  SimulatorManager.SimulatorManager["Service"]["release"]
>[0];
const capabilities: SimulatorCapabilities = {
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
const session = {
  leaseId,
  threadId,
  udid: SimulatorUdid.make("11111111-1111-4111-8111-111111111111"),
  generation: 1,
  state: "ready",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
} satisfies SimulatorSession;
type ReleaseManager = Pick<SimulatorManager.SimulatorManager["Service"], "release" | "status">;
type AutomationCloser = Pick<SimulatorAutomation.SimulatorAutomation["Service"], "closeSession">;

describe("releaseSimulatorLeaseAfterAutomationClose", () => {
  it("releases the Manager lease when the automation child close fails", async () => {
    const released: Array<typeof input> = [];
    const manager = {
      status: () => Effect.succeed({ capabilities, threadId, session }),
      release: (releaseInput) =>
        Effect.sync(() => {
          released.push(releaseInput);
          return {
            released: true,
            leaseId: releaseInput.leaseId,
            generation: releaseInput.generation,
          };
        }),
    } satisfies ReleaseManager;
    const automation = {
      closeSession: () =>
        new SimulatorAutomation.SimulatorAutomationToolError({
          operation: "close",
          code: "test-close-failed",
          detail: "test close failure",
        }),
    } satisfies AutomationCloser;

    const result = await Effect.runPromise(
      releaseSimulatorLeaseAfterAutomationClose(manager, automation, input),
    );

    expect(result).toEqual({ released: true, leaseId, generation: 1 });
    expect(released).toEqual([input]);
  });

  it("defers an absent session to Manager.release without closing automation", async () => {
    let closeCalls = 0;
    const manager = {
      status: () => Effect.succeed({ capabilities, threadId, session: null }),
      release: (releaseInput) =>
        Effect.succeed({
          released: true,
          leaseId: releaseInput.leaseId,
          generation: releaseInput.generation,
        }),
    } satisfies ReleaseManager;
    const automation = {
      closeSession: () =>
        Effect.sync(() => {
          closeCalls += 1;
        }),
    } satisfies AutomationCloser;

    await Effect.runPromise(releaseSimulatorLeaseAfterAutomationClose(manager, automation, input));
    expect(closeCalls).toBe(0);
  });
});
