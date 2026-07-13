import { assert, describe, it } from "vite-plus/test";

import { makeDevelopmentLauncherScript, resolveElectronBinaryPath } from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        NEOKOD_PORT: "16566",
        NEOKOD_HOME: "/tmp/t3",
      },
    });

    assert.include(
      script,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.notInclude(script, "\nexport VITE_DEV_SERVER_URL=");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("prefers Neokod launcher values and reads legacy fallbacks", () => {
    for (const { environment, home, port } of [
      {
        environment: { T3CODE_HOME: "/tmp/legacy-home", T3CODE_PORT: "16566" },
        home: "/tmp/legacy-home",
        port: "16566",
      },
      {
        environment: {
          NEOKOD_HOME: "/tmp/neokod-home",
          T3CODE_HOME: "/tmp/legacy-home",
          NEOKOD_PORT: "16567",
          T3CODE_PORT: "16566",
        },
        home: "/tmp/neokod-home",
        port: "16567",
      },
    ]) {
      const script = makeDevelopmentLauncherScript({
        electronBinaryPath: "/repo/node_modules/electron/Electron",
        mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
        desktopRoot: "/repo/apps/desktop",
        environment,
      });

      assert.include(script, `export NEOKOD_HOME='${home}'`);
      assert.include(script, `export NEOKOD_PORT='${port}'`);
      assert.notInclude(script, "export T3CODE_");
    }
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });
});
