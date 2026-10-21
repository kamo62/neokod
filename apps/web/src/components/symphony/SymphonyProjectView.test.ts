// @effect-diagnostics nodeBuiltinImport:off - Reads component source in a unit test.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const readViewSource = () =>
  NodeFS.readFileSync(new URL("./SymphonyProjectView.tsx", import.meta.url), "utf8");

describe("SymphonyProjectView settings editor identity", () => {
  it("keys the settings editor by project identity so another project remounts its buffers", () => {
    const source = readViewSource();
    const start = source.indexOf("<SettingsTab");
    expect(start).toBeGreaterThan(-1);

    const element = source.slice(start, source.indexOf("/>", start));

    expect(element).toContain("key={project.id}");
    expect(element).not.toContain("revision");
  });
});
