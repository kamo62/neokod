// Recovery for stale-chunk load failures, surfaced through the root route
// error boundary (routes/__root.tsx). Ported from local-studio's
// app/chunk-recovery.ts pattern.
//
// After a redeploy, an already-open tab still references the previous
// build's hashed chunk filenames. A route (or any lazy import) that tries to
// load one 404s and throws — a dynamic-import failure — instead of quietly
// picking up the new build. Reloading once fetches the current build; the
// sessionStorage guard makes that idempotent, so a reload that does not
// clear the error (a genuinely broken deploy) falls through to the error
// boundary's normal "Something went wrong" UI instead of looping into a
// refresh storm.

const RELOAD_GUARD_KEY = "neokod:chunk-reloaded";

export function isChunkLoadError(
  error: { readonly name?: string; readonly message?: string } | null | undefined,
): boolean {
  const signature = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return (
    /ChunkLoadError/i.test(signature) ||
    /Loading (?:CSS )?chunk \S+ failed/i.test(signature) ||
    /(?:Failed to fetch|error loading) dynamically imported module/i.test(signature) ||
    /Importing a module script failed/i.test(signature)
  );
}

/**
 * Reload once per tab session to pick up the current build. Returns true if
 * a reload was triggered, false if this session already tried (so the
 * caller can fall back to a manual retry instead of reloading forever).
 */
export function recoverByReload(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.sessionStorage.getItem(RELOAD_GUARD_KEY)) return false;
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
  } catch {
    // sessionStorage can be unavailable (private mode); still attempt a reload.
  }
  window.location.reload();
  return true;
}
