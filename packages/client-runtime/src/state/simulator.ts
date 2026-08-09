import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Simulator lifecycle commands are serialized per environment/thread. A
 * thread can only have one lease, and serializing acquire/release/status
 * prevents a stale release from racing a follow-up acquire in the client.
 */
export function createSimulatorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const inputScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };

  return {
    capabilities: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:simulator:capabilities",
      tag: WS_METHODS.simulatorCapabilities,
      staleTimeMs: 30_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:simulator:list",
      tag: WS_METHODS.simulatorList,
      staleTimeMs: 5_000,
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:simulator:status",
      tag: WS_METHODS.simulatorStatus,
      staleTimeMs: 1_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:simulator:events",
      tag: WS_METHODS.subscribeSimulatorEvents,
    }),
    acquire: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:simulator:acquire",
      tag: WS_METHODS.simulatorAcquire,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:simulator:release",
      tag: WS_METHODS.simulatorRelease,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    sendInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:simulator:send-input",
      tag: WS_METHODS.simulatorSendInput,
      scheduler: inputScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}
