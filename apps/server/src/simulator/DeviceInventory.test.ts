import { SimulatorUdid } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as DeviceInventory from "./DeviceInventory.ts";

const bootedUdid = "a0000000-0000-4000-8000-000000000001";
const shutdownUdid = "a0000000-0000-4000-8000-000000000002";
const unknownUdid = "a0000000-0000-4000-8000-000000000003";

const simctlJson = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      {
        state: "Shutdown",
        isAvailable: true,
        name: "iPhone 17 Pro",
        udid: shutdownUdid,
      },
      {
        state: "Booted",
        isAvailable: true,
        name: "iPhone 17",
        udid: bootedUdid,
      },
      {
        state: "Shutdown",
        isAvailable: false,
        name: "Unavailable iPhone",
        udid: "a0000000-0000-4000-8000-000000000004",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      {
        state: "Creating",
        isAvailable: true,
        name: "Old iPhone",
        udid: unknownUdid,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
      {
        state: "Booted",
        isAvailable: true,
        name: "Apple Watch",
        udid: "a0000000-0000-4000-8000-000000000005",
      },
    ],
  },
});

const host = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): DeviceInventory.SimulatorInventoryHost => ({ platform, architecture });

describe("parseSimctlDevices", () => {
  it("flattens available iOS devices and orders booted devices first", () => {
    const devices = DeviceInventory.parseSimctlDevices(simctlJson);

    expect(devices).toEqual([
      {
        udid: SimulatorUdid.make(bootedUdid),
        name: "iPhone 17",
        runtime: "iOS 26.4",
        state: "booted",
      },
      {
        udid: SimulatorUdid.make(unknownUdid),
        name: "Old iPhone",
        runtime: "iOS 18.0",
        state: "unknown",
      },
      {
        udid: SimulatorUdid.make(shutdownUdid),
        name: "iPhone 17 Pro",
        runtime: "iOS 26.4",
        state: "shutdown",
      },
    ]);
  });

  it("rejects malformed top-level JSON", () => {
    expect(() => DeviceInventory.parseSimctlDevices("not-json")).toThrow(
      DeviceInventory.SimulatorInventoryParseError,
    );
  });
});

describe("SimulatorInventory", () => {
  it.effect("looks up an exact UDID without normalizing it", () => {
    let calls = 0;
    const service = DeviceInventory.makeWithRunner(
      {
        run: () => {
          calls += 1;
          return Effect.succeed({
            stdout: simctlJson,
            stderr: "",
            code: 0,
            timedOut: false,
          });
        },
      },
      host("darwin", "arm64"),
    );

    return Effect.gen(function* () {
      const found = yield* service.find(bootedUdid);
      const missing = yield* service.find(bootedUdid.toUpperCase());
      expect(found.supported).toBe(true);
      expect(found.device?.udid).toBe(bootedUdid);
      expect(missing.device).toBeUndefined();
      expect(calls).toBe(2);
    });
  });

  it.effect("returns an explicit unsupported result without spawning", () => {
    let calls = 0;
    const service = DeviceInventory.makeWithRunner(
      {
        run: () => {
          calls += 1;
          return Effect.die(new Error("runner must not be called"));
        },
      },
      host("linux", "x64"),
    );

    return Effect.gen(function* () {
      const result = yield* service.list;
      expect(result).toEqual({
        supported: false,
        host: { platform: "linux", architecture: "x64" },
        devices: [],
        reason: "unsupported-platform",
      });
      expect(calls).toBe(0);
    });
  });

  it.effect("reports command failures through a typed local error", () => {
    const service = DeviceInventory.makeWithRunner(
      {
        run: () =>
          Effect.succeed({
            stdout: "",
            stderr: "xcrun: error: unable to find utility simctl",
            code: 72,
            timedOut: false,
          }),
      },
      host("darwin", "arm64"),
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(service.list);
      assert.instanceOf(error, DeviceInventory.SimulatorInventoryCommandError);
      expect(error.code).toBe(72);
      expect(error.stderr).toContain("simctl");
    });
  });
});
