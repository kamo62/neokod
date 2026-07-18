import { useEffect, useState } from "react";
import {
  deriveThreadRunSummary,
  type ThreadRunSummary,
  type ThreadRunSummaryInput,
} from "./threadRunSummary.logic";

export function useThreadRunSummary(
  input: Omit<ThreadRunSummaryInput, "nowMs">,
): ThreadRunSummary | null {
  const [nowMs, setNowMs] = useState(Date.now);
  const summary = deriveThreadRunSummary({ ...input, nowMs });
  const startedAt =
    input.activeWorkStartedAt ??
    input.thread.latestTurn?.startedAt ??
    input.thread.latestTurn?.requestedAt;

  useEffect(() => {
    setNowMs(Date.now());
    if (!input.isWorking) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [input.isWorking, input.thread, startedAt]);

  return summary;
}
