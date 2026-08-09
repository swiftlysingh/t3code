import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as SimulatorManager from "./Manager.ts";
import { resolveSimulatorStream, SIMULATOR_STREAM_ROUTE_PREFIX } from "./StreamAccess.ts";

const STREAM_SUFFIX = "/stream.mjpeg";

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
    const stream = yield* manager.resolveStream(claims);
    if (!stream) return HttpServerResponse.text("Not Found", { status: 404 });

    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.get(stream.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.map((response) =>
        HttpServerResponse.stream(response.stream, {
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
);
