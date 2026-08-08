/**
 * Minimal glob matching for workflow test-path patterns.
 *
 * Supports `*` (within a path segment), `**` (across segments), and `?`
 * (single character). Deliberately small: the patterns are workflow-authored
 * path filters, not a general matcher. Everything else (character classes,
 * extglobs, alternation) is not supported.
 */

const escapeRegex = (value: string): string => value.replace(/[.+^$()|[\]\\]/g, "\\$&");

const segmentToRegex = (segment: string): string => {
  let out = "";
  for (const char of segment) {
    if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
};

export const globToRegExp = (pattern: string): RegExp => {
  const segments = pattern.split("/");
  let regex = "";
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === "**") {
      const isLast = i === segments.length - 1;
      regex += isLast ? ".*" : "(?:[^/]+/)*";
    } else {
      const prevWasGlobstar = i > 0 && segments[i - 1] === "**";
      if (i > 0 && !prevWasGlobstar) {
        regex += "/";
      }
      regex += segmentToRegex(segment ?? "");
    }
  }
  return new RegExp(`^${regex}$`);
};

export const matchesAnyPattern = (path: string, patterns: ReadonlyArray<string>): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(path));
