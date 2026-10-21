import {
  ProviderInstanceId,
  ServerSettingsMutationId as ServerSettingsMutationIdSchema,
  type EnvironmentId,
  type ServerSettings,
  type ServerSettingsMutationAcknowledgement,
  type ServerSettingsMutationId,
  type ServerSettingsPatch,
} from "@neokod/contracts";

export interface ServerSettingsAcknowledgementProjection {
  readonly requestSequence: number;
  readonly acknowledgement: ServerSettingsMutationAcknowledgement;
}

export interface ServerSettingsMutationPreparationInput {
  readonly environmentId: EnvironmentId;
  readonly requestSequence: number;
  readonly streamedSettings: ServerSettings;
  readonly acknowledgement: ServerSettingsAcknowledgementProjection | null;
  readonly patch: ServerSettingsPatch;
}

export type ServerSettingsMutationPreparation =
  | {
      readonly status: "ready";
      readonly baseSettings: ServerSettings;
      readonly mutationId: ServerSettingsMutationId;
    }
  | {
      readonly status: "rejected";
      readonly baseRevision: number;
      readonly reason: string;
    };

/**
 * A redacted environment variable is a reference to a secret already in the
 * server's store. It is only valid while the authoritative environment still
 * contains that named secret; otherwise the server would treat it as a new
 * reference and its stale-secret sweep would delete the replacement that was
 * actually stored.
 */
export function findStaleRedactedProviderEnvironmentReference(
  patch: ServerSettingsPatch,
  acknowledgedSettings: ServerSettings,
): { readonly instanceId: string; readonly name: string } | null {
  if (patch.providerInstances === undefined) return null;

  for (const [rawInstanceId, instance] of Object.entries(patch.providerInstances)) {
    if (instance.environment === undefined) continue;
    const instanceId = ProviderInstanceId.make(rawInstanceId);
    const storedSecretNames = new Set(
      (acknowledgedSettings.providerInstances[instanceId]?.environment ?? [])
        .filter((variable) => variable.sensitive && variable.valueRedacted === true)
        .map((variable) => variable.name),
    );
    for (const variable of instance.environment) {
      if (!variable.sensitive || variable.valueRedacted !== true) continue;
      if (!storedSecretNames.has(variable.name)) return { instanceId, name: variable.name };
    }
  }

  return null;
}

export function prepareServerSettingsMutation(
  input: ServerSettingsMutationPreparationInput,
): ServerSettingsMutationPreparation {
  const baseSettings = selectAuthoritativeServerSettings(
    input.streamedSettings,
    input.acknowledgement,
  );
  const staleReference = findStaleRedactedProviderEnvironmentReference(input.patch, baseSettings);
  if (staleReference !== null) {
    return {
      status: "rejected",
      baseRevision: baseSettings.revision,
      reason: `Stored secret ${staleReference.name} is no longer available for ${staleReference.instanceId}. Reload the provider settings and try again.`,
    };
  }
  return {
    status: "ready",
    baseSettings,
    mutationId: ServerSettingsMutationIdSchema.make(
      `settings:${input.environmentId}:${baseSettings.revision}:${input.requestSequence}`,
    ),
  };
}

export function selectAuthoritativeServerSettings(
  streamed: ServerSettings,
  acknowledged: ServerSettingsAcknowledgementProjection | null,
): ServerSettings {
  if (acknowledged === null || streamed.revision >= acknowledged.acknowledgement.revision) {
    return streamed;
  }
  return acknowledged.acknowledgement.settings;
}

export function projectServerSettingsAcknowledgement(
  current: ServerSettingsAcknowledgementProjection | null,
  requestSequence: number,
  acknowledgement: ServerSettingsMutationAcknowledgement,
): ServerSettingsAcknowledgementProjection {
  if (
    current !== null &&
    (acknowledgement.revision < current.acknowledgement.revision ||
      (acknowledgement.revision === current.acknowledgement.revision &&
        requestSequence < current.requestSequence))
  ) {
    return current;
  }
  return { requestSequence, acknowledgement };
}
