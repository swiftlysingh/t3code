import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SimulatorAcquireResult,
  SimulatorCapabilities,
  SimulatorEvent,
  SimulatorReleaseResult,
  SimulatorSendInput,
  SimulatorSession,
} from "./simulator.ts";

const decodeCapabilities = Schema.decodeUnknownSync(SimulatorCapabilities);
const decodeSession = Schema.decodeUnknownSync(SimulatorSession);
const decodeAcquireResult = Schema.decodeUnknownSync(SimulatorAcquireResult);
const decodeReleaseResult = Schema.decodeUnknownSync(SimulatorReleaseResult);
const decodeInput = Schema.decodeUnknownSync(SimulatorSendInput);
const decodeEvent = Schema.decodeUnknownSync(SimulatorEvent);

const timestamp = "2026-01-01T00:00:00.000Z";

const session = {
  leaseId: "sim-lease-1",
  threadId: "thread-1",
  udid: "A1B2C3",
  generation: 1,
  state: "ready" as const,
  media: {
    streamUrl: "/api/simulator/token/stream.mjpeg",
    width: 1179,
    height: 2556,
    orientation: "portrait" as const,
    expiresAt: 1_800_000_000_000,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("SimulatorCapabilities", () => {
  it("advertises the complete supported execution surface", () => {
    expect(
      decodeCapabilities({
        host: { os: "darwin", arch: "arm64" },
        platformSupported: true,
        executionReady: true,
        deviceEnumeration: true,
        liveStreaming: true,
        humanInput: true,
        agentAutomation: true,
        maxActive: 1,
        reason: null,
      }),
    ).toMatchObject({
      platformSupported: true,
      executionReady: true,
      deviceEnumeration: true,
      liveStreaming: true,
      humanInput: true,
      agentAutomation: true,
    });
  });

  it("represents unsupported hosts without claiming execution", () => {
    expect(
      decodeCapabilities({
        host: { os: "linux", arch: "x64" },
        platformSupported: false,
        executionReady: false,
        deviceEnumeration: false,
        liveStreaming: false,
        humanInput: false,
        agentAutomation: false,
        maxActive: 1,
        reason: "unsupported-platform",
      }),
    ).toMatchObject({ platformSupported: false, reason: "unsupported-platform" });
  });
});

describe("SimulatorSession and results", () => {
  it("accepts ready and queued sessions", () => {
    expect(decodeSession(session)).toMatchObject({ leaseId: "sim-lease-1", state: "ready" });
    expect(
      decodeSession({ ...session, state: "queued", queuePosition: 1, media: undefined }),
    ).toMatchObject({ state: "queued", queuePosition: 1 });
    expect(
      decodeAcquireResult({
        session: { ...session, state: "starting", media: undefined },
      }),
    ).toMatchObject({ session: { state: "starting" } });
    expect(decodeReleaseResult({ released: true, leaseId: "sim-lease-1", generation: 1 })).toEqual({
      released: true,
      leaseId: "sim-lease-1",
      generation: 1,
    });
  });
});

describe("Simulator input", () => {
  it("accepts normalized touch and rejects out-of-bounds coordinates", () => {
    const base = {
      threadId: "thread-1",
      leaseId: "sim-lease-1",
      generation: 1,
    };
    expect(
      decodeInput({ ...base, event: { type: "touch", phase: "begin", x: 0.5, y: 0.25 } }),
    ).toMatchObject({ event: { type: "touch", x: 0.5, y: 0.25 } });
    expect(() =>
      decodeInput({ ...base, event: { type: "touch", phase: "move", x: 1.1, y: 0.25 } }),
    ).toThrow();
  });
});

describe("SimulatorEvent", () => {
  it("decodes release and session events", () => {
    expect(
      decodeEvent({
        type: "released",
        sequence: 1,
        createdAt: timestamp,
        threadId: "thread-1",
        leaseId: "sim-lease-1",
        generation: 1,
      }),
    ).toMatchObject({ type: "released", sequence: 1 });

    expect(
      decodeEvent({ type: "session", sequence: 2, createdAt: timestamp, session }),
    ).toMatchObject({ type: "session", sequence: 2, session: { udid: "A1B2C3" } });
  });
});
