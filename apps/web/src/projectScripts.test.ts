import { describe, expect, it } from "vite-plus/test";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  setupProjectScript,
} from "@neokod/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      NEOKOD_PROJECT_ROOT: "/repo",
      NEOKOD_WORKTREE_PATH: "/repo/worktree-a",
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
    expect(env.NEOKOD_PROJECT_ROOT).toBe(env.T3CODE_PROJECT_ROOT);
    expect(env.NEOKOD_WORKTREE_PATH).toBe(env.T3CODE_WORKTREE_PATH);
  });

  it("preserves reserved runtime env parity over extra values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
      extraEnv: {
        NEOKOD_PROJECT_ROOT: "/custom-root",
        T3CODE_PROJECT_ROOT: "/legacy-custom-root",
        NEOKOD_WORKTREE_PATH: "/custom-worktree",
        T3CODE_WORKTREE_PATH: "/legacy-custom-worktree",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.NEOKOD_PROJECT_ROOT).toBe("/repo");
    expect(env.T3CODE_PROJECT_ROOT).toBe("/repo");
    expect(env.NEOKOD_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(env.T3CODE_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(env.NEOKOD_PROJECT_ROOT).toBe(env.T3CODE_PROJECT_ROOT);
    expect(env.NEOKOD_WORKTREE_PATH).toBe(env.T3CODE_WORKTREE_PATH);
    expect(env.CUSTOM_FLAG).toBe("1");
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });
});
