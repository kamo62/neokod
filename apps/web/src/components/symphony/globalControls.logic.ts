export type GlobalAction = "pause" | "resume" | "stop";

export interface DispatchOverviewSnapshot {
  readonly orchestratorPaused: boolean | null;
  readonly generatedAt: string;
}

export interface DispatchLastConfirmed {
  readonly paused: boolean;
  readonly observedAt: string;
}

export type DispatchDisplayState =
  | {
      readonly state: "known";
      readonly paused: boolean;
      readonly label: string;
      readonly observedAt: string;
    }
  | {
      readonly state: "unknown";
      readonly label: string;
      readonly lastConfirmed: DispatchLastConfirmed | null;
      readonly error: string | null;
    };

export function dispatchStateLabel(paused: boolean | null): string {
  if (paused === null) return "Dispatch state is unknown.";
  return paused
    ? "Dispatch is paused. No new work will be picked up."
    : "Dispatch is active. Eligible work is picked up automatically.";
}

export function resolveDispatchDisplayState(input: {
  readonly overview: DispatchOverviewSnapshot | null;
  readonly overviewError: string | null;
  readonly isReconciling: boolean;
}): DispatchDisplayState {
  const paused = input.overview?.orchestratorPaused ?? null;
  const lastConfirmed: DispatchLastConfirmed | null =
    input.overview !== null && paused !== null
      ? { paused, observedAt: input.overview.generatedAt }
      : null;

  // An error or an outstanding refresh makes the previous snapshot stale. Keep
  // it only as last-confirmed evidence, never as the current dispatch state.
  if (input.overviewError !== null) {
    return {
      state: "unknown",
      label: dispatchStateLabel(null),
      lastConfirmed,
      error: input.overviewError,
    };
  }
  if (input.isReconciling) {
    return {
      state: "unknown",
      label: "Dispatch state is unknown until the refresh completes.",
      lastConfirmed,
      error: null,
    };
  }
  if (paused === null || input.overview === null) {
    return {
      state: "unknown",
      label: dispatchStateLabel(null),
      lastConfirmed,
      error: null,
    };
  }
  return {
    state: "known",
    paused,
    label: dispatchStateLabel(paused),
    observedAt: input.overview.generatedAt,
  };
}

export function stopAllMessage(ok: boolean): string {
  return ok ? "Stopped the running work." : "No runs were running.";
}

const GLOBAL_ACTION_LABEL: Readonly<Record<GlobalAction, string>> = {
  pause: "Pause all",
  resume: "Resume all",
  stop: "Stop all runs",
};

export function globalActionFailureMessage(
  action: GlobalAction,
  input: { readonly interrupted: boolean; readonly cause: unknown },
): string {
  const label = GLOBAL_ACTION_LABEL[action];
  if (input.interrupted) {
    return `${label} did not complete because the request was interrupted. Try again.`;
  }
  const detail =
    input.cause instanceof Error && input.cause.message.trim().length > 0
      ? input.cause.message.trim()
      : null;
  return detail === null ? `${label} failed. Try again.` : `${label} failed: ${detail}`;
}
