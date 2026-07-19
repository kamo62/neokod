import { type TurnId } from "@neokod/contracts";
import { memo, useCallback, useMemo, useState } from "react";
import { type TurnDiffFileChange } from "../../types";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import { ChevronRightIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Button } from "../ui/button";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const {
    turnId,
    files,
    allDirectoriesExpanded,
    resolvedTheme,
    onToggleAllDirectories,
    onOpenTurnDiff,
  } = props;
  const summaryStat = useMemo(() => summarizeTurnDiffStats(files), [files]);

  return (
    <div className="relative mt-4 rounded-2xl bg-card/40 shadow-xs/5 not-dark:bg-clip-padding after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-2xl after:border after:border-input">
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-t-2xl bg-card/72 p-3 backdrop-blur-md">
        <p className="flex min-w-0 flex-1 items-center gap-1 font-medium text-foreground text-xs leading-4">
          <span className="truncate">{files.length} changed files</span>
          {hasNonZeroStat(summaryStat) && (
            <DiffStatLabel
              additions={summaryStat.additions}
              className="shrink-0 text-xs leading-4"
              deletions={summaryStat.deletions}
              layout="inline"
            />
          )}
        </p>
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap justify-end gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={onToggleAllDirectories}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnId, files[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <div className="px-2 pb-2">
        <ChangedFilesTree
          key={`changed-files-tree:${turnId}`}
          turnId={turnId}
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme={resolvedTheme}
          onOpenTurnDiff={onOpenTurnDiff}
        />
      </div>
    </div>
  );
});

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, turnId } = props;
  return (
    <DiffFilesTree
      files={files}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onSelectFile={(path) => onOpenTurnDiff(turnId, path)}
    />
  );
});

export const DiffFilesTree = memo(function DiffFilesTree(props: {
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded?: boolean;
  activeFilePath?: string | null;
  resolvedTheme: "light" | "dark";
  onSelectFile: (path: string) => void;
}) {
  const {
    files,
    allDirectoriesExpanded = false,
    activeFilePath,
    onSelectFile,
    resolvedTheme,
  } = props;
  const [filter, setFilter] = useState("");
  const matchingFiles = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query ? files.filter((file) => file.path.toLocaleLowerCase().includes(query)) : files;
  }, [files, filter]);
  const treeNodes = useMemo(() => buildTurnDiffTree(matchingFiles), [matchingFiles]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onSelectFile(node.path)}
        aria-current={node.path === activeFilePath ? "true" : undefined}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          node.path === activeFilePath && "bg-accent text-foreground",
        )}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <PierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="truncate font-mono text-[11px] text-muted-foreground/80 group-hover:text-foreground/90">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="sr-only">Filter changed files</span>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files..."
          className="h-7 w-full rounded-md border border-border/70 bg-background/60 px-2 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>
    </div>
  );
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
