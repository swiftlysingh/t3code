import { EnvironmentId, SimulatorLeaseId, SimulatorUdid, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  issueSimulatorStreamUrl,
  matchesSimulatorStreamBinding,
  resolveSimulatorStream,
  SIMULATOR_STREAM_ROUTE_PREFIX,
  SIMULATOR_STREAM_TOKEN_TTL_MS,
} from "./StreamAccess.ts";

const secret = new Uint8Array(Array.from({ length: 32 }, (_, index) => (index * 17 + 11) % 256));

const secretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeed(Option.some(secret)),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.succeed(secret),
  remove: () => Effect.void,
});
const testLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore);

const binding = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  leaseId: SimulatorLeaseId.make("lease-1"),
  udid: SimulatorUdid.make("device-1"),
  generation: 3,
} as const;

const extractToken = (relativeUrl: string): string => {
  const prefix = `${SIMULATOR_STREAM_ROUTE_PREFIX}/`;
  expect(relativeUrl.startsWith(prefix)).toBe(true);
  const suffix = relativeUrl.slice(prefix.length);
  expect(suffix.endsWith("/stream.mjpeg")).toBe(true);
  return suffix.slice(0, -"/stream.mjpeg".length);
};

const issue = () =>
  issueSimulatorStreamUrl(binding).pipe(
    Effect.provide(testLayer),
    Effect.map((result) => ({ result, token: extractToken(result.relativeUrl) })),
  );

describe("SimulatorStreamAccess", () => {
  it.effect("issues a short-lived URL with the exact lease binding", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const { result, token } = yield* issue();
      expect(result.expiresAt).toBe(10_000 + SIMULATOR_STREAM_TOKEN_TTL_MS);
      expect(result.relativeUrl).toMatch(
        new RegExp(`^${SIMULATOR_STREAM_ROUTE_PREFIX}/[^/]+/stream\\.mjpeg$`),
      );

      const claims = yield* resolveSimulatorStream(token);
      expect(claims).not.toBeNull();
      expect(claims && { ...claims, expiresAt: undefined }).toEqual({
        version: 1,
        ...binding,
        expiresAt: undefined,
      });
      expect(claims && matchesSimulatorStreamBinding(claims, binding)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a tampered token", () =>
    Effect.gen(function* () {
      const { token } = yield* issue();
      const [payload, signature] = token.split(".");
      if (payload === undefined || signature === undefined) return;
      const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
      expect(yield* resolveSimulatorStream(`${payload}.${tamperedSignature}`)).toBeNull();
      expect(yield* resolveSimulatorStream(`${payload}A.${signature}`)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an expired token", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(20_000);
      const { token } = yield* issue();
      yield* TestClock.adjust(SIMULATOR_STREAM_TOKEN_TTL_MS);
      expect(yield* resolveSimulatorStream(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects malformed token formats", () =>
    Effect.gen(function* () {
      const malformed = [
        "",
        "payload",
        "payload.signature.extra",
        ".signature",
        "payload.",
        "payload=._signature",
        `${"a".repeat(10)}.${"a".repeat(42)}`,
      ];
      for (const token of malformed) {
        expect(yield* resolveSimulatorStream(token)).toBeNull();
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps stream claims bound to the lease generation", () =>
    Effect.gen(function* () {
      const { token } = yield* issue();
      const claims = yield* resolveSimulatorStream(token);
      expect(claims).not.toBeNull();
      if (!claims) return;

      expect(matchesSimulatorStreamBinding(claims, binding)).toBe(true);
      expect(
        matchesSimulatorStreamBinding(claims, {
          ...binding,
          generation: binding.generation + 1,
        }),
      ).toBe(false);
      expect(
        matchesSimulatorStreamBinding(claims, {
          ...binding,
          udid: SimulatorUdid.make("other-device"),
        }),
      ).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});
