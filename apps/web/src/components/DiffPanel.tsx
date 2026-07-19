import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@neokod/client-runtime/errors";
import type { ScopedThreadRef, TurnId } from "@neokod/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useProject, useThread } from "../state/entities";
import type { TurnDiffFileChange } from "../types";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffFilesTree } from "./chat/ChangedFilesTree";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { summarizeTurnDiffStats } from "../lib/turnDiffTree";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();
const TURN_DIFF_FILE_KINDS = new Set(["added", "modified", "deleted", "renamed"]);

function toTurnDiffFileChange(file: {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}): TurnDiffFileChange {
  return {
    ...file,
    kind: TURN_DIFF_FILE_KINDS.has(file.kind) ? file.kind : "modified",
  };
}

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 82%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 72%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 76%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 62%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 82%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 72%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 76%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 62%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  font-family: var(--font-sans) !important;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline", composerDraftTarget }: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const [selectedDiffFile, setSelectedDiffFile] = useState<{
    scopeKey: string | null;
    filePath: string | null;
  }>({ scopeKey: null, filePath: null });
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const isMobile = useIsMobile();

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThread(routeThreadRef);
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedTurnId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedTurnId === null
      ? selectedGitScope === "unstaged"
        ? "Working tree"
        : "Branch changes"
      : selectedTurn?.turnId === latestTurn?.turnId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "unstaged"
      ? "Working tree"
      : "Branch changes";
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const primaryChangedFiles = useEnvironmentQuery(
    selectedTurnId === null && activeThread && activeCwd
      ? reviewEnvironment.changedFiles({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            scope: selectedGitScope === "unstaged" ? "working-tree" : "branch-range",
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedTurnId === null &&
    primaryChangedFiles.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackChangedFiles = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.changedFiles({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            scope: selectedGitScope === "unstaged" ? "working-tree" : "branch-range",
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const changedFilesQuery = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackChangedFiles
    : primaryChangedFiles;
  const localBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      changedFilesQuery.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: changedFilesQuery.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      changedFilesQuery.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: changedFilesQuery.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== changedFilesQuery.data?.headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const scopeFiles = useMemo<ReadonlyArray<TurnDiffFileChange>>(
    () =>
      selectedTurn
        ? selectedTurn.files
        : (changedFilesQuery.data?.files.map(toTurnDiffFileChange) ?? []),
    [changedFilesQuery.data?.files, selectedTurn],
  );
  const scopeFileStats = useMemo(() => summarizeTurnDiffStats(scopeFiles), [scopeFiles]);
  const selectedDiffFileScopeKey = `${reviewSectionId}:${selectedBaseRef ?? "automatic"}`;
  const initialSelectedFilePath =
    selectedDiffFile.scopeKey === selectedDiffFileScopeKey
      ? selectedDiffFile.filePath
      : selectedTurn
        ? selectedFilePath
        : null;
  const selectedScopeFilePath = scopeFiles.some((file) => file.path === initialSelectedFilePath)
    ? initialSelectedFilePath
    : (scopeFiles[0]?.path ?? null);

  useEffect(() => {
    if (!selectedScopeFilePath || selectedScopeFilePath === initialSelectedFilePath) return;
    setSelectedDiffFile({ scopeKey: selectedDiffFileScopeKey, filePath: selectedScopeFilePath });
  }, [initialSelectedFilePath, selectedDiffFileScopeKey, selectedScopeFilePath]);

  useEffect(() => {
    if (!selectedTurn || !selectedFilePath) return;
    setSelectedDiffFile({ scopeKey: selectedDiffFileScopeKey, filePath: selectedFilePath });
  }, [selectedDiffFileScopeKey, selectedFilePath, selectedFileRevealRequestId, selectedTurn]);

  const selectedGitFileDiff = useEnvironmentQuery(
    selectedTurnId === null && activeThread && changedFilesQuery.data?.cwd && selectedScopeFilePath
      ? reviewEnvironment.fileDiff({
          environmentId: activeThread.environmentId,
          input: {
            cwd: changedFilesQuery.data.cwd,
            scope: selectedGitScope === "unstaged" ? "working-tree" : "branch-range",
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            path: selectedScopeFilePath,
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const selectedPatch = selectedTurn
    ? activeCheckpointDiff.data?.diff
    : selectedGitFileDiff.data?.diff;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : selectedGitFileDiff.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : selectedGitFileDiff.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selectedTurnId === null,
      }),
    [resolvedTheme, selectedPatch, selectedTurnId],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return selectedTurn
      ? renderablePatch.files.filter(
          (fileDiff) => resolveFileDiffPath(fileDiff) === selectedScopeFilePath,
        )
      : renderablePatch.files.slice(0, 1);
  }, [renderablePatch, selectedScopeFilePath, selectedTurn]);
  const codeViewFiles = useMemo(
    () =>
      renderableFiles.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          collapsed: collapsedDiffFileKeys.has(fileKey),
        };
      }),
    [collapsedDiffFileKeys, renderableFiles],
  );

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, openInPreferredEditor, routeThreadRef],
  );
  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFiles((current) => {
        const next = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [collapseScopeKey],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted/70 px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem onClick={() => selectGitScope("unstaged")}>
              <span>Working tree</span>
              {selectedTurnId === null && selectedGitScope === "unstaged" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => selectGitScope("branch")}>
              <span>Branch changes</span>
              {selectedTurnId === null && selectedGitScope === "branch" && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (latestTurn) selectTurn(latestTurn.turnId);
              }}
            >
              <span>Latest turn</span>
              {selectedTurnId !== null && selectedTurn?.turnId === latestTurn?.turnId && (
                <CheckIcon className="ml-auto" />
              )}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {orderedTurnDiffSummaries.map((summary) => {
                  const turnCount =
                    summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                    "?";
                  return (
                    <DropdownMenuItem
                      key={summary.turnId}
                      onClick={() => selectTurn(summary.turnId)}
                    >
                      <span>Turn {turnCount}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                      {summary.turnId === selectedTurn?.turnId && <CheckIcon className="ml-1" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        <DiffStatLabel
          additions={scopeFileStats.additions}
          deletions={scopeFileStats.deletions}
          className="shrink-0 text-[11px]"
          layout="inline"
        />
        {selectedTurnId === null &&
          selectedGitScope === "branch" &&
          changedFilesQuery.data?.baseRef && (
            <div
              className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
              title={`${changedFilesQuery.data.headRef ?? "HEAD"} → ${changedFilesQuery.data.baseRef}`}
              aria-label={`Comparing ${changedFilesQuery.data.headRef ?? "HEAD"} against ${changedFilesQuery.data.baseRef}`}
            >
              <span className="min-w-0 max-w-48 truncate">
                {changedFilesQuery.data.headRef ?? "HEAD"}
              </span>
              <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              <Combobox
                items={baseRefItems}
                filteredItems={filteredBaseRefItems}
                value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
                onOpenChange={(open) => {
                  if (!open) setBaseRefQuery("");
                }}
                onValueChange={(value) => {
                  if (!value) return;
                  selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
                }}
              >
                <ComboboxTrigger
                  className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Change comparison target. Currently ${changedFilesQuery.data.baseRef}`}
                >
                  <span className="min-w-0 truncate">{changedFilesQuery.data.baseRef}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
                </ComboboxTrigger>
                <ComboboxPopup
                  align="start"
                  className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
                >
                  <div className="min-w-0 shrink-0 px-3 pt-2.5">
                    <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                      <SearchIcon
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                      />
                      <ComboboxInput
                        className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                        inputClassName="rounded-none bg-transparent text-sm"
                        placeholder="Search refs..."
                        showTrigger={false}
                        size="sm"
                        unstyled
                        value={baseRefQuery}
                        onChange={(event) => setBaseRefQuery(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                    <span aria-hidden="true" />
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                      <span>Branch</span>
                      <span className="text-right">Remote</span>
                    </div>
                  </div>
                  <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                  <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                    <ComboboxItem
                      className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                      contentClassName="w-full min-w-0 overflow-hidden"
                      value={AUTOMATIC_BASE_REF}
                    >
                      <span className="block min-w-0 truncate">Automatic</span>
                    </ComboboxItem>
                    {baseRefChoices.map((choice) => {
                      const item = valueForBaseRefChoice(choice);
                      const hasBoth = choice.local !== null && choice.remote !== null;
                      const useRemote = choice.remote?.name === item;
                      return (
                        <ComboboxItem
                          key={choice.id}
                          className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                          contentClassName="w-full min-w-0 overflow-hidden"
                          value={item}
                        >
                          <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                            <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                            {hasBoth ? (
                              <div
                                className="flex justify-end"
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <Switch
                                  aria-label={`Use remote version of ${choice.label}`}
                                  checked={useRemote}
                                  className="[--thumb-size:--spacing(3)]"
                                  onCheckedChange={(checked) => {
                                    const nextRef = checked
                                      ? choice.remote?.name
                                      : choice.local?.name;
                                    if (nextRef) selectBranchBaseRef(nextRef);
                                  }}
                                />
                              </div>
                            ) : choice.remote ? (
                              <span
                                className="flex justify-end text-muted-foreground"
                                title="Remote only"
                              >
                                <CheckIcon aria-hidden="true" className="size-3" />
                              </span>
                            ) : null}
                          </div>
                        </ComboboxItem>
                      );
                    })}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </div>
          )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="outline"
                size="xs"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="outline"
                size="xs"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedTurnId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {selectedTurnId === null && changedFilesQuery.error ? (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-red-500/80">
                {changedFilesQuery.error}
              </div>
            ) : selectedTurnId === null && changedFilesQuery.isPending ? (
              <DiffPanelLoadingState label="Loading changed files..." />
            ) : scopeFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                No net changes in this selection.
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                {isMobile ? (
                  <select
                    aria-label="Select changed file"
                    className="m-2 h-8 rounded-md border border-border/70 bg-background px-2 text-xs"
                    value={selectedScopeFilePath ?? ""}
                    onChange={(event) =>
                      setSelectedDiffFile({
                        scopeKey: selectedDiffFileScopeKey,
                        filePath: event.target.value || null,
                      })
                    }
                  >
                    {scopeFiles.map((file) => (
                      <option key={file.path} value={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                ) : (
                  <aside className="min-h-0 w-52 shrink-0 overflow-auto border-r border-border/70 p-2">
                    <DiffFilesTree
                      files={scopeFiles}
                      activeFilePath={selectedScopeFilePath}
                      resolvedTheme={resolvedTheme as DiffThemeType}
                      onSelectFile={(filePath) =>
                        setSelectedDiffFile({ scopeKey: selectedDiffFileScopeKey, filePath })
                      }
                    />
                  </aside>
                )}
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (filePath) openDiffFile(filePath);
                  }}
                >
                  {selectedPatchError && !renderablePatch ? (
                    <div className="px-3 py-2 text-[11px] text-red-500/80">
                      {selectedPatchError}
                    </div>
                  ) : !renderablePatch ? (
                    isLoadingSelectedPatch ? (
                      <DiffPanelLoadingState label="Loading file diff..." />
                    ) : (
                      <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                        {hasNoNetChanges
                          ? "No net changes in this file."
                          : "No patch available for this file."}
                      </div>
                    )
                  ) : renderablePatch.kind === "files" ? (
                    <AnnotatableCodeView
                      viewerRef={codeViewRef}
                      key={collapseScopeKey ?? reviewSectionId}
                      className="diff-render-surface h-full min-h-0 overflow-auto"
                      files={codeViewFiles}
                      sectionId={reviewSectionId}
                      sectionTitle={reviewSectionTitle}
                      composerDraftTarget={composerDraftTarget}
                      renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                        const filePath = resolveFileDiffPath(fileDiff);
                        return (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className={cn(
                                    "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                    getDiffCollapseIconClassName(fileDiff),
                                  )}
                                  aria-label={
                                    collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                  }
                                  aria-expanded={!collapsed}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleDiffFileCollapsed(fileKey);
                                  }}
                                />
                              }
                            >
                              {collapsed ? (
                                <ChevronRightIcon className="size-4" />
                              ) : (
                                <ChevronDownIcon className="size-4" />
                              )}
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              {collapsed ? "Expand diff" : "Collapse diff"}
                            </TooltipPopup>
                          </Tooltip>
                        );
                      }}
                      options={{
                        diffStyle: diffRenderMode === "split" ? "split" : "unified",
                        lineDiffType: "none",
                        overflow: wordWrap ? "wrap" : "scroll",
                        theme: resolveDiffThemeName(resolvedTheme),
                        themeType: resolvedTheme as DiffThemeType,
                        unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                        stickyHeaders: true,
                        layout: { paddingTop: 8, paddingBottom: 8, gap: 8 },
                      }}
                    />
                  ) : (
                    <div className="min-h-0 h-full overflow-auto p-2">
                      <p className="mb-2 text-[11px] text-muted-foreground/75">
                        {renderablePatch.reason}
                      </p>
                      <pre
                        className={cn(
                          "rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                          wordWrap ? "whitespace-pre-wrap wrap-break-word" : "overflow-auto",
                        )}
                      >
                        {renderablePatch.text}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
