/**
 * Fork-owned compact "workspace rail" for the thread header.
 *
 * Icon-first, dense control row that surfaces at-a-glance thread state and
 * quick actions by REUSING existing stores/surfaces — it owns no terminal,
 * panel, or picker of its own. Every indicator is backed by real state; there
 * are no dead placeholder slots.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { FileDiff, TerminalSquare } from "lucide-react";
import { memo, useMemo } from "react";
import { useComposerHandleContext } from "../../composerHandleContext";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThread } from "../../state/entities";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
} from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CopilotThreadControls } from "./CopilotThreadControls";
import { CopilotMcpControls } from "./CopilotMcpControls";

export interface ThreadWorkspaceRailView {
  /** Active model slug, or null when the thread has no resolved selection yet. */
  modelLabel: string | null;
  /** Reused terminal presentation; non-null only while a subprocess runs. */
  terminal: TerminalStatusIndicator | null;
  /** The diff surface is the git/diff surface, so it only makes sense with a workspace. */
  showDiff: boolean;
  /** Fleet chip is Copilot-only and never shown unless fleet mode is enabled. */
  showFleet: boolean;
}

/**
 * Pure decision for what the rail renders. Kept separate from the JSX so the
 * "only real state, no dead slots" rule has one runnable check behind it.
 */
export function resolveThreadWorkspaceRailView(input: {
  modelSelection: ModelSelection | null | undefined;
  runningTerminalIds: ReadonlyArray<string>;
  hasWorkspace: boolean;
  fleetMode: boolean;
}): ThreadWorkspaceRailView {
  return {
    modelLabel: input.modelSelection?.model ?? null,
    terminal: terminalStatusFromRunningIds(input.runningTerminalIds),
    showDiff: input.hasWorkspace,
    showFleet: input.fleetMode === true,
  };
}

export const ThreadWorkspaceRail = memo(function ThreadWorkspaceRail({
  environmentId,
  threadId,
  activeProjectName,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  activeProjectName: string | undefined;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const modelSelection = useThread(threadRef)?.modelSelection;
  const runningTerminalIds = useThreadRunningTerminalIds({ environmentId, threadId });
  const fleetMode = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providers.githubCopilot.fleetMode,
  );
  const setTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const openRightPanel = useRightPanelStore((s) => s.open);
  const composerHandle = useComposerHandleContext();

  const view = useMemo(
    () =>
      resolveThreadWorkspaceRailView({
        modelSelection,
        runningTerminalIds,
        hasWorkspace: Boolean(activeProjectName),
        fleetMode,
      }),
    [modelSelection, runningTerminalIds, activeProjectName, fleetMode],
  );

  return (
    <div className="flex shrink-0 items-center gap-1">
      {view.modelLabel &&
        (composerHandle ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => composerHandle.current?.openModelPicker()}
                />
              }
            >
              <span className="max-w-32 truncate">{view.modelLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Model: {view.modelLabel} — click to change</TooltipPopup>
          </Tooltip>
        ) : (
          <span className="max-w-32 truncate text-xs text-muted-foreground">{view.modelLabel}</span>
        ))}

      {view.terminal && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={view.terminal.label}
                className={`inline-flex size-3.5 items-center justify-center ${view.terminal.colorClass}`}
              />
            }
          >
            <span
              className={`size-[7px] rounded-full bg-current ${view.terminal.pulse ? "animate-pulse" : ""}`}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{view.terminal.label}</TooltipPopup>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open terminal"
              onClick={() => setTerminalOpen(threadRef, true)}
            />
          }
        >
          <TerminalSquare aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">Open terminal</TooltipPopup>
      </Tooltip>

      {view.showDiff && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Open diff"
                onClick={() => openRightPanel(threadRef, "diff")}
              />
            }
          >
            <FileDiff aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open diff</TooltipPopup>
        </Tooltip>
      )}

      {view.showFleet && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex h-6 items-center rounded-md border border-input px-1.5 text-[10px] font-medium text-muted-foreground" />
            }
          >
            Fleet
          </TooltipTrigger>
          <TooltipPopup side="top">Copilot fleet mode enabled</TooltipPopup>
        </Tooltip>
      )}

      <CopilotThreadControls environmentId={environmentId} threadRef={threadRef} />
      <CopilotMcpControls environmentId={environmentId} threadRef={threadRef} />
    </div>
  );
});
