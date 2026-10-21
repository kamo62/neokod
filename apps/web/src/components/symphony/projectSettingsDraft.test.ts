import {
  ProviderDriverKind,
  ProviderInstanceId,
  SymphonyProjectId,
  type SymphonyProject,
  type SymphonyProjectConfiguration,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySavedDraft,
  beginEditDraft,
  editDraft,
  endEditDraft,
  isDraftDirty,
  type ProjectSettingsDraft,
  reconcileDraft,
  savedDraft,
  startDraft,
} from "./projectSettingsDraft";

const makeConfiguration = (
  overrides: Partial<SymphonyProjectConfiguration> = {},
): SymphonyProjectConfiguration => ({
  tracker: { kind: "github", repository: "kamo62/neokod" },
  trackerRequiredLabels: ["bug"],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  autonomy: "observe",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
  },
  agentModel: "gpt-5-codex",
  reviewAgents: [],
  reviewRequirement: "all-approve",
  validationRequired: ["vp check"],
  maxConcurrentAgents: 1,
  maxTurns: 20,
  maxAttempts: 3,
  approvalsBeforePush: false,
  approvalsBeforePullRequest: false,
  approvalsBeforeMerge: true,
  ...overrides,
});

const makeProject = (
  revision: number,
  configuration: SymphonyProjectConfiguration | null,
): SymphonyProject => ({
  id: SymphonyProjectId.make("project-1"),
  codeProjectId: null,
  title: "Neokod",
  repositoryPath: "/tmp/neokod",
  status: "paused",
  setupState: "ready",
  configuration,
  revision,
  legacyWorkflowId: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
});

describe("project settings draft", () => {
  it("a clean draft follows the server revision", () => {
    const serverConfiguration = makeConfiguration({ maxTurns: 20 });
    const nextConfiguration = makeConfiguration({ maxTurns: 40 });
    const draft = startDraft(makeProject(1, serverConfiguration), null);
    expect(draft).not.toBeNull();

    const { draft: reconciled, sync } = reconcileDraft(
      draft!,
      makeProject(2, nextConfiguration),
      null,
    );

    expect(sync).toBe("clean");
    expect(reconciled.value).toEqual(nextConfiguration);
    expect(reconciled.baseRevision).toBe(2);
    expect(isDraftDirty(reconciled)).toBe(false);
  });

  it("a dirty draft survives a revision bump that did not change the configuration", () => {
    const serverConfiguration = makeConfiguration({ maxTurns: 20 });
    const edited = makeConfiguration({ maxTurns: 40 });
    const draft = editDraft(startDraft(makeProject(1, serverConfiguration), null)!, edited);

    const { draft: reconciled, sync } = reconcileDraft(
      draft,
      makeProject(2, serverConfiguration),
      null,
    );

    expect(sync).toBe("dirty");
    expect(reconciled.value).toEqual(edited);
    expect(reconciled.baseRevision).toBe(2);
    expect(isDraftDirty(reconciled)).toBe(true);
  });

  it("a dirty draft is flagged when the configuration changed elsewhere", () => {
    const serverConfiguration = makeConfiguration({ maxTurns: 20 });
    const edited = makeConfiguration({ maxTurns: 40 });
    const draft = editDraft(startDraft(makeProject(1, serverConfiguration), null)!, edited);

    const { draft: reconciled, sync } = reconcileDraft(
      draft,
      makeProject(2, makeConfiguration({ maxTurns: 30 })),
      null,
    );

    expect(sync).toBe("changed_elsewhere");
    expect(reconciled.value).toEqual(edited);
  });

  it("keeps the edit baseline when a buffered keystroke precedes an external change", () => {
    const original = makeConfiguration({ maxTurns: 20 });
    const externallyChanged = makeConfiguration({ maxTurns: 30 });
    const buffered = makeConfiguration({ maxTurns: 40 });
    const draft = startDraft(makeProject(1, original), null)!;
    // The input owns uncommitted keystrokes, but the store still holds the
    // last committed configuration until blur parses the text.
    const editing = { ...draft, editing: true } satisfies ProjectSettingsDraft;

    const beforeBlur = reconcileDraft(editing, makeProject(2, externallyChanged), null);

    expect(beforeBlur.sync).toBe("changed_elsewhere");
    expect(beforeBlur.draft.baseRevision).toBe(1);

    // Blur commits the buffered text against the revision the edit started on.
    const afterBlur = reconcileDraft(
      editDraft(beforeBlur.draft, buffered),
      makeProject(2, externallyChanged),
      null,
    );

    expect(afterBlur.sync).toBe("changed_elsewhere");
    expect(afterBlur.draft.baseRevision).toBe(1);
    expect(afterBlur.draft.value).toEqual(buffered);
  });

  it("claims ownership on the first buffered keystroke without committing it", () => {
    const draft = startDraft(makeProject(1, makeConfiguration()), null)!;

    const editing = beginEditDraft(draft);

    expect(isDraftDirty(editing)).toBe(true);
    expect(editing.value).toEqual(draft.value);
    expect(editing.baseRevision).toBe(draft.baseRevision);

    const released = endEditDraft(editing);
    expect(released.editing).toBe(false);
    expect(isDraftDirty(released)).toBe(false);
  });

  it("keeps buffered ownership when a save response arrives before blur", () => {
    const configuration = makeConfiguration({ maxTurns: 20 });
    const editing = beginEditDraft(startDraft(makeProject(1, configuration), null)!);

    const applied = applySavedDraft(editing, makeProject(2, configuration));

    expect(applied).not.toBeNull();
    expect(applied!.editing).toBe(true);
    expect(applied!.baseRevision).toBe(2);
  });

  it("savedDraft is clean and uses the returned revision", () => {
    const project = makeProject(4, makeConfiguration());
    const draft = savedDraft(project);

    expect(draft).not.toBeNull();
    expect(isDraftDirty(draft!)).toBe(false);
    expect(draft!.baseRevision).toBe(4);
  });

  it("startDraft uses the fallback when the project has no configuration", () => {
    const fallback = makeConfiguration({ maxTurns: 7 });
    const draft = startDraft(makeProject(3, null), fallback);

    expect(draft).not.toBeNull();
    expect(draft!.serverBase).toBeNull();
    expect(draft!.value).toEqual(fallback);
    expect(draft!.baseRevision).toBe(3);
    expect(startDraft(makeProject(3, null), null)).toBeNull();
  });

  it("does not regress a draft when a save response is ahead of the project prop", () => {
    const savedConfiguration = makeConfiguration({ maxTurns: 40 });
    const draft = savedDraft(makeProject(2, savedConfiguration))!;
    const staleProject = makeProject(1, makeConfiguration({ maxTurns: 20 }));

    const { draft: reconciled, sync } = reconcileDraft(draft, staleProject, null);

    expect(sync).toBe("clean");
    expect(reconciled.value).toEqual(savedConfiguration);
    expect(reconciled.baseRevision).toBe(2);

    const edited = editDraft(draft, makeConfiguration({ maxTurns: 60 }));
    const dirty = reconcileDraft(edited, staleProject, null);
    expect(dirty.sync).toBe("dirty");
    expect(dirty.draft.value).toEqual(edited.value);
  });

  it("applySavedDraft refreshes the baseline but keeps an edit made while saving", () => {
    const serverConfiguration = makeConfiguration({ maxTurns: 20 });
    const savedConfiguration = makeConfiguration({ maxTurns: 40 });
    const draft = editDraft(
      startDraft(makeProject(1, serverConfiguration), null)!,
      savedConfiguration,
    );
    const newerEdit = makeConfiguration({ maxTurns: 60 });

    const applied = applySavedDraft(
      editDraft(draft, newerEdit),
      makeProject(2, savedConfiguration),
    );

    expect(applied).not.toBeNull();
    expect(applied!.value).toEqual(newerEdit);
    expect(applied!.initial).toEqual(savedConfiguration);
    expect(applied!.serverBase).toEqual(savedConfiguration);
    expect(applied!.baseRevision).toBe(2);
    expect(isDraftDirty(applied!)).toBe(true);
  });

  it("applySavedDraft is clean when nothing changed while saving", () => {
    const draft = editDraft(
      startDraft(makeProject(1, makeConfiguration({ maxTurns: 20 })), null)!,
      makeConfiguration({ maxTurns: 40 }),
    );

    const applied = applySavedDraft(draft, makeProject(2, makeConfiguration({ maxTurns: 40 })));

    expect(applied).not.toBeNull();
    expect(isDraftDirty(applied!)).toBe(false);
    expect(applied!.baseRevision).toBe(2);
  });
});
