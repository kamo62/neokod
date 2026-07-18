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

  useEffect(() => {
    if (!input.isWorking) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [input.isWorking]);

  return summary;
}
