import { formatElapsed, type SubagentCard, type SubagentUsage } from "../session-logic";

export type SubagentIconStatus = SubagentCard["status"];

export type SubagentTiming =
  | {
      readonly kind: "live";
      readonly startedAt: string;
      readonly elapsed: string | null;
    }
  | {
      readonly kind: "exact";
      readonly startedAt: string;
      readonly endedAt: string;
      readonly elapsed: string | null;
    }
  | {
      readonly kind: "last-observed";
      readonly startedAt: string;
      readonly observedAt: string;
      readonly elapsed: string | null;
    }
  | {
      readonly kind: "unknown";
      readonly startedAt: string;
      readonly elapsed: null;
    };

export type ResolvedSubagentLifecycle =
  | {
      readonly phase: "active";
      readonly label: "Active";
      readonly iconStatus: "inProgress";
      readonly timing: Extract<SubagentTiming, { readonly kind: "live" }>;
    }
  | {
      readonly phase: "terminal";
      readonly outcome: "completed" | "failed" | "stopped";
      readonly label: "Completed" | "Failed" | "Stopped";
      readonly iconStatus: "completed" | "failed" | "stopped";
      readonly timing: Extract<SubagentTiming, { readonly kind: "exact" | "unknown" }>;
    }
  | {
      readonly phase: "orphaned";
      readonly label: "Orphaned";
      readonly iconStatus: "orphaned";
      readonly timing: Extract<SubagentTiming, { readonly kind: "last-observed" }>;
      readonly mayStillBeRunning: true;
    };

export type ResolvedSubagentCard = Omit<SubagentCard, "status" | "startedAt" | "completedAt"> & {
  readonly lifecycle: ResolvedSubagentLifecycle;
};

export interface SubagentTab {
  readonly taskId: string;
  readonly label: string;
  readonly hint: string | null;
  readonly status: SubagentCard["status"];
}

export function cleanSubagentProgressLabel(label: string | null | undefined): string {
  return label?.replace(/^(?:Running|Ran)\s+/u, "").trim() || "Working…";
}

export function formatSubagentUsage(usage: SubagentUsage | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.totalTokens !== null) parts.push(`${usage.totalTokens.toLocaleString()} tok`);
  if (usage.totalNanoAiu !== null) parts.push(`${usage.totalNanoAiu.toLocaleString()} nAIU`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function subagentSecondaryLabel(card: Pick<SubagentCard, "kind" | "model">): string | null {
  return card.model ?? card.kind;
}

export function deriveSubagentTabs(cards: readonly SubagentCard[]): SubagentTab[] {
  const nameCounts = new Map<string, number>();
  for (const card of cards) {
    nameCounts.set(card.name, (nameCounts.get(card.name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return cards.map((card) => {
    const hint = subagentSecondaryLabel(card);
    let label = card.name;
    if ((nameCounts.get(card.name) ?? 0) > 1) {
      const n = (seen.get(card.name) ?? 0) + 1;
      seen.set(card.name, n);
      label = `${card.name} #${n}`;
    }
    return { taskId: card.taskId, label, hint, status: card.status };
  });
}

export function resolveSelectedSubagent<T extends { readonly taskId: string }>(
  cards: readonly T[],
  selectedTaskId: string | null,
): T | null {
  if (selectedTaskId === null) return null;
  return cards.find((card) => card.taskId === selectedTaskId) ?? null;
}

export function isFinishedWorker(card: SubagentCard): boolean {
  return card.status !== "inProgress";
}

export function isDismissableEmptyWorker(card: SubagentCard): boolean {
  return isFinishedWorker(card) && card.progress.length === 0 && card.summary === null;
}

export function visibleSubagentCards(
  cards: readonly SubagentCard[],
  dismissed: ReadonlySet<string>,
): SubagentCard[] {
  return cards.filter((card) => !dismissed.has(card.taskId) && !isDismissableEmptyWorker(card));
}

function elapsedTo(card: SubagentCard, endIso: string): string | null {
  return formatElapsed(card.startedAt, endIso);
}

export function resolveSubagentCard(input: {
  readonly card: SubagentCard;
  readonly nowMs: number;
  readonly turnSettled: boolean;
}): ResolvedSubagentCard {
  const { card } = input;
  const content = {
    taskId: card.taskId,
    name: card.name,
    model: card.model,
    kind: card.kind,
    agentId: card.agentId,
    summary: card.summary,
    currentActivity: card.currentActivity,
    usage: card.usage,
    progress: card.progress,
  };

  if (card.status === "inProgress" && !input.turnSettled) {
    const nowIso = new Date(input.nowMs).toISOString();
    return {
      ...content,
      lifecycle: {
        phase: "active",
        label: "Active",
        iconStatus: "inProgress",
        timing: {
          kind: "live",
          startedAt: card.startedAt,
          elapsed: elapsedTo(card, nowIso),
        },
      },
    };
  }

  if (card.status === "inProgress" || card.status === "orphaned") {
    const latestProgressAt = card.progress.at(-1)?.at;
    const observedAt = latestProgressAt ?? card.startedAt;
    return {
      ...content,
      lifecycle: {
        phase: "orphaned",
        label: "Orphaned",
        iconStatus: "orphaned",
        mayStillBeRunning: true,
        timing: {
          kind: "last-observed",
          startedAt: card.startedAt,
          observedAt,
          elapsed: latestProgressAt ? elapsedTo(card, observedAt) : null,
        },
      },
    };
  }

  const label =
    card.status === "completed" ? "Completed" : card.status === "failed" ? "Failed" : "Stopped";
  const timing: Extract<SubagentTiming, { readonly kind: "exact" | "unknown" }> = card.completedAt
    ? {
        kind: "exact",
        startedAt: card.startedAt,
        endedAt: card.completedAt,
        elapsed: elapsedTo(card, card.completedAt),
      }
    : { kind: "unknown", startedAt: card.startedAt, elapsed: null };
  return {
    ...content,
    lifecycle: {
      phase: "terminal",
      outcome: card.status,
      label,
      iconStatus: card.status,
      timing,
    },
  };
}

export function resolveSubagentCards(
  cards: readonly SubagentCard[],
  options: { readonly nowMs: number; readonly turnSettled: boolean },
): ResolvedSubagentCard[] {
  return cards.map((card) => resolveSubagentCard({ card, ...options }));
}
