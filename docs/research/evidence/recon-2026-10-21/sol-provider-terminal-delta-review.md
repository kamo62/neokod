Three actionable findings. Reviewer: `gpt-6.1-sol`, effort `high`, confirmed from session metadata. All line numbers refer to target `97b37c6f71602efa23585d4eedc8bbac2d2800b5`.

1. P1: Process-table discovery does not prove terminal ownership. [Manager.ts:1330](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/terminal/Manager.ts:1330)  
   The new branch manufactures an identity with `pid: pgid`, without validating the original PTY process or group membership. If the shell exits and its PID is reused before asynchronous `ps` discovery, the selector accepts the replacement process’s TTY and signals its groups. A discovered group can also disappear and be reused before signalling or escalation. This can terminate unrelated work. Preserve terminal ownership evidence and revalidate identity before signalling; numeric equality and group liveness alone are insufficient.

2. P2: One Claude session can erase another session’s rejected window. [ClaudeDriver.ts:181](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/Drivers/ClaudeDriver.ts:181)  
   Each callback supplies one session’s `rejectedRateLimits`, but replaces the entire provider-instance limit. For example, session A reports `seven_day_opus` rejected; session B then reports `five_hour` allowed. B publishes its empty map, clearing A’s still-valid rejection. The provider card returns to its base status, and polling cannot restore the discarded evidence. Maintain rejection state per provider instance and update it by the reported window.

3. P2: A known reset incorrectly expires an unknown-reset rejection. [ClaudeUsageLimit.ts:286](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/Layers/ClaudeUsageLimit.ts:286)  
   With one rejected window whose reset is unknown and another whose reset is known, the projection assigns the known timestamp to the aggregate limit. After that timestamp, `applyClaudeLimit` removes the whole limit. The driver retains only this flattened projection, so subsequent polling keeps hiding the unresolved rejection until another event arrives. Preserve unknown-reset windows when deriving aggregate expiry, and recompute from retained window evidence during polling.

The previous overwrite finding is closed at source level: `clear()` marks the baseline seeded, preventing `adoptInitialHash()` from restoring the stale hash; successful persistence restores the confirmed hash. The added regression test covers that sequence.

Scope: exact delta `4c3183c9dd330a1df542ad61d1352ae789561e14..97b37c6f71602efa23585d4eedc8bbac2d2800b5`, covering `f81b4ca`, `e5b5eb4` and `c288fe0`. Read the requested documents, relevant plan cards, callers and tests. Provider-secret, Symphony buffered-edit, uncommitted and later changes were excluded.

Source review only. No builds, tests, installs, app launches, edits, commits, pushes, other agents or external messages. Runtime behaviour remains unverified.
