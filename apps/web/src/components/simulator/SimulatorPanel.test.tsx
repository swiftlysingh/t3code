import type { SimulatorInputEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampSimulatorScrollDelta,
  deriveSimulatorPanelViewState,
  enqueueSimulatorInput,
  fitSimulatorDisplayWidth,
  hidUsageForKeyboardCode,
  mapPointToContainedMedia,
  nextSimulatorOrientation,
  resolveSimulatorStreamUrl,
  stepSimulatorDisplayScale,
  simulatorMediaDimensionsForOrientation,
} from "./SimulatorPanel.helpers";

describe("SimulatorPanel pointer mapping", () => {
  it("normalizes points inside an object-fit contained portrait screen", () => {
    const input = {
      bounds: { left: 10, top: 20, width: 300, height: 300 },
      media: { width: 100, height: 200 },
    };

    expect(mapPointToContainedMedia({ ...input, clientX: 85, clientY: 20 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(mapPointToContainedMedia({ ...input, clientX: 160, clientY: 170 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(mapPointToContainedMedia({ ...input, clientX: 84, clientY: 170 })).toBeNull();
    expect(mapPointToContainedMedia({ ...input, clientX: 236, clientY: 170 })).toBeNull();
  });

  it("rejects invalid dimensions instead of inventing a device coordinate", () => {
    expect(
      mapPointToContainedMedia({
        clientX: 20,
        clientY: 20,
        bounds: { left: 0, top: 0, width: 100, height: 100 },
        media: { width: 0, height: 200 },
      }),
    ).toBeNull();
  });
});

describe("SimulatorPanel keyboard mapping", () => {
  it("forwards only known common USB HID usages", () => {
    expect(hidUsageForKeyboardCode("KeyA")).toBe(0x04);
    expect(hidUsageForKeyboardCode("Digit0")).toBe(0x27);
    expect(hidUsageForKeyboardCode("Enter")).toBe(0x28);
    expect(hidUsageForKeyboardCode("ArrowLeft")).toBe(0x50);
    expect(hidUsageForKeyboardCode("ShiftRight")).toBe(0xe5);
    expect(hidUsageForKeyboardCode("MediaPlayPause")).toBeNull();
  });
});

describe("SimulatorPanel scroll input", () => {
  it("keeps forwarded wheel deltas finite and bounded", () => {
    expect(clampSimulatorScrollDelta(42.5)).toBe(42.5);
    expect(clampSimulatorScrollDelta(10_000)).toBe(120);
    expect(clampSimulatorScrollDelta(-10_000)).toBe(-120);
    expect(clampSimulatorScrollDelta(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampSimulatorScrollDelta(Number.NaN)).toBe(0);
  });

  it("coalesces continuous input without crossing discrete input boundaries", () => {
    const queue: Array<{ event: SimulatorInputEvent; id: number }> = [];
    const replaced: number[] = [];
    const item = (event: SimulatorInputEvent, id: number) => ({
      event,
      id,
    });

    enqueueSimulatorInput(
      queue,
      item({ type: "touch", phase: "move", x: 0.1, y: 0.1 }, 1),
      (entry) => replaced.push(entry.id),
    );
    enqueueSimulatorInput(
      queue,
      item({ type: "touch", phase: "move", x: 0.2, y: 0.2 }, 2),
      (entry) => replaced.push(entry.id),
    );
    enqueueSimulatorInput(
      queue,
      item({ type: "keyboard", phase: "down", usage: 0x04 }, 3),
      (entry) => replaced.push(entry.id),
    );
    enqueueSimulatorInput(
      queue,
      item({ type: "touch", phase: "move", x: 0.3, y: 0.3 }, 4),
      (entry) => replaced.push(entry.id),
    );

    expect(replaced).toEqual([1]);
    expect(queue.map((entry) => entry.id)).toEqual([2, 3, 4]);
  });
});

describe("SimulatorPanel static state and media URLs", () => {
  it.each([
    [
      { queryFailed: false, platformSupported: null, executionReady: null, sessionState: null },
      "loading",
    ],
    [
      { queryFailed: false, platformSupported: false, executionReady: false, sessionState: null },
      "unsupported",
    ],
    [
      { queryFailed: false, platformSupported: true, executionReady: false, sessionState: null },
      "failed",
    ],
    [
      { queryFailed: false, platformSupported: true, executionReady: true, sessionState: null },
      "idle",
    ],
    [
      { queryFailed: false, platformSupported: true, executionReady: true, sessionState: "queued" },
      "queued",
    ],
    [
      {
        queryFailed: false,
        platformSupported: true,
        executionReady: true,
        sessionState: "starting",
      },
      "starting",
    ],
    [
      { queryFailed: false, platformSupported: true, executionReady: true, sessionState: "ready" },
      "ready",
    ],
    [
      { queryFailed: true, platformSupported: true, executionReady: true, sessionState: "ready" },
      "failed",
    ],
  ] as const)("derives %s", (input, expected) => {
    expect(deriveSimulatorPanelViewState(input)).toBe(expected);
  });

  it("uses a signed relative stream capability without exposing session credentials", () => {
    expect(
      resolveSimulatorStreamUrl(
        "https://host.example:3773/",
        "/api/simulator/stream/signed-capability",
      ),
    ).toBe("https://host.example:3773/api/simulator/stream/signed-capability");
    expect(
      resolveSimulatorStreamUrl("https://host.example:3773/", "https://other.example/stream"),
    ).toBeNull();
    expect(
      resolveSimulatorStreamUrl("https://host.example:3773/", "//other.example/stream"),
    ).toBeNull();
  });

  it("rotates through the server's orientation vocabulary", () => {
    expect(nextSimulatorOrientation("portrait", "clockwise")).toBe("landscape_right");
    expect(nextSimulatorOrientation("portrait", "counterclockwise")).toBe("landscape_left");
  });

  it("swaps framebuffer dimensions only when crossing portrait and landscape", () => {
    expect(
      simulatorMediaDimensionsForOrientation({
        width: 1206,
        height: 2622,
        currentOrientation: "portrait",
        nextOrientation: "landscape_right",
      }),
    ).toEqual({ width: 2622, height: 1206 });
    expect(
      simulatorMediaDimensionsForOrientation({
        width: 2622,
        height: 1206,
        currentOrientation: "landscape_right",
        nextOrientation: "landscape_left",
      }),
    ).toEqual({ width: 2622, height: 1206 });
  });
});

describe("SimulatorPanel display scale", () => {
  it("steps through compact sizes and fit mode without exceeding either end", () => {
    expect(stepSimulatorDisplayScale(0.75, "out")).toBe(0.75);
    expect(stepSimulatorDisplayScale(0.75, "in")).toBe(1);
    expect(stepSimulatorDisplayScale(1.5, "in")).toBe(1.5);
    expect(stepSimulatorDisplayScale("fit", "out", 0.95)).toBe(0.75);
    expect(stepSimulatorDisplayScale("fit", "in", 0.95)).toBe(1);
    expect(stepSimulatorDisplayScale("fit", "out", 0.7)).toBe("fit");
    expect(stepSimulatorDisplayScale("fit", "in", 1.6)).toBe("fit");
  });

  it("fits the whole display within both panel width and visible height", () => {
    expect(
      fitSimulatorDisplayWidth({
        availableWidth: 400,
        availableHeight: 600,
        media: { width: 100, height: 200 },
      }),
    ).toBe(300);
    expect(
      fitSimulatorDisplayWidth({
        availableWidth: 400,
        availableHeight: 600,
        media: { width: 200, height: 100 },
      }),
    ).toBe(400);
    expect(
      fitSimulatorDisplayWidth({
        availableWidth: 400,
        availableHeight: 0,
        media: { width: 100, height: 200 },
      }),
    ).toBeNull();
  });
});
