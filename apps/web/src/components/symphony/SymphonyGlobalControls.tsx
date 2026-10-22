import type { EnvironmentId } from "@neokod/contracts";
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

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
import { dispatchStateLabel, stopAllMessage } from "./globalControls.logic";

type GlobalAction = "pause" | "resume" | "stop";

export function SymphonyGlobalControls({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const overviewQuery = useEnvironmentQuery(
    environmentId === null ? null : symphonyEnvironment.overview({ environmentId, input: {} }),
  );
  const orchestratorPaused = overviewQuery.data?.orchestratorPaused ?? null;
  const pauseGlobal = useAtomCommand(symphonyExtras.pauseGlobal);
  const resumeGlobal = useAtomCommand(symphonyExtras.resumeGlobal);
  const stopAllRuns = useAtomCommand(symphonyExtras.stopAllRuns);

  const [pendingGlobal, setPendingGlobal] = useState<GlobalAction | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);

  const runGlobalAction = async (envId: EnvironmentId, action: GlobalAction) => {
    setPendingGlobal(action);
    setStopResult(null);
    try {
      const result = await (action === "pause"
        ? pauseGlobal({ environmentId: envId, input: {} })
        : action === "resume"
          ? resumeGlobal({ environmentId: envId, input: {} })
          : stopAllRuns({ environmentId: envId, input: { confirm: "stop-all-runs" } }));
      if (result._tag === "Success") {
        if (action === "stop") {
          setStopResult(stopAllMessage(result.value.ok));
        }
        overviewQuery.refresh();
      }
    } finally {
      setPendingGlobal(null);
    }
  };

  const actionDisabled = environmentId === null || pendingGlobal !== null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-muted-foreground">
          {dispatchStateLabel(orchestratorPaused)}
        </span>
        {orchestratorPaused === true ? (
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
        ) : (
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
        )}
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
