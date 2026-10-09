import type {
  AutonomyLevel,
  RepositoryIdentity,
  ServerProvider,
  SymphonyProjectConfiguration,
  SymphonyTrackerScope,
  TrackerKind,
} from "@neokod/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@neokod/shared/git";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
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

const AUTONOMY: ReadonlyArray<{
  value: AutonomyLevel;
  label: string;
  description: string;
}> = [
  {
    value: "observe",
    label: "Watch only",
    description: "Read tracker issues and update the board. No coding agent runs.",
  },
  {
    value: "prepare",
    label: "Create a plan",
    description: "Run the implementation agent read-only to produce a plan. No files are changed.",
  },
  {
    value: "execute",
    label: "Implement locally",
    description:
      "Allow edits and validation in an isolated worktree. A remote is optional, so PR delivery may be unavailable.",
  },
  {
    value: "deliver",
    label: "Implement and open a PR",
    description:
      "Require an authenticated source-control remote, then edit, validate, push, and open a pull request.",
  },
];

export const availableSymphonyImplementationProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  providers.filter(
    (provider) =>
      provider.driver === "codex" &&
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable",
  );

const REVIEW_CAPABLE_DRIVERS = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "githubCopilot",
  "grok",
  "opencode",
]);

export const availableSymphonyReviewProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  providers.filter(
    (provider) =>
      REVIEW_CAPABLE_DRIVERS.has(provider.driver) &&
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable",
  );

export const githubIssueRepositoryFromIdentity = (
  identity: RepositoryIdentity | null | undefined,
): string | null => {
  if (identity === null || identity === undefined) return null;
  if (
    identity.provider?.toLowerCase() === "github" &&
    identity.owner?.trim() &&
    identity.name?.trim()
  ) {
    return `${identity.owner.trim()}/${identity.name.trim()}`;
  }
  return parseGitHubRepositoryNameWithOwnerFromRemoteUrl(identity.locator.remoteUrl);
};

const preferredModel = (provider: ServerProvider) =>
  provider.models.find((model) => !model.isCustom) ?? provider.models[0];

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
  providers?: ReadonlyArray<ServerProvider>,
  reviewProviders: ReadonlyArray<ServerProvider> = providers ?? [],
): boolean => {
  const trackerComplete = Object.entries(configuration.tracker).every(
    ([key, value]) =>
      key === "kind" ||
      (typeof value === "number"
        ? value > 0
        : typeof value === "string" && value.trim().length > 0),
  );
  if (!trackerComplete || providers === undefined) return trackerComplete;
  const provider = providers.find(
    (candidate) => candidate.instanceId === configuration.agentProvider.instanceId,
  );
  const reviewAgents = configuration.reviewAgents ?? [];
  return (
    provider !== undefined &&
    configuration.agentModel !== undefined &&
    provider.models.some((model) => model.slug === configuration.agentModel) &&
    reviewAgents.every(
      (reviewAgent) =>
        reviewProviders
          .flatMap((candidate) => candidate.models)
          .filter((model) => model.slug === reviewAgent).length === 1,
    )
  );
};

export const defaultSymphonyProjectConfiguration = (
  provider: ServerProvider,
  githubIssueRepository = "",
): SymphonyProjectConfiguration => ({
  tracker: { kind: "github", repository: githubIssueRepository },
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  autonomy: "observe",
  agentProvider: { instanceId: provider.instanceId, driver: provider.driver },
  ...(preferredModel(provider) ? { agentModel: preferredModel(provider)?.slug } : {}),
  reviewAgents: [],
  reviewRequirement: "all-approve",
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
  repositoryWasDetected,
}: {
  readonly tracker: SymphonyTrackerScope;
  readonly onChange: (tracker: SymphonyTrackerScope) => void;
  readonly repositoryWasDetected: boolean;
}) {
  const field = (
    label: string,
    value: string,
    update: (value: string) => void,
    description?: string,
  ) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input nativeInput value={value} onChange={(event) => update(event.target.value)} />
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );

  switch (tracker.kind) {
    case "github":
      return field(
        "GitHub issue repository",
        tracker.repository,
        (repository) => onChange({ kind: "github", repository }),
        repositoryWasDetected
          ? "Filled from the Code project's Git remote. Change it if the issues live in another repository."
          : "Enter owner/repository. The issue tracker may be different from the source-control repository.",
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

export function ApprovalSettingsNote() {
  return (
    <p className="text-xs text-muted-foreground">
      Pushing the branch and opening the pull request are not gated by an approval setting yet.
      Merging always needs your approval, and Neokod never merges on its own.
    </p>
  );
}

export function SymphonyProjectConfigurationForm({
  value,
  providers,
  reviewProviders,
  onChange,
  repositoryWasDetected = false,
}: {
  readonly value: SymphonyProjectConfiguration;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly reviewProviders: ReadonlyArray<ServerProvider>;
  readonly onChange: (value: SymphonyProjectConfiguration) => void;
  readonly repositoryWasDetected?: boolean;
}) {
  const update = (patch: Partial<SymphonyProjectConfiguration>) => onChange({ ...value, ...patch });
  const selectedAutonomy =
    AUTONOMY.find((option) => option.value === value.autonomy) ?? AUTONOMY[0]!;
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === value.agentProvider.instanceId,
  );
  const models = selectedProvider?.models ?? [];
  const reviewAgents = value.reviewAgents ?? [];
  const reviewModelCandidates = reviewProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      provider: provider.displayName ?? provider.instanceId,
    })),
  );
  const reviewModelOptions = reviewModelCandidates.filter(
    (candidate) =>
      reviewModelCandidates.filter((other) => other.slug === candidate.slug).length === 1,
  );
  const unselectedReviewModels = reviewModelOptions.filter(
    (candidate) => !reviewAgents.includes(candidate.slug),
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Work tracker</Label>
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
          <p className="text-xs text-muted-foreground">
            Where Symphony reads work from. It can be different from source control.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>What may Symphony do?</Label>
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
          <p className="text-xs text-muted-foreground">{selectedAutonomy.description}</p>
        </div>
      </div>

      <TrackerScopeFields
        tracker={value.tracker}
        onChange={(tracker) => update({ tracker })}
        repositoryWasDetected={repositoryWasDetected}
      />

      <section className="space-y-3 rounded-xl border p-4">
        <div>
          <h3 className="text-sm font-medium">Implementation agent</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            One agent works each issue. Symphony execution currently supports Codex; the model is
            selected explicitly below.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select
              value={value.agentProvider.instanceId}
              onValueChange={(instanceId) => {
                const provider = providers.find((candidate) => candidate.instanceId === instanceId);
                if (!provider) return;
                const model = preferredModel(provider);
                update({
                  agentProvider: { instanceId: provider.instanceId, driver: provider.driver },
                  agentModel: model?.slug,
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
            <Label>Model</Label>
            <Select
              value={value.agentModel}
              onValueChange={(agentModel) => {
                if (agentModel !== null) update({ agentModel });
              }}
              items={models.map((model) => ({
                value: model.slug,
                label: `${model.name} (${model.slug})`,
              }))}
              disabled={models.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="No models reported" />
              </SelectTrigger>
              <SelectPopup>
                {models.map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    <span className="flex min-w-0 flex-col">
                      <span>{model.name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {model.slug}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div>
          <h3 className="text-sm font-medium">AI review</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Selected models review the completed diff in parallel before PR / Human Review.
          </p>
        </div>
        {reviewAgents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No AI reviewers selected.</p>
        ) : (
          <div className="space-y-2">
            {reviewAgents.map((slug) => {
              const candidate = reviewModelOptions.find((model) => model.slug === slug);
              return (
                <div
                  key={slug}
                  className="flex items-center justify-between gap-3 rounded-lg border p-2"
                >
                  <span className="min-w-0 text-xs">
                    <span className="block truncate font-medium">{candidate?.name ?? slug}</span>
                    <span className="block truncate text-muted-foreground">
                      {candidate ? `${candidate.provider} · ${slug}` : `${slug} · unavailable`}
                    </span>
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${slug}`}
                    onClick={() =>
                      update({ reviewAgents: reviewAgents.filter((reviewer) => reviewer !== slug) })
                    }
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Add reviewer</Label>
            <Select
              value={null}
              onValueChange={(slug) => {
                if (slug !== null) update({ reviewAgents: [...reviewAgents, slug] });
              }}
              items={unselectedReviewModels.map((model) => ({
                value: model.slug,
                label: `${model.name} (${model.provider})`,
              }))}
              disabled={unselectedReviewModels.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a provider model" />
              </SelectTrigger>
              <SelectPopup>
                {unselectedReviewModels.map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    <span className="flex min-w-0 flex-col">
                      <span>{model.name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {model.provider} · {model.slug}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Review gate</Label>
            <Select
              value={value.reviewRequirement ?? "advisory"}
              onValueChange={(reviewRequirement) => {
                if (reviewRequirement !== null) {
                  update({
                    reviewRequirement: reviewRequirement as
                      | "all-approve"
                      | "any-approve"
                      | "advisory",
                  });
                }
              }}
              items={[
                { value: "all-approve", label: "Every reviewer must approve" },
                { value: "any-approve", label: "Any reviewer may approve" },
                { value: "advisory", label: "Advisory only" },
              ]}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="all-approve">Every reviewer must approve</SelectItem>
                <SelectItem value="any-approve">Any reviewer may approve</SelectItem>
                <SelectItem value="advisory">Advisory only</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </div>
      </section>

      <details className="rounded-xl border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Advanced tracker and execution settings
        </summary>
        <div className="space-y-5 border-t p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Required labels</Label>
              <Input
                nativeInput
                value={value.trackerRequiredLabels.join(", ")}
                onChange={(event) =>
                  update({ trackerRequiredLabels: splitList(event.target.value) })
                }
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
                onChange={(event) =>
                  update({ trackerTerminalStates: splitList(event.target.value) })
                }
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
                ["maxConcurrentAgents", "Parallel work items"],
                ["maxTurns", "Maximum turns per item"],
                ["maxAttempts", "Maximum attempts per item"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label>{label}</Label>
                <Input
                  nativeInput
                  type="number"
                  min={1}
                  value={value[key]}
                  onChange={(event) =>
                    update({ [key]: Math.max(1, Number(event.target.value) || 1) })
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Parallel work items controls how many tracker issues may run at once. It does not add
            planner, reviewer, or command-runner roles to one issue.
          </p>

          <ApprovalSettingsNote />
        </div>
      </details>
    </div>
  );
}
