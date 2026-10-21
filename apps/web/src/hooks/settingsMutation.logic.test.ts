import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironmentVariable,
  ServerSettingsMutationId,
  type ServerSettings,
  type ServerSettingsMutationAcknowledgement,
  type ServerSettingsPatch,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prepareServerSettingsMutation,
  projectServerSettingsAcknowledgement,
  selectAuthoritativeServerSettings,
  type ServerSettingsAcknowledgementProjection,
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

  it("rejects a queued redacted reference after its replacement was acknowledged", () => {
    const environmentId = EnvironmentId.make("environment-test");
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driver = ProviderDriverKind.make("codex");

    const settingsWithEnvironment = (
      revision: number,
      environment: ProviderInstanceEnvironmentVariable[],
    ): ServerSettings => ({
      ...DEFAULT_SERVER_SETTINGS,
      revision,
      providerInstances: {
        [instanceId]: { driver, environment, config: {} },
      },
    });

    let storedEnvironment: ProviderInstanceEnvironmentVariable[] = [
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ];
    let streamedSettings = settingsWithEnvironment(1, storedEnvironment);
    let acknowledgement: ServerSettingsAcknowledgementProjection | null = null;

    const dispatch = (
      requestSequence: number,
      environment: ProviderInstanceEnvironmentVariable[],
    ) => {
      const patch: ServerSettingsPatch = {
        providerInstances: { [instanceId]: { driver, environment, config: {} } },
      };
      const preparation = prepareServerSettingsMutation({
        environmentId,
        requestSequence,
        streamedSettings,
        acknowledgement,
        patch,
      });
      if (preparation.status === "rejected") return preparation;

      // Mirror `persistProviderEnvironmentSecrets`: write replacement values,
      // keep redacted references, then acknowledge the new full environment.
      storedEnvironment = environment.map((variable) =>
        variable.sensitive && (variable.value.length > 0 || variable.valueRedacted === true)
          ? { ...variable, value: "", valueRedacted: true }
          : { ...variable, valueRedacted: false },
      );
      const nextSettings = settingsWithEnvironment(
        preparation.baseSettings.revision + 1,
        storedEnvironment,
      );
      acknowledgement = projectServerSettingsAcknowledgement(acknowledgement, requestSequence, {
        mutationId: preparation.mutationId,
        revision: nextSettings.revision,
        settings: nextSettings,
      });
      return { status: "acknowledged" as const, settings: nextSettings };
    };

    const first = dispatch(1, [
      { name: "OTHER_KEY", value: "replacement", sensitive: true, valueRedacted: false },
    ]);
    expect(first.status).toBe("acknowledged");
    expect(storedEnvironment).toEqual([
      { name: "OTHER_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);

    // The draft still reports the old A while the server has acknowledged B,
    // so the queued update carries a redacted reference A that no longer exists.
    streamedSettings = settingsWithEnvironment(1, [
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
    const stale = dispatch(2, [
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);

    expect(stale.status).toBe("rejected");
    expect(storedEnvironment).toEqual([
      { name: "OTHER_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
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
