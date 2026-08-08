import type { SymphonyOverview } from "@neokod/contracts";

export type SymphonyOverviewMetricView =
  | { readonly state: "known"; readonly value: number; readonly label: string }
  | { readonly state: "unavailable"; readonly reason: string; readonly label: "Unavailable" };

export function resolveSymphonyOverviewMetric(
  metric: SymphonyOverview["running"],
): SymphonyOverviewMetricView {
  return metric.state === "known"
    ? { state: "known", value: metric.value, label: String(metric.value) }
    : { state: "unavailable", reason: metric.reason, label: "Unavailable" };
}

export type SymphonyOverviewViewState =
  | { readonly phase: "loading" }
  | {
      readonly phase: "unavailable";
      readonly reason: "no-environment" | "request-failed" | "missing-data";
      readonly message: string;
    }
  | {
      readonly phase: "ready";
      readonly overview: SymphonyOverview;
      readonly refreshError: string | null;
    };

export function resolveSymphonyOverviewViewState(input: {
  readonly hasEnvironment: boolean;
  readonly data: SymphonyOverview | null;
  readonly isPending: boolean;
  readonly error: string | null;
}): SymphonyOverviewViewState {
  if (input.data !== null) {
    return {
      phase: "ready",
      overview: input.data,
      refreshError: input.error,
    };
  }
  if (!input.hasEnvironment) {
    return {
      phase: "unavailable",
      reason: "no-environment",
      message: "No environment is available for Symphony overview data.",
    };
  }
  if (input.isPending) return { phase: "loading" };
  if (input.error !== null) {
    return {
      phase: "unavailable",
      reason: "request-failed",
      message: input.error,
    };
  }
  return {
    phase: "unavailable",
    reason: "missing-data",
    message: "No Symphony overview data is available yet.",
  };
}
