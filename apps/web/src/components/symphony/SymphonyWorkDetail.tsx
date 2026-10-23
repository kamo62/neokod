import { Link } from "@tanstack/react-router";
import { ActivityIcon, GitBranchIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type {
  AcceptedGuidanceSnapshot,
  AcceptedInstructionText,
  ApprovalRequest,
  EnvironmentId,
  EvidenceBundle,
  RunAttempt,
  RunAttemptId,
  RunDetails,
  SymphonyBoardCard,
  SymphonyProject,
  SymphonyStopResult,
} from "@neokod/contracts";
import { RunAttemptId as RunAttemptIdValue } from "@neokod/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { symphonyEnvironment } from "../../state/symphony";
import { cn } from "../../lib/utils";
import type {
  SymphonyWorkAction,
  SymphonyWorkAttentionEntry,
  SymphonyWorkAttempt,
  SymphonyWorkAttemptOutcome,
  SymphonyWorkItemProjection,
} from "../../symphonyWork.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { PullRequestPanel } from "./PullRequestPanel";
import { SymphonyApprovalActions } from "./SymphonyApprovalActions";
import type { WorkRowTone } from "./SymphonyWorkList";
import { approvalRequestHistory, approvalRequestMode } from "./attention.logic";
import { runAttemptStatusBadgeVariant } from "./runAttemptStatus.logic";

export const DETAIL_TABS = ["activity", "plan", "execution", "evidence"] as const;

export type DetailTab = (typeof DETAIL_TABS)[number];

const DETAIL_TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  activity: "Activity",
  plan: "Plan",
  execution: "Execution",
  evidence: "Evidence",
};

export const lifecycleLabel = (value: string): string => value.replaceAll("_", " ");

export function workLifecyclePresentation(item: SymphonyWorkItemProjection): {
  readonly label: string;
  readonly tone: WorkRowTone;
} {
  const lifecycle = item.lifecycle;
  if (lifecycle.phase === "not_started") {
    return {
      label: "Not started",
      tone: lifecycle.reason === "draft" ? "secondary" : "warning",
    };
  }
  if (lifecycle.phase === "in_progress") {
    return {
      label: lifecycleLabel(lifecycle.lifecycle),
      tone: lifecycle.lifecycle === "waiting_for_approval" ? "warning" : "info",
    };
  }
  if (lifecycle.phase === "finished") {
    return {
      label: lifecycleLabel(lifecycle.outcome),
      tone:
        lifecycle.outcome === "completed"
          ? "success"
          : lifecycle.outcome === "failed"
            ? "error"
            : "secondary",
    };
  }
  return { label: "Unknown", tone: "warning" };
}

const noAttemptCopy = (input: {
  readonly knownRunAttemptId: RunAttemptId | null;
  readonly attemptState: "known" | "none" | "unknown";
  readonly attemptReason: string | null;
}): string => {
  if (input.knownRunAttemptId !== null) {
    return `The exact attempt ${String(input.knownRunAttemptId)} was not returned by the server. Open the exact run or refresh.`;
  }
  if (input.attemptState === "unknown") {
    return (
      input.attemptReason ??
      "No current attempt is loaded. The run list is capped and completeness is not reported."
    );
  }
  return "No execution attempt is recorded for this item.";
};

function ExactRunLink({ runAttemptId }: { readonly runAttemptId: RunAttemptId | null }) {
  if (runAttemptId === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      render={
        <Link to="/symphony/$runId" params={{ runId: runAttemptId }}>
          Open exact run
        </Link>
      }
    />
  );
}

export function Timeline({ details }: { readonly details: RunDetails }) {
  return (
    <div className="rounded-2xl border bg-card">
      {details.timeline.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No events recorded yet.
        </div>
      ) : (
        <ol className="divide-y divide-border/60">
          {details.timeline.map((event) => (
            <li key={event.sequence} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
              <ActivityIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-foreground">{event.eventType}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleTimeString()}
                  </span>
                </div>
                {event.payload !== undefined && Object.keys(event.payload).length > 0 ? (
                  <pre className="max-h-24 overflow-y-auto rounded-md bg-muted/50 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function EvidencePanel({ evidence }: { readonly evidence: EvidenceBundle }) {
  const assessmentVariant =
    evidence.overallAssessment === "ready_for_review"
      ? "success"
      : evidence.overallAssessment === "ready_with_warnings"
        ? "warning"
        : evidence.overallAssessment === "failed"
          ? "error"
          : "secondary";
  return (
    <div className="rounded-2xl border bg-card px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[12px] font-semibold text-foreground">Evidence</h2>
        <Badge variant={assessmentVariant} size="sm">
          {lifecycleLabel(evidence.overallAssessment)}
        </Badge>
      </div>

      {evidence.implementationSummary !== undefined ? (
        <p className="mb-3 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
          {evidence.implementationSummary}
        </p>
      ) : null}

      {evidence.changedFiles.length > 0 ? (
        <div className="mb-3">
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">Changed files</h3>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Path</th>
                <th className="py-1 pr-3 text-right font-medium">+</th>
                <th className="py-1 text-right font-medium">-</th>
              </tr>
            </thead>
            <tbody>
              {evidence.changedFiles.map((file) => (
                <tr key={file.path} className="border-b border-border/40 last:border-0">
                  <td className="py-1 pr-3 font-mono text-foreground">{file.path}</td>
                  <td className="py-1 pr-3 text-right text-emerald-600">{file.additions ?? 0}</td>
                  <td className="py-1 text-right text-red-500">{file.deletions ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {evidence.validationResults.length > 0 ? (
        <div>
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">Validation</h3>
          <ul className="space-y-1">
            {evidence.validationResults.map((result) => (
              <li key={result.command} className="flex items-center gap-2">
                <Badge
                  variant={
                    result.status === "passed"
                      ? "success"
                      : result.status === "failed"
                        ? "error"
                        : "secondary"
                  }
                  size="sm"
                >
                  {result.status}
                </Badge>
                <code className="truncate font-mono text-[11px] text-muted-foreground">
                  {result.command}
                </code>
                {result.durationMs !== undefined ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {(result.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const Muted = ({ children }: { readonly children: string }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
);

export const stopAcknowledgementNote = (result: SymphonyStopResult): string => {
  const outcome = result.outcome;
  if (outcome?.status === "confirmed") {
    return `Stop confirmed by the server: ${outcome.evidence}. Ownership ${
      outcome.released ? "released" : "not released"
    }.`;
  }
  if (outcome?.status === "held") {
    return `Stop held: ${outcome.reason}${
      outcome.detail === undefined ? "." : `. ${outcome.detail}`
    } Ownership was not released.`;
  }
  return "Stop acknowledgement did not include a confirmed or held outcome. The attempt may still be running; this is not confirmation.";
};

export function AttemptOutcomeBadge({ outcome }: { readonly outcome: SymphonyWorkAttemptOutcome }) {
  if (outcome.state === "stopped") {
    return (
      <Badge variant="success" size="sm">
        Stop confirmed
      </Badge>
    );
  }
  if (outcome.state === "stop_requested") {
    return (
      <Badge variant="warning" size="sm">
        Stop requested; closure unknown
      </Badge>
    );
  }
  if (outcome.state === "unknown") {
    return (
      <Badge variant="warning" size="sm">
        Outcome unknown
      </Badge>
    );
  }
  return null;
}

export function AttemptAttribution({ attempt }: { readonly attempt: RunAttempt }) {
  return (
    <p className="text-[10px] leading-relaxed text-muted-foreground">
      Attempt {attempt.attemptNumber} · {attempt.provider.instanceId} ({attempt.provider.driver})
      {attempt.model === undefined ? "" : ` · ${attempt.model}`} · target{" "}
      <span className="font-mono">{attempt.workspacePath}</span>
    </p>
  );
}

const requestStateVariant = (
  state: ApprovalRequest["state"],
): "error" | "info" | "secondary" | "success" | "warning" => {
  switch (state) {
    case "approved":
      return "success";
    case "rejected":
      return "error";
    case "delivering":
      return "warning";
    case "answered":
      return "info";
    case "expired":
    case "interrupted":
      return "secondary";
    case "pending":
      return "warning";
  }
};

/**
 * Durable history for decided requests. Answered questions stay distinct from
 * permission approvals, stored answers retain redaction, and notes are labelled
 * history-only because the provider never receives them.
 */
export function ApprovalRequestHistoryList({
  requests,
}: {
  readonly requests: ReadonlyArray<ApprovalRequest>;
}) {
  const decided = requests.filter((request) => request.state !== "pending");
  if (decided.length === 0) return null;
  return (
    <section className="rounded-2xl border bg-card px-4 py-4">
      <h2 className="text-[12px] font-semibold text-foreground">Request history</h2>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Durable Neokod history. A stored answer or note is not proof that the provider received it.
      </p>
      <ul className="mt-3 divide-y divide-border/60">
        {decided.map((request) => {
          const history = approvalRequestHistory(request);
          const mode = approvalRequestMode(request);
          return (
            <li key={request.id} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-foreground">
                  {mode === "question"
                    ? history.deliveryPending
                      ? "Question answer delivery pending"
                      : history.answered
                        ? "Question answered"
                        : "Question closed"
                    : `Approval ${request.state}`}
                </span>
                <Badge variant={requestStateVariant(request.state)} size="sm">
                  {request.state}
                </Badge>
                {request.decidedAt === null ? null : (
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(request.decidedAt).toLocaleString()}
                  </span>
                )}
                {request.command === undefined ? null : (
                  <code className="truncate font-mono text-[10px] text-muted-foreground">
                    {request.command}
                  </code>
                )}
              </div>
              {history.answerText !== null ? (
                <div className="space-y-1">
                  <p className="whitespace-pre-wrap text-[11px] text-foreground">
                    {history.answerText}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {history.answerRedacted ? (
                      <Badge variant="warning" size="sm">
                        Redacted
                      </Badge>
                    ) : null}
                    {history.answerDeliveryLabel === null ? null : (
                      <span className="text-[10px] text-muted-foreground">
                        {history.answerDeliveryLabel}
                      </span>
                    )}
                  </div>
                </div>
              ) : history.answered || history.deliveryPending ? (
                <p className="text-[11px] text-muted-foreground">
                  No answer content was stored for this request.
                </p>
              ) : null}
              {history.noteText === null ? null : (
                <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                  <p className="whitespace-pre-wrap text-[11px] text-foreground">
                    Note: {history.noteText}
                  </p>
                  {history.noteDeliveryLabel === null ? null : (
                    <p className="text-[10px] text-muted-foreground">{history.noteDeliveryLabel}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RequestActions({
  environmentId,
  entry,
  request,
  actions,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: SymphonyWorkAttentionEntry;
  readonly request: ApprovalRequest | null;
  /** Projected actions for this item. Omitted only for out-of-board entries. */
  readonly actions?: ReadonlyArray<SymphonyWorkAction> | undefined;
  readonly onRefresh: () => void;
}) {
  if (entry.mode === "info") return null;

  const projected =
    actions?.filter((action) => String(action.attentionItemId) === String(entry.item.id)) ?? null;
  if (projected !== null) {
    const available = projected.filter((action) => action.state === "available");
    const availableKinds = new Set(available.map((action) => action.kind));
    const required = entry.mode === "question" ? ["answer"] : ["approve", "reject"];
    if (!required.every((kind) => availableKinds.has(kind as SymphonyWorkAction["kind"]))) {
      const unavailable = projected.find(
        (action) => action.state === "blocked" || action.state === "unknown",
      );
      return (
        <p className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
          {unavailable?.reason ??
            "This request is not currently actionable in the loaded evidence."}
        </p>
      );
    }
  } else {
    // Out-of-board attention is not part of a work-item projection, so its
    // exact pending request is the only available authority.
    const fallbackAvailable =
      entry.mode === "question"
        ? entry.item.availableActions.includes("answer")
        : entry.item.availableActions.includes("approve") &&
          entry.item.availableActions.includes("reject");
    if (!fallbackAvailable) {
      return (
        <p className="text-[11px] text-muted-foreground">
          This request has no supported action in the loaded payload.
        </p>
      );
    }
  }

  if (request === null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        The exact request record is not loaded. Load the exact attempt before answering.
      </p>
    );
  }
  if (request.state !== "pending") {
    return (
      <p className="text-[11px] text-muted-foreground">
        This request is already {request.state}. Its durable history is shown separately.
      </p>
    );
  }

  const exactRunAttemptId = entry.runAttemptId ?? request.runAttemptId;
  return (
    <SymphonyApprovalActions
      environmentId={environmentId}
      requestId={String(request.id)}
      {...(exactRunAttemptId === undefined ? {} : { runAttemptId: exactRunAttemptId })}
      {...(request.questionPayload === undefined
        ? {}
        : { questionPayload: request.questionPayload })}
      mode={entry.mode}
      onDone={onRefresh}
    />
  );
}

/**
 * Loads one older request's exact attempt only when the operator asks for it.
 * It never borrows the selected/newest attempt's payload or provider.
 */
export function ExactRequestActions({
  environmentId,
  entry,
  actions,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: SymphonyWorkAttentionEntry;
  readonly actions?: ReadonlyArray<SymphonyWorkAction> | undefined;
  readonly onRefresh: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const query = useEnvironmentQuery(
    loaded && entry.runAttemptId !== null
      ? symphonyEnvironment.getRun({
          environmentId,
          input: { runAttemptId: RunAttemptIdValue.make(entry.runAttemptId) },
        })
      : null,
  );

  if (entry.runAttemptId === null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No exact attempt is recorded for this request, so it cannot be answered from this view.
      </p>
    );
  }
  if (!loaded) {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] text-muted-foreground">
          Owning attempt <span className="font-mono">{String(entry.runAttemptId)}</span>
        </p>
        <Button size="sm" variant="outline" onClick={() => setLoaded(true)}>
          Load exact request
        </Button>
      </div>
    );
  }
  if (query.isPending && query.data === null) {
    return (
      <p className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
        <Spinner className="size-3" />
        Loading the exact request.
      </p>
    );
  }
  if (query.error !== null && query.data === null) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-destructive-foreground">
          Could not load the exact request. {query.error}
        </p>
        <Button size="sm" variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  const request =
    query.data?.approvalRequests.find(
      (candidate) => String(candidate.id) === String(entry.item.id),
    ) ?? null;
  if (request === null) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          The exact attempt no longer contains this request. It may have been decided elsewhere;
          refresh the page or open the exact run.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Refresh attempt
          </Button>
          <ExactRunLink runAttemptId={entry.runAttemptId} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {query.data === null ? null : <AttemptAttribution attempt={query.data.runAttempt} />}
      <RequestActions
        environmentId={environmentId}
        entry={entry}
        request={request}
        actions={actions}
        onRefresh={() => {
          query.refresh();
          onRefresh();
        }}
      />
    </div>
  );
}

function RequestList({
  details,
  entries,
  actions,
  environmentId,
  onRefresh,
}: {
  readonly details: RunDetails | null;
  readonly entries: ReadonlyArray<SymphonyWorkAttentionEntry>;
  readonly actions: ReadonlyArray<SymphonyWorkAction>;
  readonly environmentId: EnvironmentId | null;
  readonly onRefresh: () => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="rounded-2xl border bg-card px-4 py-3">
      <h2 className="mb-2 text-[12px] font-semibold text-foreground">Waiting for you</h2>
      <ul className="divide-y divide-border/60">
        {entries.map((entry) => {
          const request =
            details?.approvalRequests.find(
              (candidate) => String(candidate.id) === String(entry.item.id),
            ) ?? null;
          const sameAttempt =
            details !== null &&
            entry.runAttemptId !== null &&
            String(entry.runAttemptId) === String(details.runAttempt.id);
          const attributionAttempt =
            details !== null &&
            (sameAttempt ||
              (request?.runAttemptId !== undefined &&
                String(request.runAttemptId) === String(details.runAttempt.id)))
              ? details.runAttempt
              : null;
          return (
            <li key={entry.item.id} className="space-y-2 py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 flex-1 text-xs text-foreground">
                  {entry.item.whatHappened}
                </span>
                <Badge variant="warning" size="sm">
                  {lifecycleLabel(entry.item.kind)}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">{entry.item.whyHuman}</p>
              {attributionAttempt === null ? null : (
                <AttemptAttribution attempt={attributionAttempt} />
              )}
              <div className="flex flex-wrap items-center gap-2">
                {entry.runAttemptId === null ? null : (
                  <Link
                    to="/symphony/$runId"
                    params={{ runId: entry.runAttemptId }}
                    className="text-[11px] text-muted-foreground underline"
                  >
                    Open exact run
                  </Link>
                )}
                {entry.runAttemptId === null ? (
                  <span className="text-[11px] text-muted-foreground">
                    No exact attempt is attached to this request.
                  </span>
                ) : null}
              </div>
              {environmentId === null || entry.mode === "info" ? null : request !== null ? (
                <RequestActions
                  environmentId={environmentId}
                  entry={entry}
                  request={request}
                  actions={actions}
                  onRefresh={onRefresh}
                />
              ) : sameAttempt ? (
                <p className="text-[11px] text-muted-foreground">
                  This request is not present in the loaded attempt record. Refresh or open the
                  exact run.
                </p>
              ) : (
                <ExactRequestActions
                  environmentId={environmentId}
                  entry={entry}
                  actions={actions}
                  onRefresh={onRefresh}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const instructionText = (value: AcceptedInstructionText): string => {
  if (value.state === "absent") return "Not provided";
  return value.text.trim().length === 0 ? "Provided, empty" : value.text;
};

const requiredLabel = (value: boolean | null): string => {
  if (value === null) return "Not stated";
  return value ? "Required" : "Not required";
};

const permissionValue = (
  permission: AcceptedGuidanceSnapshot["permission"],
): ReadonlyArray<{ readonly label: string; readonly value: string }> => [
  { label: "Autonomy", value: permission.autonomy },
  { label: "Approval policy", value: permission.approvalPolicy },
  { label: "Thread sandbox", value: permission.threadSandbox },
  {
    label: "Turn sandbox",
    value:
      permission.turnSandboxPolicy.type === "readOnly"
        ? "Read only"
        : permission.turnSandboxPolicy.type === "workspaceWrite"
          ? "Workspace write"
          : "Danger full access",
  },
  { label: "Edits", value: permission.editsAllowed ? "Allowed" : "Blocked" },
  { label: "Approvals", value: permission.approvalsEnabled ? "Enabled" : "Disabled" },
  {
    label: "Protected paths",
    value:
      permission.protectedPaths.length === 0
        ? "None recorded"
        : permission.protectedPaths.join(", "),
  },
  {
    label: "Approval before push",
    value: requiredLabel(permission.delivery.approvalBeforePush),
  },
  {
    label: "Approval before pull request",
    value: requiredLabel(permission.delivery.approvalBeforePullRequest),
  },
  {
    label: "Approval before merge",
    value: requiredLabel(permission.delivery.approvalBeforeMerge),
  },
];

function AcceptedGuidancePanel({
  snapshot,
  workItem,
}: {
  readonly snapshot: AcceptedGuidanceSnapshot;
  readonly workItem: RunDetails["workItem"];
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border bg-card px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[12px] font-semibold text-foreground">Accepted brief</h2>
          <Badge variant="info" size="sm">
            Frozen at admission
          </Badge>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Accepted {new Date(snapshot.acceptedAt).toLocaleString()} · digest{" "}
          <span className="font-mono">{snapshot.digest}</span>
        </p>

        <details className="mt-3 rounded-xl border bg-muted/20" open>
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-foreground">
            Source snapshot
          </summary>
          <div className="space-y-2 border-t px-3 py-3">
            <p className="text-xs font-medium text-foreground">{snapshot.source.title}</p>
            <p className="text-[11px] text-muted-foreground">
              {snapshot.source.kind} · {snapshot.source.identifier} · tracker revision{" "}
              {snapshot.source.revision === null
                ? "not reported"
                : new Date(snapshot.source.revision).toLocaleString()}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Source digest <span className="font-mono">{snapshot.source.digest}</span>
            </p>
            {snapshot.source.description === null ? (
              <p className="text-[11px] text-muted-foreground">No description was accepted.</p>
            ) : (
              <p className="whitespace-pre-wrap text-[11px] text-foreground">
                {snapshot.source.description}
              </p>
            )}
            {snapshot.source.acceptanceCriteria.length === 0 ? null : (
              <ul className="list-disc space-y-1 pl-5 text-[11px] text-foreground">
                {snapshot.source.acceptanceCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            )}
            {snapshot.source.labels.length === 0 ? null : (
              <p className="text-[11px] text-muted-foreground">
                Labels: {snapshot.source.labels.join(", ")}
              </p>
            )}
          </div>
        </details>

        <details className="mt-2 rounded-xl border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-foreground">
            Guidance and workflow
          </summary>
          <div className="space-y-3 border-t px-3 py-3">
            <div>
              <h3 className="text-[11px] font-medium text-muted-foreground">Workflow</h3>
              <p className="mt-1 text-[11px] text-foreground">
                {snapshot.workflow.id} · {snapshot.workflow.path}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Revision {new Date(snapshot.workflow.revision).toLocaleString()} · digest{" "}
                <span className="font-mono">{snapshot.workflow.digest}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground">
                {snapshot.workflow.instructions}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Validation required:{" "}
                {snapshot.workflow.validationRequired.length === 0
                  ? "None recorded"
                  : snapshot.workflow.validationRequired.join(", ")}
              </p>
            </div>
            <div>
              <h3 className="text-[11px] font-medium text-muted-foreground">Batch guidance</h3>
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground">
                {instructionText(snapshot.guidance.batch)}
              </p>
            </div>
            <div>
              <h3 className="text-[11px] font-medium text-muted-foreground">Story instructions</h3>
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground">
                {instructionText(snapshot.guidance.story)}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Guidance digest <span className="font-mono">{snapshot.guidance.digest}</span>
              </p>
            </div>
          </div>
        </details>

        <details className="mt-2 rounded-xl border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-foreground">
            Target
          </summary>
          <div className="space-y-1 border-t px-3 py-3 text-[11px]">
            <p className="text-foreground">
              Repository: <span className="font-mono">{snapshot.target.repositoryPath}</span>
            </p>
            <p className="text-muted-foreground">
              Workflow: <span className="font-mono">{snapshot.target.workflowPath}</span>
            </p>
            <p className="text-muted-foreground">
              Workspace:{" "}
              <span className="font-mono">{snapshot.target.workspacePath ?? "Not reported"}</span>
            </p>
            <p className="text-muted-foreground">
              Base branch: {snapshot.target.baseBranch ?? "Not reported"}
            </p>
            <p className="text-muted-foreground">
              Provider: {snapshot.target.provider.instanceId} ({snapshot.target.provider.driver})
            </p>
            <p className="text-muted-foreground">
              Model: {snapshot.target.model ?? "Not reported"}
            </p>
          </div>
        </details>

        <details className="mt-2 rounded-xl border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-foreground">
            Enforced permissions
          </summary>
          <dl className="grid gap-x-4 gap-y-1.5 border-t px-3 py-3 text-[11px] sm:grid-cols-[12rem_1fr]">
            {permissionValue(snapshot.permission).map((entry) => (
              <div key={entry.label} className="contents">
                <dt className="text-muted-foreground">{entry.label}</dt>
                <dd className="text-foreground">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </section>

      <section className="rounded-2xl border bg-card px-4 py-4">
        <h2 className="text-[12px] font-semibold text-foreground">Current tracker brief</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">
          This is the live tracker record. Tracker edits do not rewrite the accepted snapshot above.
        </p>
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
          {workItem.objective}
        </p>
        {workItem.description === undefined || workItem.description.trim().length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No current description reported.</p>
        ) : (
          <p className="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground">
            {workItem.description}
          </p>
        )}
        {workItem.acceptanceCriteria.length === 0 ? null : (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-foreground">
            {workItem.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlanPanel({
  card,
  details,
  knownRunAttemptId,
  attemptState,
  attemptReason,
}: {
  readonly card: SymphonyBoardCard;
  readonly details: RunDetails | null;
  readonly knownRunAttemptId: RunAttemptId | null;
  readonly attemptState: "known" | "none" | "unknown";
  readonly attemptReason: string | null;
}) {
  if (details === null) {
    return (
      <div className="space-y-3">
        <section className="rounded-2xl border bg-card px-4 py-4">
          <h2 className="text-[12px] font-semibold text-foreground">Current tracker title</h2>
          <p className="mt-2 text-[12px] text-foreground">{card.title}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {noAttemptCopy({ knownRunAttemptId, attemptState, attemptReason })} No accepted guidance
            can be shown from this record.
          </p>
        </section>
        <ExactRunLink runAttemptId={knownRunAttemptId} />
      </div>
    );
  }
  if (details.runAttempt.acceptedGuidance === undefined) {
    return (
      <div className="space-y-4">
        <section className="rounded-2xl border bg-card px-4 py-4">
          <h2 className="text-[12px] font-semibold text-foreground">Accepted brief not recorded</h2>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            No accepted brief is recorded for this attempt. It may predate accepted-guidance
            persistence or the server may not publish it yet. The current tracker brief below is not
            proof of what this attempt accepted.
          </p>
          <CurrentBrief workItem={details.workItem} />
        </section>
      </div>
    );
  }
  return (
    <AcceptedGuidancePanel
      snapshot={details.runAttempt.acceptedGuidance}
      workItem={details.workItem}
    />
  );
}

function CurrentBrief({ workItem }: { readonly workItem: RunDetails["workItem"] }) {
  return (
    <div className="mt-3 rounded-xl border bg-muted/20 px-3 py-3">
      <p className="text-[11px] font-medium text-muted-foreground">Current tracker brief</p>
      <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground">{workItem.objective}</p>
      {workItem.description === undefined || workItem.description.trim().length === 0 ? null : (
        <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
          {workItem.description}
        </p>
      )}
      {workItem.acceptanceCriteria.length === 0 ? null : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-foreground">
          {workItem.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailTabPanel({
  tab,
  card,
  details,
  attentionEntries,
  actions,
  attempts,
  currentAttemptNote,
  knownRunAttemptId,
  attemptState,
  attemptReason,
  environmentId,
  onRefresh,
}: {
  readonly tab: DetailTab;
  readonly card: SymphonyBoardCard;
  readonly details: RunDetails | null;
  readonly attentionEntries: ReadonlyArray<SymphonyWorkAttentionEntry>;
  readonly actions: ReadonlyArray<SymphonyWorkAction>;
  readonly attempts: ReadonlyArray<SymphonyWorkAttempt>;
  readonly currentAttemptNote: string | null;
  readonly knownRunAttemptId: RunAttemptId | null;
  readonly attemptState: "known" | "none" | "unknown";
  readonly attemptReason: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly onRefresh: () => void;
}) {
  if (tab === "activity") {
    if (details === null && attentionEntries.length === 0) {
      return (
        <div className="space-y-3">
          <Muted>{noAttemptCopy({ knownRunAttemptId, attemptState, attemptReason })}</Muted>
          <ExactRunLink runAttemptId={knownRunAttemptId} />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <RequestList
          details={details}
          entries={attentionEntries}
          actions={actions}
          environmentId={environmentId}
          onRefresh={onRefresh}
        />
        {details === null ? null : (
          <ApprovalRequestHistoryList requests={details.approvalRequests} />
        )}
        {details === null ? null : <Timeline details={details} />}
      </div>
    );
  }

  if (tab === "plan") {
    return (
      <PlanPanel
        card={card}
        details={details}
        knownRunAttemptId={knownRunAttemptId}
        attemptState={attemptState}
        attemptReason={attemptReason}
      />
    );
  }

  if (tab === "execution") {
    if (details === null) {
      return (
        <div className="space-y-3">
          <Muted>{noAttemptCopy({ knownRunAttemptId, attemptState, attemptReason })}</Muted>
          <ExactRunLink runAttemptId={knownRunAttemptId} />
        </div>
      );
    }
    const attempt = details.runAttempt;
    const fields: ReadonlyArray<{ label: string; value: string }> = [
      { label: "Status", value: lifecycleLabel(attempt.status) },
      { label: "Attempt", value: String(attempt.attemptNumber) },
      { label: "Provider", value: `${attempt.provider.instanceId} (${attempt.provider.driver})` },
      { label: "Model", value: attempt.model ?? "Not reported" },
      { label: "Workspace", value: attempt.workspacePath },
      { label: "Started", value: new Date(attempt.startedAt).toLocaleString() },
      {
        label: "Finished",
        value:
          attempt.finishedAt === null
            ? "Not reported"
            : new Date(attempt.finishedAt).toLocaleString(),
      },
      { label: "Thread", value: attempt.threadId ?? "Not reported" },
    ];
    return (
      <div className="space-y-4">
        <section className="rounded-2xl border bg-card px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant={runAttemptStatusBadgeVariant(attempt.status)} size="sm">
              {lifecycleLabel(attempt.status)}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              Attempt {attempt.attemptNumber}
            </span>
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[9rem_1fr]">
            {fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 break-words font-mono text-[11px] text-foreground">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          {attempt.error !== null ? (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive-foreground">
              {attempt.error.message}
            </p>
          ) : null}
        </section>
        <section className="rounded-2xl border bg-card px-4 py-4">
          <h2 className="text-[12px] font-semibold text-foreground">Attempt history</h2>
          {currentAttemptNote === null ? null : (
            <p className="mt-1 text-[11px] text-muted-foreground">{currentAttemptNote}</p>
          )}
          {attempts.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No attempt history is loaded for this item.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border/60">
              {attempts.map((entry) => (
                <li
                  key={entry.runAttemptId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-xs font-medium text-foreground">
                    Attempt {entry.attemptNumber}
                  </span>
                  {entry.isCurrent ? (
                    <Badge variant="outline" size="sm">
                      Current
                    </Badge>
                  ) : null}
                  <Badge variant={entry.status === null ? "warning" : "secondary"} size="sm">
                    {entry.status === null ? "status unknown" : lifecycleLabel(entry.status)}
                  </Badge>
                  <AttemptOutcomeBadge outcome={entry.outcome} />
                  {entry.hasOutstandingAttention ? (
                    <Badge variant="warning" size="sm">
                      Needs attention
                    </Badge>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground">
                    {entry.provider === null ? "Provider not reported" : entry.provider.instanceId}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(entry.startedAt).toLocaleString()}
                  </span>
                  <Link
                    to="/symphony/$runId"
                    params={{ runId: entry.runAttemptId }}
                    className="ml-auto text-[11px] text-muted-foreground underline"
                  >
                    Open attempt
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <ExactRunLink runAttemptId={knownRunAttemptId} />
      </div>
    );
  }

  if (details === null) {
    return (
      <div className="space-y-3">
        <Muted>{noAttemptCopy({ knownRunAttemptId, attemptState, attemptReason })}</Muted>
        <ExactRunLink runAttemptId={knownRunAttemptId} />
      </div>
    );
  }
  const evidence = details.workItem.evidence;
  return (
    <div className="space-y-4">
      {evidence === null || evidence === undefined ? (
        <Muted>No evidence bundle is recorded for this run yet.</Muted>
      ) : (
        <EvidencePanel evidence={evidence} />
      )}
      {environmentId !== null &&
      evidence !== null &&
      evidence !== undefined &&
      evidence.pullRequest !== null ? (
        <PullRequestPanel
          environmentId={environmentId}
          workItemId={details.workItem.id}
          lifecycle={details.workItem.lifecycle}
          pullRequest={evidence.pullRequest}
          modelReview={evidence.modelReview}
          onRefresh={onRefresh}
          isRefreshing={false}
        />
      ) : null}
    </div>
  );
}

export interface SymphonyWorkRunAction {
  readonly label: string;
  readonly state: "available" | "blocked" | "unknown";
  readonly reason: string;
  readonly pending: boolean;
  readonly onRun: () => void;
}

/**
 * On-demand Work detail. Closed by default; the parent mounts it only for the
 * selected row and unmounts it on close, so no list width is reserved.
 */
export function SymphonyWorkDetail({
  open,
  project,
  card,
  details,
  attentionEntries,
  actions,
  attempts,
  currentAttemptNote,
  knownRunAttemptId,
  attemptState,
  attemptReason,
  lifecycleLabel: effectiveLifecycleLabel,
  lifecycleTone,
  needsAttention,
  attentionLabel,
  loading,
  error,
  environmentId,
  repositoryPath,
  machineLabel,
  runAction,
  cancelActions,
  actionNote,
  onReconcile,
  onClose,
  onRefresh,
}: {
  readonly open: boolean;
  readonly project: SymphonyProject;
  readonly card: SymphonyBoardCard;
  readonly details: RunDetails | null;
  readonly attentionEntries: ReadonlyArray<SymphonyWorkAttentionEntry>;
  readonly actions: ReadonlyArray<SymphonyWorkAction>;
  readonly attempts: ReadonlyArray<SymphonyWorkAttempt>;
  readonly currentAttemptNote: string | null;
  readonly knownRunAttemptId: RunAttemptId | null;
  readonly attemptState: "known" | "none" | "unknown";
  readonly attemptReason: string | null;
  readonly lifecycleLabel: string;
  readonly lifecycleTone: WorkRowTone;
  readonly needsAttention: boolean;
  readonly attentionLabel: string | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly repositoryPath: string;
  readonly machineLabel: string | null;
  readonly runAction: SymphonyWorkRunAction | null;
  readonly cancelActions: ReadonlyArray<SymphonyWorkRunAction>;
  readonly actionNote: string | null;
  readonly onReconcile: () => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("activity");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        className="w-[min(48rem,calc(100vw-1.5rem))] max-w-none sm:max-w-none"
      >
        <SheetHeader className="gap-3 border-b pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetDescription className="flex flex-wrap items-center gap-2 text-[11px]">
                <span>{project.title}</span>
                {card.trackerIdentifier === undefined ? null : (
                  <span className="font-mono">{card.trackerIdentifier}</span>
                )}
              </SheetDescription>
              <SheetTitle className="mt-1 text-[17px] leading-snug">{card.title}</SheetTitle>
            </div>
            <Button size="icon" variant="ghost" aria-label="Close detail" onClick={onClose}>
              <XIcon className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={lifecycleTone} size="sm">
              {effectiveLifecycleLabel}
            </Badge>
            {needsAttention ? (
              <Badge variant="warning" size="sm">
                {attentionLabel ?? "Needs your attention"}
              </Badge>
            ) : null}
            <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{repositoryPath}</span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              {machineLabel === null ? "Machine not reported" : machineLabel}
            </span>
            {knownRunAttemptId === null ? null : (
              <Link
                to="/symphony/$runId"
                params={{ runId: knownRunAttemptId }}
                className="text-[11px] text-muted-foreground underline"
              >
                Open exact run
              </Link>
            )}
          </div>
          {runAction === null && cancelActions.length === 0 ? null : (
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                {runAction === null ? null : (
                  <Button
                    size="sm"
                    variant={runAction.state === "available" ? "default" : "outline"}
                    disabled={runAction.state !== "available" || runAction.pending}
                    onClick={runAction.onRun}
                  >
                    {runAction.pending ? <Spinner className="size-3.5" /> : null}
                    {runAction.label}
                  </Button>
                )}
                {cancelActions.map((action) => (
                  <Button
                    key={action.label}
                    size="sm"
                    variant="outline"
                    disabled={action.state !== "available" || action.pending}
                    onClick={action.onRun}
                  >
                    {action.pending ? <Spinner className="size-3.5" /> : null}
                    {action.label}
                  </Button>
                ))}
              </div>
              {runAction === null ? null : (
                <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
                  {runAction.reason}
                </p>
              )}
              {cancelActions.map((action) => (
                <p
                  key={`${action.label}-reason`}
                  className="max-w-md text-[11px] leading-relaxed text-muted-foreground"
                >
                  {action.reason}
                </p>
              ))}
            </div>
          )}
          {actionNote === null ? null : (
            <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] text-foreground">
              <p>{actionNote}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={onReconcile}>
                <RefreshCwIcon className="size-3.5" />
                Refresh evidence
              </Button>
            </div>
          )}
        </SheetHeader>

        <div
          className="flex gap-1 overflow-x-auto border-b px-6"
          role="tablist"
          aria-label="Work detail"
        >
          {DETAIL_TABS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2.5 text-sm",
                tab === value
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab(value)}
            >
              {DETAIL_TAB_LABELS[value]}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6" role="tabpanel">
          {error === null ? null : (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
              <p>
                {details === null
                  ? `Could not load the exact attempt record. Requests on older attempts remain available in Activity. ${error}`
                  : `Live detail stopped updating. Showing the last received record. ${error}`}
              </p>
              <Button size="sm" variant="outline" onClick={onRefresh}>
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
            </div>
          )}
          {loading && details === null ? (
            <div className="space-y-3">
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-32 rounded-2xl" />
            </div>
          ) : (
            <DetailTabPanel
              tab={tab}
              card={card}
              details={details}
              attentionEntries={attentionEntries}
              actions={actions}
              attempts={attempts}
              currentAttemptNote={currentAttemptNote}
              knownRunAttemptId={knownRunAttemptId}
              attemptState={attemptState}
              attemptReason={attemptReason}
              environmentId={environmentId}
              onRefresh={onRefresh}
            />
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
