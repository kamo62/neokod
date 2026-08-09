import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsMutationId,
  type ServerSettingsMutationAcknowledgement,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectServerSettingsAcknowledgement,
  selectAuthoritativeServerSettings,
} from "./settingsMutation.logic";

function acknowledgement(
  revision: number,
  enableAssistantStreaming: boolean,
): ServerSettingsMutationAcknowledgement {
  return {
    mutationId: ServerSettingsMutationId.make(`settings:test:${revision}`),
    revision,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      revision,
      enableAssistantStreaming,
    },
  };
}

describe("settings mutation projection", () => {
  it("uses an acknowledgement until the settings stream catches up", () => {
    const acknowledged = projectServerSettingsAcknowledgement(null, 1, acknowledgement(2, true));

    expect(
      selectAuthoritativeServerSettings({ ...DEFAULT_SERVER_SETTINGS, revision: 1 }, acknowledged),
    ).toBe(acknowledged.acknowledgement.settings);
    expect(
      selectAuthoritativeServerSettings(
        { ...DEFAULT_SERVER_SETTINGS, revision: 2, enableAssistantStreaming: true },
        acknowledged,
      ).revision,
    ).toBe(2);
  });

  it("ignores stale and out-of-order acknowledgements", () => {
    const current = projectServerSettingsAcknowledgement(null, 2, acknowledgement(2, true));

    expect(projectServerSettingsAcknowledgement(current, 3, acknowledgement(1, false))).toBe(
      current,
    );
    expect(projectServerSettingsAcknowledgement(current, 1, acknowledgement(2, false))).toBe(
      current,
    );
    expect(projectServerSettingsAcknowledgement(current, 3, acknowledgement(3, false))).not.toBe(
      current,
    );
  });
});
