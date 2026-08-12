import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import * as SimulatorAutomation from "./Automation.ts";
import * as SimulatorManager from "./Manager.ts";

type ReleaseInput = Parameters<SimulatorManager.SimulatorManager["Service"]["release"]>[0];
type ReleaseManager = Pick<SimulatorManager.SimulatorManager["Service"], "release" | "status">;
type AutomationCloser = Pick<SimulatorAutomation.SimulatorAutomation["Service"], "closeSession">;

/** Release Manager-owned locks even when the best-effort automation close fails. */
export const releaseSimulatorLeaseAfterAutomationClose = Effect.fn(
  "SimulatorRelease.releaseAfterAutomationClose",
)(function* (manager: ReleaseManager, automation: AutomationCloser, input: ReleaseInput) {
  const current = yield* manager.status({ threadId: input.threadId });
  const session = current.session;
  if (session?.leaseId !== input.leaseId || session.generation !== input.generation) {
    return yield* manager.release(input);
  }
  return yield* automation.closeSession(session).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      return Effect.logWarning("failed to close simulator automation before lease release", {
        threadId: input.threadId,
        leaseId: input.leaseId,
        cause: Cause.pretty(cause),
      });
    }),
    Effect.onError(() =>
      manager.release(input).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to release simulator lease after automation close", {
            threadId: input.threadId,
            leaseId: input.leaseId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
    Effect.andThen(manager.release(input)),
  );
});
