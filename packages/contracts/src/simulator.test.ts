import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SimulatorAcquireResult,
  SimulatorCapabilities,
  SimulatorEvent,
  SimulatorOpenInput,
  SimulatorOpenResult,
  SimulatorReleaseResult,
  SimulatorSendInput,
  SimulatorSession,
  SimulatorUdid,
} from "./simulator.ts";

const decodeCapabilities = Schema.decodeUnknownSync(SimulatorCapabilities);
const decodeSession = Schema.decodeUnknownSync(SimulatorSession);
const decodeAcquireResult = Schema.decodeUnknownSync(SimulatorAcquireResult);
const decodeReleaseResult = Schema.decodeUnknownSync(SimulatorReleaseResult);
const decodeOpenInput = Schema.decodeUnknownSync(SimulatorOpenInput);
const decodeOpenResult = Schema.decodeUnknownSync(SimulatorOpenResult);
const decodeInput = Schema.decodeUnknownSync(SimulatorSendInput);
const decodeEvent = Schema.decodeUnknownSync(SimulatorEvent);
const decodeUdid = Schema.decodeUnknownSync(SimulatorUdid);

const timestamp = "2026-01-01T00:00:00.000Z";
const simulatorUdid = "A1B2C3D4-E5F6-0000-0000-1D2E3F4A5B6C";

const session = {
  leaseId: "sim-lease-1",
  threadId: "thread-1",
  udid: simulatorUdid,
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

  it("allows zero capacity when execution is unsupported", () => {
    expect(
      decodeCapabilities({
        host: { os: "linux", arch: "x64" },
        platformSupported: false,
        executionReady: false,
        deviceEnumeration: false,
        liveStreaming: false,
        humanInput: false,
        agentAutomation: false,
        maxActive: 0,
        reason: "unsupported-platform",
      }),
    ).toMatchObject({ maxActive: 0 });
    expect(() =>
      decodeCapabilities({
        host: { os: "linux", arch: "x64" },
        platformSupported: false,
        executionReady: false,
        deviceEnumeration: false,
        liveStreaming: false,
        humanInput: false,
        agentAutomation: false,
        maxActive: -1,
        reason: "unsupported-platform",
      }),
    ).toThrow();
  });
});

describe("SimulatorUdid", () => {
  it("accepts CoreSimulator hex UUIDs without RFC version or variant bits", () => {
    expect(decodeUdid(simulatorUdid)).toBe(simulatorUdid);
    expect(decodeUdid("00000000-0000-0000-0000-000000000000")).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
  });

  it("rejects identifiers that are not UUID-shaped", () => {
    expect(() => decodeUdid("A1B2C3")).toThrow();
    expect(() => decodeUdid("A1B2C3D4-E5F6-0000-0000-1D2E3F4A5B6")).toThrow();
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
    expect(
      decodeOpenInput({ threadId: "thread-1", leaseId: "sim-lease-1", generation: 1 }),
    ).toEqual({ threadId: "thread-1", leaseId: "sim-lease-1", generation: 1 });
    expect(decodeOpenResult({ opened: true })).toEqual({ opened: true });
  });

  it("requires a nonnegative integer media expiry", () => {
    expect(decodeSession(session)).toMatchObject({ media: { expiresAt: 1_800_000_000_000 } });
    expect(() =>
      decodeSession({ ...session, media: { ...session.media, expiresAt: -1 } }),
    ).toThrow();
    expect(() =>
      decodeSession({ ...session, media: { ...session.media, expiresAt: 1.5 } }),
    ).toThrow();
    expect(() =>
      decodeSession({ ...session, media: { ...session.media, expiresAt: Number.NaN } }),
    ).toThrow();
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

  it("accepts finite signed scroll deltas in the panel clamp range", () => {
    const base = {
      threadId: "thread-1",
      leaseId: "sim-lease-1",
      generation: 1,
    };
    expect(
      decodeInput({
        ...base,
        event: { type: "scroll", dx: -120, dy: 120, x: 0.5, y: 0.25 },
      }),
    ).toMatchObject({ event: { type: "scroll", dx: -120, dy: 120 } });
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        decodeInput({
          ...base,
          event: { type: "scroll", dx: value, dy: 0, x: 0.5, y: 0.25 },
        }),
      ).toThrow();
    }
    for (const value of [-120.1, 120.1]) {
      expect(() =>
        decodeInput({
          ...base,
          event: { type: "scroll", dx: value, dy: 0, x: 0.5, y: 0.25 },
        }),
      ).toThrow();
    }
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
    ).toMatchObject({ type: "session", sequence: 2, session: { udid: simulatorUdid } });
  });
});
