export function dispatchStateLabel(paused: boolean | null): string {
  if (paused === null) return "Dispatch state is unknown.";
  return paused
    ? "Dispatch is paused. No new work will be picked up."
    : "Dispatch is active. Eligible work is picked up automatically.";
}

export function stopAllMessage(ok: boolean): string {
  return ok ? "Stopped the running work." : "No runs were running.";
}
