Actual reviewer: `gpt-6.1-sol`, effort `high`, confirmed from session metadata. Four actionable findings:

1. P1 · [CopilotDriver.ts:201](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/copilot/CopilotDriver.ts:201) · Provider refresh can bypass session settlement.  
   If the child dies and a manual or scheduled refresh restarts it before the watchdog probes, the adapter retains its old sessions. SDK 1.0.9’s `forceStop()` disconnects those SDK sessions; subsequent watchdog pings reach the replacement process and report alive. Active turns and requests remain open, while `hasSession()` prevents normal recovery. Notify and settle the adapter whenever recovery replaces the runtime. The driver regression exercises refresh without an active session, so it misses this interaction.

2. P1 · [ProviderInstanceCard.tsx:164](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/components/settings/ProviderInstanceCard.tsx:164) · A queued revert can still delete both secrets.  
   Save A→B with a replacement, then, before acknowledgement, clear the replacement, restore A and blur. Reconciliation still sees authoritative A and publishes redacted A. The [mutation queue](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/hooks/useSettings.ts:431) later sends that captured payload against B’s acknowledged revision. A no longer exists; server cleanup removes B, leaving neither credential. Prevent stale stored-secret references from crossing pending replacements, or revalidate them before dispatch. The new tests cover acknowledgement followed by editing, not editing while acknowledgement is pending.

3. P1 · [useCommitOnBlur.ts:59](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/hooks/useCommitOnBlur.ts:59) · An untouched focused buffer can still bypass conflict protection.  
   Focus a clean Symphony list field, receive another client’s update, then blur or click Save. Focus captured the old text, but ownership starts only on `onChange`; the clean project draft therefore adopts the newer configuration and revision. Blur interprets the old focused snapshot as an edit and commits it against that newer revision, allowing silent overwrite without any keystroke. Resynchronise untouched buffers or preserve their observed revision from capture. The regression starts with `editing: true`, missing this sequence.

4. P2 · [providerEnvironmentDraft.ts:94](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/components/settings/providerEnvironmentDraft.ts:94) · An empty added row silently blocks other environment saves.  
   Add a blank row, then edit another row. Reconciliation adds `valueRedacted: false` to the blank row; `publishableEnvironment()` rejects blank rows whenever that property is defined. Nothing publishes, and the blank row receives no needs-value warning. Preserve the pristine blank-row representation or adjust its validation. The existing blank-row test bypasses reconciliation.

Reviewed only `97b37c6f71602efa23585d4eedc8bbac2d2800b5..8d6271f88284e2c9e4a792efeabbe627f7acc675`: Copilot X4, U04 correction, and Symphony S01/S02 corrections, using exact-target source, README, AGENTS, architecture guidance, callers and test source.

The original acknowledged A→B sequence is corrected in source. I also traced first-keystroke ownership, save-response preservation, unmount release and restored project identity. The project-key regression is a source-contract assertion, with no runtime DOM evidence.

No builds, tests, installs, app launches, edits, commits, pushes, other agents or external messages. Claude, terminal follow-ups and OpenCode were excluded.
