import type { SimulatorEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as SimulatorManager from "./Manager.ts";
import {
  type SimulatorStreamClaims,
  resolveSimulatorStream,
  SIMULATOR_STREAM_ROUTE_PREFIX,
} from "./StreamAccess.ts";

const STREAM_SUFFIX = "/stream.mjpeg";

const streamEventRevokesClaims = (
  event: SimulatorEvent,
  claims: SimulatorStreamClaims,
): boolean => {
  if (event.type === "released") return event.leaseId === claims.leaseId;
  const { session } = event;
  return (
    session.leaseId === claims.leaseId &&
    (session.state !== "ready" ||
      session.threadId !== claims.threadId ||
      session.udid !== claims.udid ||
      session.generation !== claims.generation)
  );
};

const waitForStreamExpiry = (expiresAt: number) =>
  Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sleep(Math.max(0, expiresAt - now))));

export const guardSimulatorStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  claims: SimulatorStreamClaims,
  events: PubSub.Subscription<SimulatorEvent>,
) =>
  stream.pipe(
    Stream.interruptWhen(
      Effect.raceFirst(
        waitForStreamExpiry(claims.expiresAt),
        Stream.fromSubscription(events).pipe(
          Stream.filter((event) => streamEventRevokesClaims(event, claims)),
          Stream.runHead,
        ),
      ),
    ),
  );

export const simulatorStreamRouteLayer = HttpRouter.add(
  "GET",
  `${SIMULATOR_STREAM_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });

    const routeSuffix = url.value.pathname.slice(`${SIMULATOR_STREAM_ROUTE_PREFIX}/`.length);
    if (!routeSuffix.endsWith(STREAM_SUFFIX)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const token = routeSuffix.slice(0, -STREAM_SUFFIX.length);
    if (token.length === 0 || token.includes("/")) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const claims = yield* resolveSimulatorStream(token);
    if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });

    const manager = yield* SimulatorManager.SimulatorManager;
    // Subscribe before the live lookup so a release between lookup and stream
    // consumption is retained instead of leaving an already-revoked stream open.
    const events = yield* manager.subscribeEvents;
    const stream = yield* manager.resolveStream(claims);
    if (!stream) return HttpServerResponse.text("Not Found", { status: 404 });

    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.get(stream.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.map((response) =>
        HttpServerResponse.stream(guardSimulatorStream(response.stream, claims, events), {
          status: 200,
          headers: {
            "Content-Type": stream.contentType,
            "Cache-Control": "private, no-cache, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        }),
      ),
      Effect.tapError((cause) =>
        Effect.logWarning("Simulator stream proxy failed", {
          leaseId: claims.leaseId,
          udid: claims.udid,
          cause,
        }),
      ),
      Effect.orElseSucceed(() =>
        HttpServerResponse.text("Simulator stream unavailable", { status: 502 }),
      ),
    );
  }),
).pipe(
  // The short-lived bearer capability is embedded in the path because an MJPEG
  // <img> cannot attach an Authorization header. Do not retain it in access logs.
  Layer.provide(HttpRouter.disableLogger),
);
