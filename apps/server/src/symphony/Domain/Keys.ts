import * as NodeCrypto from "node:crypto";

import { WorkspaceKey } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import { Schema } from "effect";

const ALLOWED_WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Derive a collision-resistant workspace directory name from an issue
 * identifier (SPEC 4.2).
 *
 * Sanitization: replace any character not in `[A-Za-z0-9._-]` with `_`. If the
 * replacement changes the identifier, append `-<hex>` where hex is the first
 * 16 bytes (64 bits) of SHA-256 over the original identifier, so two distinct
 * identifiers that sanitize to the same text cannot collide.
 */
export const deriveWorkspaceKey = (identifier: string): WorkspaceKey => {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  const key = sanitized === identifier ? sanitized : `${sanitized}-${hashSuffix(identifier)}`;
  if (!ALLOWED_WORKSPACE_KEY_PATTERN.test(key) || key.length === 0) {
    throw new Error(`Identifier produced an invalid workspace key: ${identifier}`);
  }
  return WorkspaceKey.make(key);
};

const hashSuffix = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * Deterministic working branch for a work item when the tracker does not
 * supply `branch_name`: `symphony/<workspace-key>`. Reuses the sanitized key
 * so the branch and workspace map one-to-one and stay reproducible across
 * restarts (PRD FR-032).
 */
export const deriveWorkingBranch = (key: WorkspaceKey): string => `symphony/${key}`;

/**
 * Effect-wrapped variant for use in services; fails with a tagged error on
 * an invalid identifier rather than throwing.
 */
export const deriveWorkspaceKeyEffect = (identifier: string) =>
  Effect.try({
    try: () => deriveWorkspaceKey(identifier),
    catch: (cause) =>
      new WorkspaceKeyDerivationError({
        identifier,
        message: cause instanceof Error ? cause.message : "Invalid identifier",
      }),
  });

export class WorkspaceKeyDerivationError extends Schema.TaggedErrorClass<WorkspaceKeyDerivationError>()(
  "WorkspaceKeyDerivationError",
  {
    identifier: Schema.String,
    message: Schema.String,
  },
) {}
