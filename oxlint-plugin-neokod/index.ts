import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noAmbientClockInPureLogic from "./rules/no-ambient-clock-in-pure-logic.ts";
import noClientAuthoredServerTimestamp from "./rules/no-client-authored-server-timestamp.ts";
import noFabricatedContractDefault from "./rules/no-fabricated-contract-default.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";

export default definePlugin({
  meta: {
    name: "neokod",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-ambient-clock-in-pure-logic": noAmbientClockInPureLogic,
    "no-client-authored-server-timestamp": noClientAuthoredServerTimestamp,
    "no-fabricated-contract-default": noFabricatedContractDefault,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
  },
});
