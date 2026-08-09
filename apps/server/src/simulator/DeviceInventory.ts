import { SimulatorUdid, type SimulatorDevice } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const SIMCTL_COMMAND = "xcrun";
const SIMCTL_ARGS = ["simctl", "list", "devices", "available", "-j"] as const;
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const HOST_FIELDS = {
  platform: Schema.String,
  architecture: Schema.String,
};

/** The local host shape is intentionally independent of the wire capability schema. */
export interface SimulatorInventoryHost {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
}

export interface SimulatorInventorySupportedSnapshot {
  readonly supported: true;
  readonly host: SimulatorInventoryHost;
  readonly devices: ReadonlyArray<SimulatorDevice>;
}

export interface SimulatorInventoryUnsupportedSnapshot {
  readonly supported: false;
  readonly host: SimulatorInventoryHost;
  readonly devices: ReadonlyArray<SimulatorDevice>;
  readonly reason: "unsupported-platform";
}

export type SimulatorInventorySnapshot =
  | SimulatorInventorySupportedSnapshot
  | SimulatorInventoryUnsupportedSnapshot;

export interface SimulatorInventoryLookup {
  readonly supported: boolean;
  readonly device: SimulatorDevice | undefined;
}

export interface SimulatorInventoryRunnerInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface SimulatorInventoryRunnerOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

/**
 * A narrow runner boundary keeps CoreSimulator discovery easy to test without
 * spawning a process, while the production layer adapts the shared runner.
 */
export interface SimulatorInventoryRunner {
  readonly run: (
    input: SimulatorInventoryRunnerInput,
  ) => Effect.Effect<SimulatorInventoryRunnerOutput, SimulatorInventoryCommandError>;
}

export class SimulatorInventoryCommandError extends Schema.TaggedErrorClass<SimulatorInventoryCommandError>()(
  "SimulatorInventoryCommandError",
  {
    ...HOST_FIELDS,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    code: Schema.NullOr(Schema.Number),
    stderr: Schema.String,
    timedOut: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.timedOut) {
      return `${this.command} simctl discovery timed out after ${DEFAULT_LIST_TIMEOUT_MS}ms.`;
    }
    return this.stderr.trim().length > 0
      ? `CoreSimulator discovery failed: ${this.stderr.trim()}`
      : `CoreSimulator discovery exited with code ${this.code ?? "unknown"}.`;
  }
}

export class SimulatorInventoryParseError extends Schema.TaggedErrorClass<SimulatorInventoryParseError>()(
  "SimulatorInventoryParseError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `CoreSimulator returned invalid device JSON: ${this.reason}`;
  }
}

export class SimulatorInventoryInvalidUdidError extends Schema.TaggedErrorClass<SimulatorInventoryInvalidUdidError>()(
  "SimulatorInventoryInvalidUdidError",
  {
    udid: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Simulator UDID '${this.udid}'.`;
  }
}

export const SimulatorInventoryError = Schema.Union([
  SimulatorInventoryCommandError,
  SimulatorInventoryParseError,
  SimulatorInventoryInvalidUdidError,
]);
export type SimulatorInventoryError = typeof SimulatorInventoryError.Type;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const simulatorUdidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isSimulatorUdid = (value: string): boolean => simulatorUdidPattern.test(value);

const normalizeDeviceState = (value: unknown): SimulatorDevice["state"] => {
  if (typeof value !== "string") return "unknown";
  switch (value.trim().toLowerCase()) {
    case "booted":
      return "booted";
    case "shutdown":
      return "shutdown";
    default:
      return "unknown";
  }
};

const runtimeIsIos = (runtime: string): boolean => {
  const normalized = runtime.trim();
  if (normalized.length === 0) return false;
  if (/(?:watchos|tvos|visionos)/i.test(normalized)) return false;
  return /(?:^|[._-])ios(?:$|[ ._-])/i.test(normalized);
};

/**
 * Converts CoreSimulator's identifier into a stable display value while
 * preserving unknown identifiers verbatim. For example,
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-4` becomes `iOS 26.4`.
 */
export const normalizeRuntimeName = (runtime: string): string => {
  const normalized = runtime.trim();
  const match = normalized.match(/(?:^|[._-])iOS[- ._](\d+)[- ._](\d+)(?:[- ._](\d+))?/i);
  if (!match) return normalized;
  const [, major, minor, patch] = match;
  return `iOS ${major}.${minor}${patch === undefined ? "" : `.${patch}`}`;
};

const unavailableEntry = (entry: Record<string, unknown>): boolean => {
  if (entry.isAvailable === false) return true;
  return (
    typeof entry.availability === "string" &&
    /unavailable|not found|error/i.test(entry.availability)
  );
};

const sortDevices = (devices: ReadonlyArray<SimulatorDevice>): ReadonlyArray<SimulatorDevice> =>
  devices.toSorted((left, right) => {
    const stateRank = (state: SimulatorDevice["state"]): number => (state === "booted" ? 0 : 1);
    const stateDifference = stateRank(left.state) - stateRank(right.state);
    if (stateDifference !== 0) return stateDifference;
    const runtimeDifference =
      left.runtime < right.runtime ? -1 : left.runtime > right.runtime ? 1 : 0;
    if (runtimeDifference !== 0) return runtimeDifference;
    const nameDifference = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    if (nameDifference !== 0) return nameDifference;
    return left.udid < right.udid ? -1 : left.udid > right.udid ? 1 : 0;
  });

/**
 * Parse the exact JSON shape emitted by `xcrun simctl list devices available -j`.
 * Invalid individual device rows are ignored; malformed top-level JSON is an
 * error so callers never mistake an empty inventory for a successful probe.
 */
export const parseSimctlDevices = (raw: string): ReadonlyArray<SimulatorDevice> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
  } catch (cause) {
    throw new SimulatorInventoryParseError({
      reason: "JSON parsing failed",
      cause,
    });
  }

  if (!isRecord(decoded) || !isRecord(decoded.devices)) {
    throw new SimulatorInventoryParseError({
      reason: "the response did not contain a devices object",
    });
  }

  const devices: SimulatorDevice[] = [];
  for (const [runtimeIdentifier, rows] of Object.entries(decoded.devices)) {
    if (!runtimeIsIos(runtimeIdentifier) || !Array.isArray(rows)) continue;
    const runtime = normalizeRuntimeName(runtimeIdentifier);
    for (const row of rows) {
      if (!isRecord(row) || unavailableEntry(row)) continue;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const udid = typeof row.udid === "string" ? row.udid.trim() : "";
      if (name.length === 0 || !isSimulatorUdid(udid)) continue;
      devices.push({
        udid: SimulatorUdid.make(udid),
        name,
        runtime,
        state: normalizeDeviceState(row.state),
      });
    }
  }

  return sortDevices(devices);
};

const hostIsSupported = (host: SimulatorInventoryHost): boolean =>
  host.platform === "darwin" && host.architecture === "arm64";

const unsupportedSnapshot = (
  host: SimulatorInventoryHost,
): SimulatorInventoryUnsupportedSnapshot => ({
  supported: false,
  host,
  devices: [],
  reason: "unsupported-platform",
});

const supportedSnapshot = (
  host: SimulatorInventoryHost,
  devices: ReadonlyArray<SimulatorDevice>,
): SimulatorInventorySupportedSnapshot => ({
  supported: true,
  host,
  devices,
});

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";

const commandError = (
  host: SimulatorInventoryHost,
  output: Partial<SimulatorInventoryRunnerOutput> & { readonly cause?: unknown },
): SimulatorInventoryCommandError =>
  new SimulatorInventoryCommandError({
    platform: host.platform,
    architecture: host.architecture,
    command: SIMCTL_COMMAND,
    args: [...SIMCTL_ARGS],
    code: output.code ?? null,
    stderr: output.stderr ?? "",
    timedOut: output.timedOut ?? false,
    ...(output.cause === undefined ? {} : { cause: output.cause }),
  });

const parseDevicesEffect = (
  raw: string,
): Effect.Effect<ReadonlyArray<SimulatorDevice>, SimulatorInventoryParseError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(parseSimctlDevices(raw));
    } catch (cause) {
      return Effect.fail(
        Schema.is(SimulatorInventoryParseError)(cause)
          ? cause
          : new SimulatorInventoryParseError({
              reason: "unexpected parser failure",
              cause,
            }),
      );
    }
  });

const runInventory = (
  runner: SimulatorInventoryRunner,
  host: SimulatorInventoryHost,
): Effect.Effect<SimulatorInventorySnapshot, SimulatorInventoryError> =>
  runner
    .run({
      command: SIMCTL_COMMAND,
      args: [...SIMCTL_ARGS],
      timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    })
    .pipe(
      Effect.mapError((cause) => commandError(host, { cause, stderr: errorMessage(cause) })),
      Effect.flatMap(
        (output): Effect.Effect<SimulatorInventorySnapshot, SimulatorInventoryError> => {
          if (output.timedOut || output.code !== 0) {
            return Effect.fail(commandError(host, output));
          }
          return parseDevicesEffect(output.stdout).pipe(
            Effect.map((devices) => supportedSnapshot(host, devices)),
          );
        },
      ),
    );

export const makeWithRunner = (
  runner: SimulatorInventoryRunner,
  host: SimulatorInventoryHost,
): SimulatorInventory["Service"] => {
  const list: SimulatorInventory["Service"]["list"] = Effect.suspend(() =>
    hostIsSupported(host) ? runInventory(runner, host) : Effect.succeed(unsupportedSnapshot(host)),
  );

  return {
    list,
    find: (udid) => {
      if (!isSimulatorUdid(udid)) {
        return Effect.fail(new SimulatorInventoryInvalidUdidError({ udid }));
      }
      return list.pipe(
        Effect.map((snapshot) => ({
          supported: snapshot.supported,
          device: snapshot.devices.find((device) => device.udid === udid),
        })),
      );
    },
  };
};

export class SimulatorInventory extends Context.Service<
  SimulatorInventory,
  {
    readonly list: Effect.Effect<SimulatorInventorySnapshot, SimulatorInventoryError>;
    readonly find: (
      udid: string,
    ) => Effect.Effect<SimulatorInventoryLookup, SimulatorInventoryError>;
  }
>()("t3/simulator/DeviceInventory/SimulatorInventory") {}

export const make = Effect.gen(function* SimulatorInventoryMake() {
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const host = { platform, architecture } satisfies SimulatorInventoryHost;
  const runner: SimulatorInventoryRunner = {
    run: (input) =>
      processRunner
        .run({
          command: input.command,
          args: input.args,
          timeout: Duration.millis(input.timeoutMs),
          maxOutputBytes: input.maxOutputBytes,
          outputMode: "error",
        })
        .pipe(
          Effect.map((output) => ({
            stdout: output.stdout,
            stderr: output.stderr,
            code: output.code === null ? null : Number(output.code),
            timedOut: output.timedOut,
          })),
          Effect.mapError((cause) =>
            commandError(host, {
              cause,
              stderr: errorMessage(cause),
            }),
          ),
        ),
  };
  return makeWithRunner(runner, host);
});

export const layer = Layer.effect(SimulatorInventory, make);
