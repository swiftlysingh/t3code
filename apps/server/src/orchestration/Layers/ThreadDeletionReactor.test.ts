import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import * as SimulatorAutomation from "../../simulator/Automation.ts";
import * as SimulatorManager from "../../simulator/Manager.ts";
import {
  logCleanupCauseUnlessInterrupted,
  releaseThreadAfterAutomationClose,
} from "./ThreadDeletionReactor.ts";

type ThreadSimulatorManager = Pick<SimulatorManager.SimulatorManager["Service"], "releaseThread">;
type ThreadSimulatorAutomationCloser = Pick<
  SimulatorAutomation.SimulatorAutomation["Service"],
  "closeThread"
>;

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });

  it("releases the Manager lease when automation close fails", async () => {
    const released: ThreadId[] = [];
    const closed: ThreadId[] = [];
    const manager = {
      releaseThread: (thread) =>
        Effect.sync(() => {
          released.push(thread);
        }),
    } satisfies ThreadSimulatorManager;
    const automation = {
      closeThread: (thread) =>
        Effect.gen(function* () {
          closed.push(thread);
          return yield* new SimulatorAutomation.SimulatorAutomationToolError({
            operation: "close",
            code: "test-close-failed",
            detail: "test close failure",
          });
        }),
    } satisfies ThreadSimulatorAutomationCloser;

    await Effect.runPromise(releaseThreadAfterAutomationClose(manager, automation, threadId));

    expect(closed).toEqual([threadId]);
    expect(released).toEqual([threadId]);
  });

  it("releases the Manager lease when automation close is interrupted", async () => {
    const released: ThreadId[] = [];
    const manager = {
      releaseThread: (thread) =>
        Effect.sync(() => {
          released.push(thread);
        }),
    } satisfies ThreadSimulatorManager;
    const automation = {
      closeThread: () => Effect.interrupt,
    } satisfies ThreadSimulatorAutomationCloser;

    const exit = await Effect.runPromiseExit(
      releaseThreadAfterAutomationClose(manager, automation, threadId),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(released).toEqual([threadId]);
  });
});
