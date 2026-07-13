import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, Target, XIcon } from "lucide-react";
import { type EnvironmentId, type ThreadId } from "@neokod/contracts";
import { scopeThreadRef } from "@neokod/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import { useThreadShell } from "../../state/entities";
import { selectRailPopoverOpenNonce, useWorkspaceRailUiStore } from "../../workspaceRailUiStore";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

export type GoalStatus = "active" | "done";

export interface GoalPatch {
  readonly goal: string | null;
  readonly goalStatus: GoalStatus;
}

/**
 * Normalize a free-text goal draft + status into the metadata patch.
 *
 * Trust boundary: whitespace-only drafts clear the goal (`goal: null`).
 */
export function goalDraftToPatch(draft: string, status: GoalStatus): GoalPatch {
  const trimmed = draft.trim();
  return { goal: trimmed.length === 0 ? null : trimmed, goalStatus: status };
}

interface GoalChipProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}

export function GoalChip({ environmentId, threadId }: GoalChipProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  // Shell-only subscription: goal/goalStatus live on the thread shell, and the
  // detail atom churns on every streaming delta this chip does not care about.
  const thread = useThreadShell(threadRef);
  const goal = thread?.goal ?? null;
  const goalStatus: GoalStatus = thread?.goalStatus ?? "active";

  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, "thread goal update");

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState<GoalStatus>("active");
  const [saving, setSaving] = useState(false);

  // Open the editor when a `/goal` command (or other caller) requests it.
  const openNonce = useWorkspaceRailUiStore((s) =>
    selectRailPopoverOpenNonce(s, threadRef, "goal"),
  );
  const handledNonce = useRef(openNonce);
  useEffect(() => {
    if (openNonce === handledNonce.current) return;
    handledNonce.current = openNonce;
    setDraft(goal ?? "");
    setDraftStatus(goalStatus);
    setOpen(true);
  }, [openNonce, goal, goalStatus]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(goal ?? "");
      setDraftStatus(goalStatus);
    }
    setOpen(next);
  };

  const submit = async (patch: GoalPatch) => {
    setSaving(true);
    const result = await updateMetadata({
      environmentId,
      input: { threadId, goal: patch.goal, goalStatus: patch.goalStatus },
    });
    setSaving(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update goal",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    setOpen(false);
  };

  const handleSave = () => void submit(goalDraftToPatch(draft, draftStatus));
  const handleClear = () => void submit({ goal: null, goalStatus: "active" });
  const handleToggleStatus = () => {
    const next: GoalStatus = goalStatus === "active" ? "done" : "active";
    void submit({ goal, goalStatus: next });
  };

  const isDone = goalStatus === "done";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {goal ? (
        <div className="flex min-w-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleToggleStatus}
                  disabled={saving}
                  aria-label={isDone ? "Mark goal active" : "Mark goal done"}
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
                    isDone
                      ? "border-emerald-500 bg-emerald-500/15 text-emerald-500"
                      : "border-muted-foreground/40 text-muted-foreground",
                  )}
                />
              }
            >
              {isDone ? <CheckIcon className="size-2.5" /> : null}
            </TooltipTrigger>
            <TooltipPopup side="top">{isDone ? "Goal done" : "Goal active"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  className={cn(
                    "min-w-0 max-w-40 truncate rounded px-1 text-left text-xs text-muted-foreground hover:text-foreground",
                    isDone && "line-through",
                  )}
                />
              }
            >
              {goal}
            </TooltipTrigger>
            <TooltipPopup side="top">{goal}</TooltipPopup>
          </Tooltip>
        </div>
      ) : (
        <PopoverTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Set goal" />}>
          <Target className="size-3.5" />
        </PopoverTrigger>
      )}
      <PopoverPopup align="start" side="bottom" className="w-72">
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What is this thread trying to accomplish?"
            rows={3}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              variant={draftStatus === "active" ? "secondary" : "ghost"}
              onClick={() => setDraftStatus("active")}
            >
              Active
            </Button>
            <Button
              size="xs"
              variant={draftStatus === "done" ? "secondary" : "ghost"}
              onClick={() => setDraftStatus("done")}
            >
              Done
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            {goal ? (
              <Button size="xs" variant="ghost" onClick={handleClear} disabled={saving}>
                <XIcon className="size-3.5" />
                Clear
              </Button>
            ) : (
              <span />
            )}
            <Button size="xs" onClick={handleSave} disabled={saving}>
              Save
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
