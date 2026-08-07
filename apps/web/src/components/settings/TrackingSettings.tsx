import type { TrackerKindLiteral, TrackerProviderSettings } from "@neokod/contracts";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { AsanaIcon, GitHubIcon, GitLabIcon, JiraIcon, LinearIcon, type Icon } from "../Icons";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";

/**
 * Tracking settings surface.
 *
 * This is the app-level control for Symphony work trackers. Source Control
 * covers git hosts (remotes, PRs, cloning); Tracking covers the issue/work
 * sources Symphony reads (GitHub Issues, Jira, Linear, GitLab, Asana). Each
 * activated workflow still declares its own `tracker.kind` in `WORKFLOW.md`;
 * these settings gate enablement and supply host-side defaults the workflow
 * can reference.
 */

type TrackerDefinition = {
  readonly kind: TrackerKindLiteral;
  readonly label: string;
  readonly description: string;
  readonly icon: Icon;
  readonly scopePlaceholder: string;
};

const TRACKERS: ReadonlyArray<TrackerDefinition> = [
  {
    kind: "github",
    label: "GitHub Issues",
    description: "Pull issues from a GitHub repository for autonomous implementation.",
    icon: GitHubIcon,
    scopePlaceholder: "owner/repo",
  },
  {
    kind: "jira",
    label: "Jira",
    description: "Pull issues from a Jira project or board.",
    icon: JiraIcon,
    scopePlaceholder: "project key",
  },
  {
    kind: "linear",
    label: "Linear",
    description: "Pull issues from a Linear team or board.",
    icon: LinearIcon,
    scopePlaceholder: "team key",
  },
  {
    kind: "gitlab",
    label: "GitLab",
    description: "Pull issues from a GitLab project.",
    icon: GitLabIcon,
    scopePlaceholder: "group/project",
  },
  {
    kind: "asana",
    label: "Asana",
    description: "Pull tasks from an Asana project.",
    icon: AsanaIcon,
    scopePlaceholder: "project id",
  },
];

function TrackerRow({ definition }: { readonly definition: TrackerDefinition }) {
  const Icon = definition.icon;
  const trackers = usePrimarySettings((settings) => settings.trackers);
  const updateSettings = useUpdatePrimarySettings();

  const tracker = trackers[definition.kind];
  const enabled = tracker?.enabled ?? false;
  const credentialRef = tracker?.credentialRef ?? "";
  const scope = tracker?.scope ?? "";

  const updateTracker = (patch: Partial<TrackerProviderSettings>) => {
    updateSettings({
      trackers: {
        ...trackers,
        [definition.kind]: {
          enabled,
          credentialRef,
          scope,
          config: tracker?.config ?? {},
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
            <span className="text-[11px] font-medium text-muted-foreground">Scope</span>
            <Input
              size="sm"
              value={scope}
              placeholder={definition.scopePlaceholder}
              onChange={(event) => updateTracker({ scope: event.target.value })}
              aria-label={`${definition.label} scope`}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Credential reference
            </span>
            <Input
              size="sm"
              value={credentialRef}
              placeholder="$VAR or secret-store key"
              onChange={(event) => updateTracker({ credentialRef: event.target.value })}
              aria-label={`${definition.label} credential reference`}
            />
          </label>
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
