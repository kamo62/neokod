const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_MINUTES = 60;

/**
 * Formats an elapsed duration using compact, whole-second units.
 *
 * Negative and non-finite inputs are clamped to zero. Durations under an
 * hour use minutes and seconds; longer durations use hours and minutes.
 */
export function formatRelativeDuration(durationMs: number): string {
  const clampedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const totalSeconds = Math.floor(clampedMs / SECOND_MS);

  if (totalSeconds < MINUTE_SECONDS) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / MINUTE_SECONDS);
  const seconds = totalSeconds % MINUTE_SECONDS;
  if (totalMinutes < HOUR_MINUTES) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / HOUR_MINUTES);
  const minutes = totalMinutes % HOUR_MINUTES;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
