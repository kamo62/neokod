import type {
  AutonomyLevel,
  ServerProvider,
  SymphonyProjectConfiguration,
  SymphonyTrackerScope,
  TrackerKind,
} from "@neokod/contracts";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const TRACKERS: ReadonlyArray<{ value: TrackerKind; label: string }> = [
  { value: "github", label: "GitHub Issues" },
  { value: "jira", label: "Jira" },
  { value: "linear", label: "Linear" },
  { value: "gitlab", label: "GitLab Issues" },
  { value: "asana", label: "Asana" },
  { value: "azure_boards", label: "Azure Boards" },
  { value: "github_projects", label: "GitHub Projects" },
];

const AUTONOMY: ReadonlyArray<{ value: AutonomyLevel; label: string }> = [
  { value: "observe", label: "Observe" },
  { value: "prepare", label: "Prepare" },
  { value: "execute", label: "Execute" },
  { value: "deliver", label: "Deliver" },
];

const defaultTracker = (kind: TrackerKind): SymphonyTrackerScope => {
  switch (kind) {
    case "github":
      return { kind, repository: "" };
    case "jira":
      return { kind, projectKey: "" };
    case "linear":
      return { kind, projectSlug: "" };
    case "gitlab":
      return { kind, projectPath: "" };
    case "asana":
      return { kind, projectGid: "" };
    case "azure_boards":
      return { kind, project: "" };
    case "github_projects":
      return { kind, owner: "", number: 1 };
  }
};

export const isSymphonyProjectConfigurationComplete = (
  configuration: SymphonyProjectConfiguration,
): boolean =>
  Object.entries(configuration.tracker).every(
    ([key, value]) =>
      key === "kind" ||
      (typeof value === "number"
        ? value > 0
        : typeof value === "string" && value.trim().length > 0),
  );

export const defaultSymphonyProjectConfiguration = (
  provider: ServerProvider,
): SymphonyProjectConfiguration => ({
  tracker: defaultTracker("github"),
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  autonomy: "observe",
  agentProvider: { instanceId: provider.instanceId, driver: provider.driver },
  validationRequired: [],
  maxConcurrentAgents: 1,
  maxTurns: 20,
  maxAttempts: 3,
  approvalsBeforePush: false,
  approvalsBeforePullRequest: false,
  approvalsBeforeMerge: true,
});

const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);

function TrackerScopeFields({
  tracker,
  onChange,
}: {
  readonly tracker: SymphonyTrackerScope;
  readonly onChange: (tracker: SymphonyTrackerScope) => void;
}) {
  const field = (label: string, value: string, update: (value: string) => void) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input nativeInput value={value} onChange={(event) => update(event.target.value)} />
    </div>
  );

  switch (tracker.kind) {
    case "github":
      return field("Issue repository", tracker.repository, (repository) =>
        onChange({ kind: "github", repository }),
      );
    case "jira":
      return field("Jira project key", tracker.projectKey, (projectKey) =>
        onChange({ kind: "jira", projectKey }),
      );
    case "linear":
      return field("Linear project slug", tracker.projectSlug, (projectSlug) =>
        onChange({ kind: "linear", projectSlug }),
      );
    case "gitlab":
      return field("GitLab project path", tracker.projectPath, (projectPath) =>
        onChange({ kind: "gitlab", projectPath }),
      );
    case "asana":
      return field("Asana project GID", tracker.projectGid, (projectGid) =>
        onChange({ kind: "asana", projectGid }),
      );
    case "azure_boards":
      return field("Azure project", tracker.project, (project) =>
        onChange({ ...tracker, project }),
      );
    case "github_projects":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {field("GitHub owner", tracker.owner, (owner) => onChange({ ...tracker, owner }))}
          <div className="space-y-1.5">
            <Label>Project number</Label>
            <Input
              nativeInput
              type="number"
              min={1}
              value={tracker.number}
              onChange={(event) =>
                onChange({ ...tracker, number: Math.max(1, Number(event.target.value) || 1) })
              }
            />
          </div>
        </div>
      );
  }
}

export function SymphonyProjectConfigurationForm({
  value,
  providers,
  onChange,
}: {
  readonly value: SymphonyProjectConfiguration;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (value: SymphonyProjectConfiguration) => void;
}) {
  const update = (patch: Partial<SymphonyProjectConfiguration>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Tracker</Label>
          <Select
            value={value.tracker.kind}
            onValueChange={(kind) => update({ tracker: defaultTracker(kind as TrackerKind) })}
            items={TRACKERS}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {TRACKERS.map((tracker) => (
                <SelectItem key={tracker.value} value={tracker.value}>
                  {tracker.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Runtime policy</Label>
          <Select
            value={value.autonomy}
            onValueChange={(autonomy) => update({ autonomy: autonomy as AutonomyLevel })}
            items={AUTONOMY}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {AUTONOMY.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <TrackerScopeFields tracker={value.tracker} onChange={(tracker) => update({ tracker })} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Agent</Label>
          <Select
            value={value.agentProvider.instanceId}
            onValueChange={(instanceId) => {
              const provider = providers.find((candidate) => candidate.instanceId === instanceId);
              if (provider)
                update({
                  agentProvider: { instanceId: provider.instanceId, driver: provider.driver },
                });
            }}
            items={providers.map((provider) => ({
              value: provider.instanceId,
              label: provider.displayName ?? provider.instanceId,
            }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {providers.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Model override</Label>
          <Input
            nativeInput
            placeholder="Use agent default"
            value={value.agentModel ?? ""}
            onChange={(event) =>
              update(
                event.target.value.trim()
                  ? { agentModel: event.target.value }
                  : { agentModel: undefined },
              )
            }
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>Required labels</Label>
          <Input
            nativeInput
            value={value.trackerRequiredLabels.join(", ")}
            onChange={(event) => update({ trackerRequiredLabels: splitList(event.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Active states</Label>
          <Input
            nativeInput
            value={value.trackerActiveStates.join(", ")}
            onChange={(event) => update({ trackerActiveStates: splitList(event.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Terminal states</Label>
          <Input
            nativeInput
            value={value.trackerTerminalStates.join(", ")}
            onChange={(event) => update({ trackerTerminalStates: splitList(event.target.value) })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Validation commands</Label>
        <textarea
          className="min-h-24 w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="One command per line"
          value={value.validationRequired.join("\n")}
          onChange={(event) => update({ validationRequired: splitList(event.target.value) })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {(
          [
            ["maxConcurrentAgents", "Concurrent agents"],
            ["maxTurns", "Maximum turns"],
            ["maxAttempts", "Maximum attempts"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <Label>{label}</Label>
            <Input
              nativeInput
              type="number"
              min={1}
              value={value[key]}
              onChange={(event) => update({ [key]: Math.max(1, Number(event.target.value) || 1) })}
            />
          </div>
        ))}
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-3">
        {(
          [
            ["approvalsBeforePush", "Approve before push"],
            ["approvalsBeforePullRequest", "Approve before PR"],
            ["approvalsBeforeMerge", "Approve before merge"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <input
              type="checkbox"
              checked={value[key]}
              onChange={(event) => update({ [key]: event.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
