import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import type {
  ApprovalAnswerInput,
  ApprovalQuestionPayload,
  EnvironmentId,
  RunAttemptId,
} from "@neokod/contracts";
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

interface DraftAnswer {
  readonly selected: ReadonlyArray<string>;
  readonly custom: string;
}

const emptyDraft: DraftAnswer = { selected: [], custom: "" };

/**
 * Answer a pending agent request from wherever it is visible (the project
 * Attention tab and the run page).
 *
 * `requestId` is the durable approval record id, which is also the id the
 * server answers on; the live registry id is resolved server-side.
 *
 * A question renders its durable question structure (ids, options, multi-select
 * and custom text) and submits one answer per id. A legacy free-text row keeps
 * a single text field. An approval note is explicitly history-only: Codex
 * approval responses carry a decision and no note.
 */
export function SymphonyApprovalActions({
  environmentId,
  requestId,
  runAttemptId,
  questionPayload,
  mode,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  readonly runAttemptId?: RunAttemptId;
  readonly questionPayload?: ApprovalQuestionPayload;
  readonly mode: "approval" | "question";
  readonly onDone: () => void;
}) {
  const approve = useAtomCommand(symphonyEnvironment.approve, { reportFailure: false });
  const reject = useAtomCommand(symphonyEnvironment.reject, { reportFailure: false });
  const respond = useAtomCommand(symphonyEnvironment.respondToUserInput, { reportFailure: false });
  const [note, setNote] = useState("");
  const [legacyAnswer, setLegacyAnswer] = useState("");
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [pending, setPending] = useState<"approve" | "reject" | "answer" | null>(null);
  const [failure, setFailure] = useState<{
    readonly stale: boolean;
    readonly detail: string;
  } | null>(null);

  const trimmed = note.trim();
  const structured = questionPayload?.kind === "structured" ? questionPayload : null;

  const answerInputs = (): ReadonlyArray<ApprovalAnswerInput> | null => {
    if (structured === null) return null;
    const answers: ApprovalAnswerInput[] = [];
    for (const question of structured.questions) {
      const draft = drafts[question.id] ?? emptyDraft;
      const custom = draft.custom.trim();
      if (custom.length > 0) {
        answers.push({ questionId: question.id, answer: custom });
        continue;
      }
      if (question.multiSelect === true) {
        if (draft.selected.length === 0) return null;
        answers.push({ questionId: question.id, answer: [...draft.selected] });
        continue;
      }
      const selected = draft.selected[0];
      if (selected === undefined || selected.length === 0) return null;
      answers.push({ questionId: question.id, answer: selected });
    }
    return answers;
  };

  const canSubmitAnswer =
    mode === "question" &&
    (structured !== null
      ? answerInputs() !== null
      : questionPayload?.kind === "legacy_text"
        ? legacyAnswer.trim().length > 0
        : false);

  const run = async (next: "approve" | "reject" | "answer") => {
    if (pending !== null) return;
    setPending(next);
    setFailure(null);
    try {
      const result =
        next === "approve"
          ? await approve({
              environmentId,
              input: {
                requestId,
                scope: "once",
                ...(trimmed.length > 0 ? { note: trimmed } : {}),
                ...(runAttemptId !== undefined ? { runAttemptId } : {}),
              },
            })
          : next === "reject"
            ? await reject({
                environmentId,
                input: {
                  requestId,
                  ...(trimmed.length > 0 ? { note: trimmed } : {}),
                  ...(runAttemptId !== undefined ? { runAttemptId } : {}),
                },
              })
            : await respond({
                environmentId,
                input: {
                  requestId,
                  ...(structured !== null
                    ? { answers: answerInputs() ?? [] }
                    : { text: legacyAnswer.trim() }),
                  ...(runAttemptId !== undefined ? { runAttemptId } : {}),
                },
              });
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
      setLegacyAnswer("");
      setDrafts({});
      onDone();
    } finally {
      setPending(null);
    }
  };

  const disabled = pending !== null;

  const setDraft = (questionId: string, next: DraftAnswer) =>
    setDrafts((current) => ({ ...current, [questionId]: next }));

  return (
    <div className="space-y-2">
      {mode === "approval" ? (
        <>
          <Input
            nativeInput
            size="sm"
            className="max-w-72"
            value={note}
            placeholder="Note (saved to history only)"
            disabled={disabled}
            aria-label="Optional note"
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="text-[10px] text-muted-foreground">
            Notes are saved to Neokod history only; they are not sent to the agent.
          </p>
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
      ) : structured !== null ? (
        <>
          {structured.questions.map((question) => {
            const draft = drafts[question.id] ?? emptyDraft;
            return (
              <div key={question.id} className="space-y-1.5">
                <p className="text-[11px] font-medium text-foreground">{question.header}</p>
                <p className="text-[11px] text-muted-foreground">{question.question}</p>
                {question.options.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={question.header}>
                    {question.options.map((option) => {
                      const selected = draft.selected.includes(option.label);
                      return (
                        <Button
                          key={option.label}
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          className="h-7 px-2 text-[11px]"
                          disabled={disabled}
                          aria-pressed={selected}
                          aria-label={`${question.header}: ${option.label}`}
                          title={option.description}
                          onClick={() =>
                            setDraft(question.id, {
                              custom: "",
                              selected:
                                question.multiSelect === true
                                  ? selected
                                    ? draft.selected.filter((label) => label !== option.label)
                                    : [...draft.selected, option.label]
                                  : [option.label],
                            })
                          }
                        >
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
                <Input
                  nativeInput
                  size="sm"
                  value={draft.custom}
                  placeholder={
                    question.options.length > 0 ? "Or type a custom answer" : "Type your answer"
                  }
                  disabled={disabled}
                  aria-label={`Custom answer for ${question.header}`}
                  onChange={(event) =>
                    setDraft(question.id, { selected: [], custom: event.target.value })
                  }
                />
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={disabled || !canSubmitAnswer}
              onClick={() => void run("answer")}
              aria-label="Send answer"
            >
              {pending === "answer" ? <Spinner className="size-3" /> : null}
              Send answer
            </Button>
          </div>
        </>
      ) : questionPayload?.kind === "legacy_text" ? (
        <>
          <p className="text-[11px] text-muted-foreground">{questionPayload.text}</p>
          <Textarea
            size="sm"
            value={legacyAnswer}
            placeholder="Answer the agent"
            disabled={disabled}
            aria-label="Answer the agent"
            onChange={(event) => setLegacyAnswer(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={disabled || !canSubmitAnswer}
              onClick={() => void run("answer")}
              aria-label="Send answer"
            >
              {pending === "answer" ? <Spinner className="size-3" /> : null}
              Send answer
            </Button>
          </div>
        </>
      ) : (
        <p className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
          This request did not record answerable questions. It cannot be answered here; refresh the
          run and check for a current request.
        </p>
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
