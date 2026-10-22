import { truncate } from "@neokod/shared/String";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

const MAX_USER_FACING_ERROR_CHARS = 2000;

/**
 * A real stack frame ends in a source location. The `at` prefix alone is not
 * enough: ordinary prose such as "at most five retries" must survive.
 */
const STACK_FRAME_LINE =
  /^\s*at\s+(?:.*?\s+\()?(?:\S*[\\/]\S*:\d+:\d+|node:\S+:\d+:\d+|native|<anonymous>|index \d+)\)?\s*$/gm;

const FILE_URL = /\bfile:\/\/[^\s'"<>]+/gi;

/**
 * Non-file URLs are opaque tokens, not filesystem paths. They are protected
 * before path scrubbing so a query such as `?path=/Users/me/x` stays intact.
 *
 * A single quote is a valid URL character (for example `O'Reilly`), so it may
 * continue a token when URL content follows. A quote that closes a surrounding
 * quote is followed by whitespace, a list/delimiter separator or the end of the
 * token and is left outside the protected range.
 */
const NON_FILE_URL =
  /\b(?:https?|wss?|ftps?|ssh|git\+ssh|git|mailto|urn|data|blob):(?:[^\s<>"']|'(?=[^\s<>",);\]}]))+/gi;
const URL_PLACEHOLDER = /\uE000url:(\d+)\uE001/g;

const QUOTED_ABSOLUTE_PATH =
  /(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/\/|\/(?![/\s])|~[\\/]|\$HOME[\\/]|%USERPROFILE%[\\/])(?:(?!\1).)*)\1/g;
const WINDOWS_PATH =
  /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\\s'"<>|]+\\|~[\\/]|\$HOME[\\/]|%USERPROFILE%[\\/])[^\s'"<>|]*/g;
// A leading `/` at a token boundary. Excluded characters keep relative paths
// such as `src/(generated)/deep/file.ts` and their punctuation intact.
const FORWARD_SLASH_UNC = /(^|[\s'"([{=,;:])(\/\/[^/\s'"<>|]+\/[^\s'"`<>()[\]{}|]+)/g;
// The start boundary includes a backtick so GNU-style `path' quoting is
// redacted. A match still needs a `/` immediately after the boundary, so
// relative paths such as `src/file.ts` are untouched.
const POSIX_PATH = /(^|[\s'"`([{=,;:])(\/[^\s'"`<>()[\]{}|:]+)/g;

const lastSegment = (path: string) => path.split(/[\\/]/).findLast(Boolean);
const toPlaceholder = (path: string) => {
  const name = lastSegment(path);
  return name ? `[path]/${name}` : "[path]";
};

const replacePath = (path: string): string => {
  const trailing = path.match(/[.,;!?]+$/)?.[0] ?? "";
  const core = trailing.length > 0 ? path.slice(0, -trailing.length) : path;
  return `${toPlaceholder(core)}${trailing}`;
};

const protectUrls = (text: string): { readonly text: string; readonly urls: string[] } => {
  const urls: string[] = [];
  return {
    text: text.replace(NON_FILE_URL, (url) => {
      const placeholder = `\uE000url:${urls.length}\uE001`;
      urls.push(url);
      return placeholder;
    }),
    urls,
  };
};

export const REDACTED_ERROR_DETAIL =
  "Provider error details were withheld. See the Neokod server log for details.";

export const scrubErrorText = (text: string): string => {
  const protectedText = protectUrls(text);
  const scrubbed = protectedText.text
    .replace(STACK_FRAME_LINE, "")
    .replace(FILE_URL, "[path]")
    .replace(
      QUOTED_ABSOLUTE_PATH,
      (_match, quote: string, path: string) => `${quote}${toPlaceholder(path)}${quote}`,
    )
    .replace(WINDOWS_PATH, replacePath)
    .replace(
      FORWARD_SLASH_UNC,
      (_match, prefix: string, path: string) => `${prefix}${replacePath(path)}`,
    )
    .replace(POSIX_PATH, (_match, prefix: string, path: string) => `${prefix}${replacePath(path)}`)
    .replace(URL_PLACEHOLDER, (_match, index: string) => protectedText.urls[Number(index)] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return scrubbed.length > 0 ? scrubbed : text.trim().length > 0 ? REDACTED_ERROR_DETAIL : text;
};

export const GENERIC_INTERNAL_ERROR_DETAIL =
  "Unexpected internal error. See the Neokod server log for details.";

export const userFacingFailureDetail = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isNone(failure)) return GENERIC_INTERNAL_ERROR_DETAIL;
  const error = failure.value;
  const detail =
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
      ? error.detail
      : error instanceof Error && error.message.trim().length > 0
        ? error.message
        : String(error);
  return truncate(scrubErrorText(detail), MAX_USER_FACING_ERROR_CHARS);
};
