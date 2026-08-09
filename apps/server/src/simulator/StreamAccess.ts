import {
  EnvironmentId,
  PositiveInt,
  SimulatorLeaseId,
  SimulatorUdid,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

export const SIMULATOR_STREAM_ROUTE_PREFIX = "/api/simulator";
export const SIMULATOR_STREAM_SIGNING_SECRET_NAME = "simulator-stream-signing-key";
export const SIMULATOR_STREAM_TOKEN_TTL_MS = 60 * 1000;

/**
 * The binding is deliberately exact. A stream capability cannot be moved to
 * another T3 environment, thread, lease, simulator, or lease generation.
 */
export const SimulatorStreamClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  leaseId: SimulatorLeaseId,
  udid: SimulatorUdid,
  generation: PositiveInt,
  expiresAt: Schema.Number,
});
export type SimulatorStreamClaims = typeof SimulatorStreamClaimsSchema.Type;

export type SimulatorStreamBinding = Omit<SimulatorStreamClaims, "version" | "expiresAt">;

const SimulatorStreamClaimsJson = Schema.fromJsonString(SimulatorStreamClaimsSchema);
const decodeSimulatorStreamClaims = Schema.decodeUnknownOption(SimulatorStreamClaimsJson);
const encodeSimulatorStreamClaims = Schema.encodeSync(SimulatorStreamClaimsJson);

const isBase64UrlSegment = (value: string): boolean =>
  value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);

const decodeClaims = (encodedPayload: string): SimulatorStreamClaims | null => {
  try {
    return Option.getOrNull(decodeSimulatorStreamClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
};

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIMULATOR_STREAM_SIGNING_SECRET_NAME, 32);
});

export const issueSimulatorStreamUrl = Effect.fn("SimulatorStreamAccess.issueUrl")(function* (
  binding: SimulatorStreamBinding,
) {
  const expiresAt = (yield* Clock.currentTimeMillis) + SIMULATOR_STREAM_TOKEN_TTL_MS;
  const claims: SimulatorStreamClaims = {
    version: 1,
    ...binding,
    expiresAt,
  };
  const encodedPayload = base64UrlEncode(encodeSimulatorStreamClaims(claims));
  const signingSecret = yield* loadSigningSecret;
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;

  return {
    relativeUrl: `${SIMULATOR_STREAM_ROUTE_PREFIX}/${token}/stream.mjpeg`,
    expiresAt,
  };
});

/**
 * Resolve a stream token without granting any request credentials. Callers
 * must still compare the returned binding with the live lease before serving
 * a frame; the generation field makes that check safe across lease reuse.
 */
export const resolveSimulatorStream = Effect.fn("SimulatorStreamAccess.resolve")(function* (
  token: string,
) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (encodedPayload === undefined || signature === undefined) return null;
  // SHA-256 HMACs are always 43 unpadded base64url characters. Checking the
  // alphabet before decoding avoids Buffer's permissive base64 handling.
  if (
    !isBase64UrlSegment(encodedPayload) ||
    signature.length !== 43 ||
    !isBase64UrlSegment(signature)
  ) {
    return null;
  }

  const signingSecret = yield* loadSigningSecret.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Simulator stream signing key unavailable.").pipe(
        Effect.annotateLogs({ errorTag: error._tag }),
      ),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) {
    return null;
  }

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});

export const matchesSimulatorStreamBinding = (
  claims: SimulatorStreamClaims,
  binding: SimulatorStreamBinding,
): boolean =>
  claims.environmentId === binding.environmentId &&
  claims.threadId === binding.threadId &&
  claims.leaseId === binding.leaseId &&
  claims.udid === binding.udid &&
  claims.generation === binding.generation;
