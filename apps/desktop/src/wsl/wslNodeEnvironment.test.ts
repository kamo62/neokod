import { assert, describe, it } from "@effect/vitest";

import { buildWslNodeEnvScript } from "./wslNodeEnvironment.ts";

describe("buildWslNodeEnvScript", () => {
  it("loads supported version managers and checks the requested Node range", () => {
    const script = buildWslNodeEnvScript("^22.16 || >=24.10");

    assert.include(script, "ensure_wsl_node_path()");
    assert.include(script, "wsl_node_satisfies_engine()");
    assert.include(script, "NEOKOD_NODE_ENGINE_RANGE='^22.16 || >=24.10'");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
  });

  it("leaves the engine check optional when no range is configured", () => {
    const script = buildWslNodeEnvScript();

    assert.include(script, "NEOKOD_NODE_ENGINE_RANGE=''");
  });
});
