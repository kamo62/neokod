import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type { EnvironmentId } from "@neokod/contracts";
import { PauseIcon, PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { symphonyEnvironment } from "../../state/symphony";
import { symphonyExtras } from "../../state/symphonyExtras";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  globalActionFailureMessage,
  resolveDispatchDisplayState,
  stopAllMessage,
  type GlobalAction,
} from "./globalControls.logic";

const formatObservedAt = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

export function SymphonyGlobalControls({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const overviewQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.overview({ environmentId, input: {} }),
  );
  const pauseGlobal = useAtomCommand(symphonyExtras.pauseGlobal, { reportFailure: false });
  const resumeGlobal = useAtomCommand(symphonyExtras.resumeGlobal, { reportFailure: false });
  const stopAllRuns = useAtomCommand(symphonyExtras.stopAllRuns, { reportFailure: false });

  const [pendingGlobal, setPendingGlobal] = useState<GlobalAction | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);

  const { data: overview, error: overviewError } = overviewQuery;
  useEffect(() => {
    // A settled overview response supersedes the post-mutation reconciliation
    // window, whether it succeeded or failed.
    setReconciling(false);
  }, [overview, overviewError]);

  const dispatchDisplay = resolveDispatchDisplayState({
    overview,
    overviewError,
    isReconciling: reconciling || overviewQuery.isPending,
  });

  const runGlobalAction = async (envId: EnvironmentId, action: GlobalAction) => {
    setPendingGlobal(action);
    setActionError(null);
    setStopResult(null);
    try {
      const result = await (action === "pause"
        ? pauseGlobal({ environmentId: envId, input: {} })
        : action === "resume"
          ? resumeGlobal({ environmentId: envId, input: {} })
          : stopAllRuns({ environmentId: envId, input: { confirm: "stop-all-runs" } }));
      if (result._tag === "Failure") {
        setActionError(
          globalActionFailureMessage(action, {
            interrupted: isAtomCommandInterrupted(result),
            cause: squashAtomCommandFailure(result),
          }),
        );
      } else if (action === "stop") {
        setStopResult(stopAllMessage(result.value.ok));
      }
      setReconciling(true);
      overviewQuery.refresh();
    } finally {
      setPendingGlobal(null);
    }
  };

  const retryOverview = () => {
    setActionError(null);
    setReconciling(true);
    overviewQuery.refresh();
  };

  const actionDisabled = environmentId === null || pendingGlobal !== null;

  const pauseButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={actionDisabled}
      onClick={() => environmentId !== null && void runGlobalAction(environmentId, "pause")}
      aria-label="Pause all dispatch"
    >
      {pendingGlobal === "pause" ? (
        <Spinner className="size-3.5" />
      ) : (
        <PauseIcon className="size-3.5" />
      )}
      Pause all
    </Button>
  );
  const resumeButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={actionDisabled}
      onClick={() => environmentId !== null && void runGlobalAction(environmentId, "resume")}
      aria-label="Resume all dispatch"
    >
      {pendingGlobal === "resume" ? (
        <Spinner className="size-3.5" />
      ) : (
        <PlayIcon className="size-3.5" />
      )}
      Resume all
    </Button>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span
          className={
            dispatchDisplay.state === "unknown"
              ? "text-xs text-warning-foreground"
              : "text-xs text-muted-foreground"
          }
        >
          {dispatchDisplay.label}
        </span>
        {dispatchDisplay.state === "known"
          ? dispatchDisplay.paused
            ? resumeButton
            : pauseButton
          : null}
        {dispatchDisplay.state === "unknown" ? (
          <>
            {pauseButton}
            {resumeButton}
            <Button
              size="sm"
              variant="ghost"
              disabled={overviewQuery.isPending}
              onClick={retryOverview}
              aria-label="Retry dispatch state"
            >
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="destructive"
          disabled={actionDisabled}
          onClick={() => setStopConfirmOpen(true)}
          aria-label="Stop all runs"
        >
          {pendingGlobal === "stop" ? (
            <Spinner className="size-3.5" />
          ) : (
            <SquareIcon className="size-3.5" />
          )}
          Stop all runs
        </Button>
      </div>
      {dispatchDisplay.state === "unknown" && dispatchDisplay.lastConfirmed !== null ? (
        <p className="text-[11px] text-muted-foreground">
          Last confirmed: {dispatchDisplay.lastConfirmed.paused ? "paused" : "active"} at{" "}
          {formatObservedAt(dispatchDisplay.lastConfirmed.observedAt)}
        </p>
      ) : null}
      {dispatchDisplay.state === "unknown" && dispatchDisplay.error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground"
        >
          {dispatchDisplay.error}
        </p>
      ) : null}
      {actionError === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground"
        >
          {actionError}
        </p>
      )}
      {stopResult === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {stopResult}
        </p>
      )}

      <AlertDialog
        open={stopConfirmOpen}
        onOpenChange={(open) => {
          if (pendingGlobal === null) setStopConfirmOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop all runs?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels every in-flight Symphony run across every project right now. It cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={pendingGlobal !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingGlobal !== null || environmentId === null}
              onClick={() => {
                setStopConfirmOpen(false);
                if (environmentId !== null) void runGlobalAction(environmentId, "stop");
              }}
            >
              {pendingGlobal === "stop" ? <Spinner className="size-3.5" /> : null}
              Stop all runs
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
