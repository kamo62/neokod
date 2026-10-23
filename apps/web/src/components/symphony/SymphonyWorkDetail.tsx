import { Link } from "@tanstack/react-router";
import { ActivityIcon, GitBranchIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type {
  EnvironmentId,
  EvidenceBundle,
  RunDetails,
  SymphonyBoardCard,
  SymphonyProject,
} from "@neokod/contracts";

import { cn } from "../../lib/utils";
import type { SymphonyWorkAttempt } from "../../symphonyWork.logic";
import type { WorkRowTone } from "./SymphonyWorkList";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { PullRequestPanel } from "./PullRequestPanel";
import { SymphonyApprovalActions } from "./SymphonyApprovalActions";
import { attentionMode } from "./attention.logic";
import { runAttemptStatusBadgeVariant } from "./runAttemptStatus.logic";

export const DETAIL_TABS = ["activity", "plan", "execution", "evidence"] as const;

export type DetailTab = (typeof DETAIL_TABS)[number];

const DETAIL_TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  activity: "Activity",
  plan: "Plan",
  execution: "Execution",
  evidence: "Evidence",
};

const lifecycleLabel = (value: string): string => value.replaceAll("_", " ");

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

function RequestList({
  details,
  attentionItems,
  environmentId,
  onRefresh,
}: {
  readonly details: RunDetails | null;
  readonly attentionItems: ReadonlyArray<RunDetails["attentionItems"][number]>;
  readonly environmentId: EnvironmentId | null;
  readonly onRefresh: () => void;
}) {
  const byId = new Map<string, RunDetails["attentionItems"][number]>();
  for (const item of attentionItems) byId.set(String(item.id), item);
  for (const item of details?.attentionItems ?? []) byId.set(String(item.id), item);
  const items = [...byId.values()];
  if (items.length === 0) return null;
  return (
    <div className="rounded-2xl border bg-card px-4 py-3">
      <h2 className="mb-2 text-[12px] font-semibold text-foreground">Waiting for you</h2>
      <ul className="divide-y divide-border/60">
        {items.map((item) => {
          const mode = attentionMode(item);
          return (
            <li key={item.id} className="space-y-2 py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 flex-1 text-xs text-foreground">{item.whatHappened}</span>
                <Badge variant="warning" size="sm">
                  {lifecycleLabel(item.kind)}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">{item.whyHuman}</p>
              {mode !== "info" && environmentId !== null ? (
                <SymphonyApprovalActions
                  environmentId={environmentId}
                  requestId={item.id}
                  mode={mode}
                  onDone={onRefresh}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DetailTabPanel({
  tab,
  card,
  details,
  attentionItems,
  attempts,
  currentAttemptNote,
  environmentId,
  onRefresh,
}: {
  readonly tab: DetailTab;
  readonly card: SymphonyBoardCard;
  readonly details: RunDetails | null;
  readonly attentionItems: ReadonlyArray<RunDetails["attentionItems"][number]>;
  readonly attempts: ReadonlyArray<SymphonyWorkAttempt>;
  readonly currentAttemptNote: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly onRefresh: () => void;
}) {
  if (tab === "activity") {
    if (details === null && attentionItems.length === 0) {
      return <Muted>No execution record is available for this item.</Muted>;
    }
    return (
      <div className="space-y-4">
        <RequestList
          details={details}
          attentionItems={attentionItems}
          environmentId={environmentId}
          onRefresh={onRefresh}
        />
        {details === null ? null : <Timeline details={details} />}
      </div>
    );
  }

  if (tab === "plan") {
    const workItem = details?.workItem ?? null;
    return (
      <div className="space-y-4">
        <section className="rounded-2xl border bg-card px-4 py-4">
          <h2 className="text-[12px] font-semibold text-foreground">Work brief</h2>
          <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
            {workItem?.objective ?? card.title}
          </p>
          {workItem?.description !== undefined && workItem.description.trim().length > 0 ? (
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {workItem.description}
            </p>
          ) : workItem === null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              The durable work brief has not loaded. Only the board title and state are available.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">No description reported.</p>
          )}
          {workItem !== null && workItem.acceptanceCriteria.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-[11px] font-medium text-muted-foreground">Acceptance criteria</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-foreground">
                {workItem.acceptanceCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <p className="text-[11px] text-muted-foreground">
          This build does not store a separate plan document for a Symphony work item. The accepted
          work brief above is the recorded input.
        </p>
      </div>
    );
  }

  if (tab === "execution") {
    if (details === null) return <Muted>No execution attempt is recorded for this item.</Muted>;
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
        <div>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link to="/symphony/$runId" params={{ runId: attempt.id }}>
                Open full run
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  if (details === null) return <Muted>No evidence bundle is recorded for this item.</Muted>;
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
  attentionItems,
  attempts,
  currentAttemptNote,
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
  dispatchNote,
  onReconcile,
  onClose,
  onRefresh,
}: {
  readonly open: boolean;
  readonly project: SymphonyProject;
  readonly card: SymphonyBoardCard;
  readonly details: RunDetails | null;
  readonly attentionItems: ReadonlyArray<RunDetails["attentionItems"][number]>;
  readonly attempts: ReadonlyArray<SymphonyWorkAttempt>;
  readonly currentAttemptNote: string | null;
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
  readonly dispatchNote: string | null;
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
          </div>
          {runAction === null ? null : (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant={runAction.state === "available" ? "default" : "outline"}
                disabled={runAction.state !== "available" || runAction.pending}
                onClick={runAction.onRun}
              >
                {runAction.pending ? <Spinner className="size-3.5" /> : null}
                {runAction.label}
              </Button>
              <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
                {runAction.reason}
              </p>
            </div>
          )}
          {dispatchNote === null ? null : (
            <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] text-foreground">
              <p>{dispatchNote}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={onReconcile}>
                <RefreshCwIcon className="size-3.5" />
                Reconcile status
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
          {error !== null && details !== null ? (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
              <p>Live detail stopped updating. Showing the last received record. {error}</p>
              <Button size="sm" variant="outline" onClick={onRefresh}>
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
            </div>
          ) : null}
          {loading && details === null ? (
            <div className="space-y-3">
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-32 rounded-2xl" />
            </div>
          ) : error !== null && details === null ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive-foreground">
                Could not load this item&apos;s run record. {error}
              </p>
              <Button size="sm" variant="outline" onClick={onRefresh}>
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
            </div>
          ) : (
            <DetailTabPanel
              tab={tab}
              card={card}
              details={details}
              attentionItems={attentionItems}
              attempts={attempts}
              currentAttemptNote={currentAttemptNote}
              environmentId={environmentId}
              onRefresh={onRefresh}
            />
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
