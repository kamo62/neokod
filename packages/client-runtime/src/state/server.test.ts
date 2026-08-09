import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
} from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  applyServerConfigProjection,
  projectServerConfig,
  projectServerWelcome,
} from "./server.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: DEFAULT_SERVER_SETTINGS,
} as unknown as ServerConfig;

describe("server state projection", () => {
  it("applies every config category to the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const settings = { ...CONFIG.settings };
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toBe(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("rejects a settings echo older than the projected revision", () => {
    const current = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: {
        ...CONFIG,
        settings: { ...DEFAULT_SERVER_SETTINGS, revision: 2, enableAssistantStreaming: true },
      },
    });
    const [projected, emitted] = projectServerConfig(current, {
      version: 1,
      type: "settingsUpdated",
      payload: {
        settings: { ...DEFAULT_SERVER_SETTINGS, revision: 1, enableAssistantStreaming: false },
      },
    });

    expect(projected).toBe(current);
    expect(emitted).toEqual([]);
    expect(Option.getOrThrow(projected).config.settings.enableAssistantStreaming).toBe(true);
  });

  it("retains welcome when a ready event follows in the same stream chunk", () => {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: "welcome",
      payload: welcome,
    });
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: "ready",
      payload: {},
    });

    expect(Option.getOrThrow(afterReady)).toBe(welcome);
    expect(emitted).toEqual([]);
  });
});
