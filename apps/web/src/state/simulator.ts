import { createSimulatorEnvironmentAtoms } from "@t3tools/client-runtime/state/simulator";

import { connectionAtomRuntime } from "../connection/runtime";

export const simulatorEnvironment = createSimulatorEnvironmentAtoms(connectionAtomRuntime);
