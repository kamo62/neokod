import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type { EnvironmentId } from "@neokod/contracts";
import { useState } from "react";

import { symphonyEnvironment } from "../../state/symphony";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

const STALE_REQUEST = "That request is no longer pending. Refresh and check the run.";

/** The RPC code the server returns for a decided/expired request. */
const REQUEST_NOT_FOUND = "approval_request_not_found";

const failureCode = (cause: unknown): string | null =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : null;

const failureMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message.trim() : "";

/**
 * Answer a pending agent request from wherever it is visible (the project
 * Attention tab and the run page).
 *
 * `requestId` is the durable approval record id, which is also the id the
 * server answers on; the live registry id is resolved server-side. The note
 * field doubles as the reject reason and the answer text because a request is
 * only ever one of the two.
 */
export function SymphonyApprovalActions({
  environmentId,
  requestId,
  mode,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  readonly mode: "approval" | "question";
  readonly onDone: () => void;
}) {
  const approve = useAtomCommand(symphonyEnvironment.approve, { reportFailure: false });
  const reject = useAtomCommand(symphonyEnvironment.reject, { reportFailure: false });
  const respond = useAtomCommand(symphonyEnvironment.respondToUserInput, { reportFailure: false });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | "answer" | null>(null);
  const [failure, setFailure] = useState<{
    readonly stale: boolean;
    readonly detail: string;
  } | null>(null);

  const trimmed = note.trim();

  const run = async (next: "approve" | "reject" | "answer") => {
    if (pending !== null) return;
    setPending(next);
    setFailure(null);
    try {
      const result =
        next === "approve"
          ? await approve({ environmentId, input: { requestId, scope: "once" } })
          : next === "reject"
            ? await reject({
                environmentId,
                input: { requestId, ...(trimmed.length > 0 ? { reason: trimmed } : {}) },
              })
            : await respond({ environmentId, input: { requestId, text: trimmed } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          // Only a decided/expired request is reported as stale; a transport or
          // "Symphony unavailable" failure says so instead of claiming the
          // request is gone.
          setFailure({
            stale: failureCode(cause) === REQUEST_NOT_FOUND,
            detail: failureMessage(cause),
          });
        }
        return;
      }
      setNote("");
      onDone();
    } finally {
      setPending(null);
    }
  };

  const disabled = pending !== null;

  return (
    <div className="space-y-2">
      {mode === "approval" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={disabled}
              onClick={() => void run("approve")}
              aria-label="Approve request"
            >
              {pending === "approve" ? <Spinner className="size-3" /> : null}
              Approve
            </Button>
            <Input
              nativeInput
              size="sm"
              className="max-w-64"
              value={note}
              placeholder="Optional note"
              disabled={disabled}
              aria-label="Optional note"
              onChange={(event) => setNote(event.target.value)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              disabled={disabled}
              onClick={() => void run("reject")}
              aria-label="Reject request"
            >
              {pending === "reject" ? <Spinner className="size-3" /> : null}
              Reject
            </Button>
          </div>
        </>
      ) : (
        <>
          <Textarea
            size="sm"
            value={note}
            placeholder="Answer the agent"
            disabled={disabled}
            aria-label="Answer the agent"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={disabled || trimmed.length === 0}
              onClick={() => void run("answer")}
            >
              {pending === "answer" ? <Spinner className="size-3" /> : null}
              Send answer
            </Button>
          </div>
        </>
      )}
      {failure !== null ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive-foreground">
          <p>
            {failure.stale
              ? STALE_REQUEST
              : failure.detail === ""
                ? "The request could not be sent."
                : failure.detail}
          </p>
          {failure.stale && failure.detail !== "" ? (
            <p className="mt-1 text-muted-foreground">{failure.detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
