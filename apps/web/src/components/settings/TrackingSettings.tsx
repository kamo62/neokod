import type { TrackerKindLiteral, TrackerProviderSettings } from "@neokod/contracts";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  AsanaIcon,
  AzureDevOpsIcon,
  GitHubIcon,
  GitHubProjectsIcon,
  GitLabIcon,
  JiraIcon,
  LinearIcon,
  type Icon,
} from "../Icons";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";

/**
 * Tracking settings surface.
 *
 * This is the app-level control for Symphony work trackers. Source Control
 * covers git hosts (remotes, PRs, cloning); Tracking covers the issue/work
 * sources Symphony reads (GitHub Issues, Jira, Linear, GitLab, Asana). These
 * settings own account and tenant connectivity only. Tracker project,
 * board, and repository scope belongs to each Symphony project.
 */

type TrackerDefinition = {
  readonly kind: TrackerKindLiteral;
  readonly label: string;
  readonly description: string;
  readonly icon: Icon;
  readonly credentialPlaceholder: string;
  readonly connectionFields?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly placeholder: string;
  }>;
};

const TRACKERS: ReadonlyArray<TrackerDefinition> = [
  {
    kind: "github",
    label: "GitHub Issues",
    description: "Pull issues from a GitHub repository for autonomous implementation.",
    icon: GitHubIcon,
    credentialPlaceholder: "Optional token; blank uses gh login",
  },
  {
    kind: "jira",
    label: "Jira",
    description: "Pull issues from a Jira project or board.",
    icon: JiraIcon,
    credentialPlaceholder: "Jira API token",
    connectionFields: [
      { key: "base_url", label: "Base URL", placeholder: "https://example.atlassian.net" },
      { key: "email", label: "Account email", placeholder: "developer@example.com" },
    ],
  },
  {
    kind: "linear",
    label: "Linear",
    description: "Pull issues from a Linear project.",
    icon: LinearIcon,
    credentialPlaceholder: "Linear API key",
  },
  {
    kind: "gitlab",
    label: "GitLab",
    description: "Pull issues from a GitLab project.",
    icon: GitLabIcon,
    credentialPlaceholder: "GitLab personal access token",
    connectionFields: [
      {
        key: "api_url",
        label: "API URL (self-hosted only)",
        placeholder: "https://gitlab.example.com/api/v4",
      },
    ],
  },
  {
    kind: "asana",
    label: "Asana",
    description: "Pull tasks from an Asana project.",
    icon: AsanaIcon,
    credentialPlaceholder: "Asana personal access token",
  },
  {
    kind: "azure_boards",
    label: "Azure Boards",
    description:
      "Pull work items from an Azure DevOps project independently of its repository host.",
    icon: AzureDevOpsIcon,
    credentialPlaceholder: "Azure DevOps personal access token",
    connectionFields: [
      { key: "organization", label: "Organisation", placeholder: "my-organisation" },
    ],
  },
  {
    kind: "github_projects",
    label: "GitHub Projects",
    description: "Pull work items from a GitHub Projects board.",
    icon: GitHubProjectsIcon,
    credentialPlaceholder: "GitHub personal access token",
  },
];

function TrackerRow({ definition }: { readonly definition: TrackerDefinition }) {
  const Icon = definition.icon;
  const trackers = usePrimarySettings((settings) => settings.trackers);
  const updateSettings = useUpdatePrimarySettings();

  const tracker = trackers[definition.kind];
  const enabled = tracker?.enabled ?? false;
  const credential = tracker?.credential ?? "";
  const credentialRedacted = tracker?.credentialRedacted ?? false;
  const config = tracker?.config ?? {};

  const updateTracker = (patch: Partial<TrackerProviderSettings>) => {
    updateSettings({
      trackers: {
        ...trackers,
        [definition.kind]: {
          enabled,
          credential,
          credentialRedacted,
          config,
          ...patch,
        },
      },
    });
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-foreground/80" />
          {definition.label}
        </span>
      }
      description={definition.description}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(next) => updateTracker({ enabled: next })}
          aria-label={`Enable ${definition.label}`}
        />
      }
    >
      {enabled ? (
        <div className="grid gap-3 pb-3.5 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
              Credential
              {credentialRedacted ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => updateTracker({ credential: "", credentialRedacted: false })}
                >
                  Clear
                </Button>
              ) : null}
            </span>
            <DraftInput
              size="sm"
              type="password"
              value={credentialRedacted ? "" : credential}
              placeholder={credentialRedacted ? "Configured" : definition.credentialPlaceholder}
              onCommit={(value) =>
                updateTracker({ credential: value.trim(), credentialRedacted: false })
              }
              aria-label={`${definition.label} credential`}
            />
          </label>
          {definition.connectionFields?.map((field) => {
            const value = config[field.key];
            return (
              <label key={field.key} className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">{field.label}</span>
                <DraftInput
                  size="sm"
                  value={typeof value === "string" ? value : ""}
                  placeholder={field.placeholder}
                  onCommit={(value) =>
                    updateTracker({ config: { ...config, [field.key]: value.trim() } })
                  }
                  aria-label={`${definition.label} ${field.label}`}
                />
              </label>
            );
          })}
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function TrackingSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Tracking">
        {TRACKERS.map((tracker) => (
          <TrackerRow key={tracker.kind} definition={tracker} />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
