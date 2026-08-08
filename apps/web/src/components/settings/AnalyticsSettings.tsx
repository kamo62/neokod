import { InfoIcon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function AnalyticsSettingsPanel() {
  const settings = usePrimarySettings((value) => value.analytics);
  const updateSettings = useUpdatePrimarySettings();
  const hasPartialPostHogSettings =
    settings.posthogApiKey.length > 0 !== settings.posthogHost.length > 0;

  const destinationDescription = !settings.enabled
    ? "Analytics is disabled. No PostHog events are sent."
    : hasPartialPostHogSettings
      ? "Enter both fields to use your PostHog instance."
      : settings.posthogApiKey.length > 0
        ? "Using your PostHog instance."
        : "Using Neokod's built-in PostHog instance.";

  return (
    <SettingsPageContainer>
      <SettingsSection title="Analytics">
        <SettingsRow
          title="Send analytics"
          description="Share anonymous usage data and error logs to help improve Neokod."
          control={
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => updateSettings({ analytics: { ...settings, enabled } })}
              aria-label="Enable analytics"
            />
          }
          status={destinationDescription}
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <InfoIcon className="size-3.5 text-muted-foreground" />
              Privacy
            </span>
          }
          description="Neokod does not monitor your prompts or source code. Analytics is used only for usage data and error logging. You can disable analytics or point it at your own PostHog instance."
        />
        <SettingsRow
          title="PostHog project API key"
          description={
            hasPartialPostHogSettings
              ? "Optional. Leave blank to use Neokod's built-in project. Enter both fields to use your PostHog instance."
              : "Optional. Leave blank to use Neokod's built-in project."
          }
          control={
            <DraftInput
              size="sm"
              value={settings.posthogApiKey}
              onCommit={(value) =>
                updateSettings({ analytics: { ...settings, posthogApiKey: value.trim() } })
              }
              placeholder="phc_..."
              aria-label="PostHog project API key"
              className="w-full sm:w-64"
            />
          }
        />
        <SettingsRow
          title="PostHog host URL"
          description={
            hasPartialPostHogSettings
              ? "Optional. Include the URL of your PostHog instance. Enter both fields to use your PostHog instance."
              : "Optional. Include the URL of your PostHog instance."
          }
          control={
            <DraftInput
              size="sm"
              value={settings.posthogHost}
              onCommit={(value) =>
                updateSettings({ analytics: { ...settings, posthogHost: value.trim() } })
              }
              placeholder="https://us.i.posthog.com"
              aria-label="PostHog host URL"
              className="w-full sm:w-64"
            />
          }
        />
        <SettingsRow
          title="Changes apply immediately"
          description="Changing this setting does not require an app restart."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
