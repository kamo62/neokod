import type { ServerSettings, ServerSettingsMutationAcknowledgement } from "@neokod/contracts";

export interface ServerSettingsAcknowledgementProjection {
  readonly requestSequence: number;
  readonly acknowledgement: ServerSettingsMutationAcknowledgement;
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
