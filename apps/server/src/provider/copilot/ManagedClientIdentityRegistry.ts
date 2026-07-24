/**
 * Minimal in-process cache for the GitHub login the managed-client evidence
 * path attaches to `client_identity.github_login`.
 *
 * `CopilotProvider.checkCopilotProviderStatus` already probes
 * `client.getAuthStatus()` on a refresh interval and on every settings
 * change to build the provider snapshot; this registry lets it share that
 * already-known login with `ManagedClientEvidenceForwarder` and
 * `ManagedClientEvidenceTestConnection` without either of them reaching for
 * a live `CopilotClient` or making their own auth-status probe. Reading the
 * cached value is synchronous and side-effect free, so it never blocks or
 * delays posting evidence.
 *
 * v1 scope: last-probe-wins, process-local, no persistence. If Copilot is
 * never probed (disabled, or the snapshot hasn't refreshed yet) the value
 * stays `undefined` and `github_login` is simply omitted from evidence.
 */
let cachedGithubLogin: string | undefined;

export function setKnownGithubLogin(login: string | undefined): void {
  const trimmed = login?.trim();
  cachedGithubLogin = trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function getKnownGithubLogin(): string | undefined {
  return cachedGithubLogin;
}
