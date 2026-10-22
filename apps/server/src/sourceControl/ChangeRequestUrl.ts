/**
 * Repository identity for a change-request URL.
 *
 * A change-request number is only unique inside its repository, so merge
 * evidence must be bound to both. The key is `scheme//host[:port]/repository/path`:
 *
 * - the full hostname and effective authority are kept, including the scheme
 *   and its default port, because `http://host`, `https://host`, `host:8443`
 *   and `www.host` can each serve independent installations;
 * - `www.github.com` is the one established alias, so it maps to `github.com`;
 *   the alias is not generalised to self-hosted hosts;
 * - the change-request suffix is recognised at the end of the path (for
 *   example `/pull/42`, `/-/merge_requests/42`, `/pull-requests/42`,
 *   `/pullrequest/42`), so an owner legitimately named `pull` is not mistaken
 *   for the suffix;
 * - the repository path keeps its casing, because paths are case-sensitive on
 *   several providers.
 *
 * `null` means the URL cannot identify a repository. Callers must treat that as
 * unresolved provenance and must not substitute or overwrite tracked evidence.
 */
const CHANGE_REQUEST_MARKERS: ReadonlySet<string> = new Set([
  "pull",
  "pulls",
  "pull-requests",
  "pullrequest",
  "merge_requests",
]);

/** A change-request reference: a number, optionally prefixed with `#`. */
const isChangeRequestReference = (segment: string): boolean => /^#?\d+$/u.test(segment);

export const changeRequestRepositoryKey = (url: string | undefined): string | null => {
  if (url === undefined) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Hostnames are case-insensitive; everything else in the authority is not.
  const hostname = parsed.hostname.toLowerCase();
  // The one established alias. `www.` on any other host is a distinct authority.
  const effectiveHostname = hostname === "www.github.com" ? "github.com" : hostname;
  const defaultPort =
    parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
  const port = parsed.port === "" ? defaultPort : parsed.port;
  // The scheme is part of the effective authority: http://host and https://host
  // can be separate installations on ports 80 and 443.
  const authority = `${parsed.protocol.toLowerCase()}//${effectiveHostname}${
    port === "" ? "" : `:${port}`
  }`;

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  let suffixIndex = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (
      segment !== undefined &&
      next !== undefined &&
      CHANGE_REQUEST_MARKERS.has(segment.toLowerCase()) &&
      isChangeRequestReference(next)
    ) {
      suffixIndex = index;
    }
  }
  if (suffixIndex <= 0) {
    return null;
  }

  const repositorySegments = segments.slice(0, suffixIndex);
  // GitLab separates the project path from the request kind with `/-/`.
  while (repositorySegments.at(-1) === "-") {
    repositorySegments.pop();
  }
  if (repositorySegments.length === 0) {
    return null;
  }
  const last = repositorySegments.length - 1;
  const repositoryTail = repositorySegments[last]?.replace(/\.git$/u, "") ?? "";
  if (repositoryTail.length === 0) {
    return null;
  }
  repositorySegments[last] = repositoryTail;

  return `${authority}/${repositorySegments.join("/")}`;
};
