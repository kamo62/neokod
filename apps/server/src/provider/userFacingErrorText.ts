import { truncate } from "@neokod/shared/String";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

const MAX_USER_FACING_ERROR_CHARS = 2000;
const STACK_FRAME_LINE = /^\s*at\s.+$/gm;
const FILE_URL = /file:\/\/[^\s)'"]+/g;
// POSIX path with at least one directory, not part of a URL or word (lookbehind).
const POSIX_PATH = /(?<![\w:/.~-])\/(?:[^\s/'"()<>:]+\/)+[^\s/'"()<>:,;]*/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s'"<>|]+\\)*[^\\\s'"<>|]*/g;
const lastSegment = (path: string) => path.split(/[\\/]/).findLast(Boolean);
const toPlaceholder = (path: string) => {
  const name = lastSegment(path);
  return name ? `[path]/${name}` : "[path]";
};

export const scrubErrorText = (text: string): string =>
  text
    .replace(STACK_FRAME_LINE, "")
    .replace(FILE_URL, "[path]")
    .replace(POSIX_PATH, toPlaceholder)
    .replace(WINDOWS_PATH, toPlaceholder)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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
