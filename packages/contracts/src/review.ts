import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewScope = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewScope = typeof ReviewScope.Type;

export const ReviewChangedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type ReviewChangedFile = typeof ReviewChangedFile.Type;

export const ReviewChangedFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scope: ReviewScope,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewChangedFilesInput = typeof ReviewChangedFilesInput.Type;

export const ReviewChangedFilesResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scope: ReviewScope,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  files: Schema.Array(ReviewChangedFile),
  generatedAt: Schema.DateTimeUtc,
});
export type ReviewChangedFilesResult = typeof ReviewChangedFilesResult.Type;

export const ReviewFileDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scope: ReviewScope,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewFileDiffInput = typeof ReviewFileDiffInput.Type;

export const ReviewFileDiffResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewFileDiffResult = typeof ReviewFileDiffResult.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

export const ReviewChangedFilesError = ReviewDiffPreviewError;
export type ReviewChangedFilesError = typeof ReviewChangedFilesError.Type;

export const ReviewFileDiffError = ReviewDiffPreviewError;
export type ReviewFileDiffError = typeof ReviewFileDiffError.Type;
