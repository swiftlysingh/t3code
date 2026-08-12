import {
  EnvironmentId,
  SimulatorLeaseId,
  SimulatorUdid,
  ThreadId,
  type SimulatorEvent,
} from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { SimulatorStreamClaims } from "./StreamAccess.ts";
import { guardSimulatorStream } from "./StreamRoute.ts";

const claims = (expiresAt: number) =>
  ({
    version: 1,
    environmentId: EnvironmentId.make("simulator-stream-route-test"),
    threadId: ThreadId.make("simulator-stream-thread"),
    leaseId: SimulatorLeaseId.make("simulator-stream-lease"),
    udid: SimulatorUdid.make("11111111-1111-4111-8111-111111111111"),
    generation: 1,
    expiresAt,
  }) satisfies SimulatorStreamClaims;

const startLiveStream = (
  streamClaims: SimulatorStreamClaims,
  events: PubSub.Subscription<SimulatorEvent>,
) =>
  Effect.gen(function* () {
    const finalized = yield* Deferred.make<void>();
    const fiber = yield* guardSimulatorStream(
      Stream.never.pipe(Stream.ensuring(Deferred.succeed(finalized, undefined))),
      streamClaims,
      events,
    ).pipe(Stream.runDrain, Effect.forkScoped);
    yield* Effect.yieldNow;
    return { fiber, finalized };
  });

describe("guardSimulatorStream", () => {
  it.effect("interrupts a live MJPEG stream when its signed token expires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(10_000);
        const events = yield* PubSub.unbounded<SimulatorEvent>();
        const subscription = yield* PubSub.subscribe(events);
        const live = yield* startLiveStream(claims(11_000), subscription);

        yield* TestClock.adjust(1_000);
        yield* Fiber.join(live.fiber);
        yield* Deferred.await(live.finalized);
      }),
    ),
  );

  it.effect(
    "interrupts a live MJPEG stream when its lease is revoked across a generation change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(10_000);
          const streamClaims = claims(20_000);
          const events = yield* PubSub.unbounded<SimulatorEvent>();
          const subscription = yield* PubSub.subscribe(events);
          const live = yield* startLiveStream(streamClaims, subscription);

          yield* PubSub.publish(events, {
            type: "released",
            sequence: 1,
            createdAt: "2026-08-10T00:00:00.000Z",
            environmentId: streamClaims.environmentId,
            threadId: streamClaims.threadId,
            leaseId: streamClaims.leaseId,
            generation: streamClaims.generation + 1,
          });
          yield* Fiber.join(live.fiber);
          yield* Deferred.await(live.finalized);
        }),
      ),
  );
});
