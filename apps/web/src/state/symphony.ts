import { createSymphonyEnvironmentAtoms } from "@neokod/client-runtime/state/symphony";

import { connectionAtomRuntime } from "../connection/runtime";

export const symphonyEnvironment = createSymphonyEnvironmentAtoms(connectionAtomRuntime);
