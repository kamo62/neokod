import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { resolveDefaultBranchActionDialogCopy } from "../GitActionsControl.logic";
import type { ChangeRequestTerminology } from "../../sourceControlPresentation";
import type { PendingDefaultBranchAction } from "./useGitActionsController";

export interface GitDefaultBranchConfirmDialogProps {
  pendingAction: PendingDefaultBranchAction | null;
  terminology: ChangeRequestTerminology;
  onCancel: () => void;
  onContinue: () => void;
  onCheckoutFeatureBranch: () => void;
}

/**
 * Confirmation prompt shown before running a push/PR-producing action
 * directly on the default branch. Shared between `GitActionsControl` and
 * `EnvironmentPanel` so both surfaces present identical copy and options.
 */
export function GitDefaultBranchConfirmDialog({
  pendingAction,
  terminology,
  onCancel,
  onContinue,
  onCheckoutFeatureBranch,
}: GitDefaultBranchConfirmDialogProps) {
  const copy = pendingAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingAction.action,
        branchName: pendingAction.branchName,
        includesCommit: pendingAction.includesCommit,
        terminology,
      })
    : null;

  return (
    <Dialog
      open={pendingAction !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{copy?.title ?? "Run action on default refName?"}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-wrap sm:items-center">
          <Button
            className="w-full sm:mr-auto sm:w-auto"
            variant="outline"
            size="sm"
            onClick={onCancel}
          >
            Abort
          </Button>
          <Button
            className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
            variant="outline"
            size="sm"
            onClick={onContinue}
          >
            {copy?.continueLabel ?? "Continue"}
          </Button>
          <Button
            className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
            size="sm"
            onClick={onCheckoutFeatureBranch}
          >
            Checkout feature branch & continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
