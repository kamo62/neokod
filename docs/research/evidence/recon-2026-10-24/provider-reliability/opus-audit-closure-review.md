# opus-audit-closure

Actual route: github-copilot/claude-opus-5.5, effort high. Session ses_e92850e6dffeCQaw3kSpqOglM5.

## Verdict: ACCEPT

The corrected audit, the durable evidence bundle and the root presentation have no material defect left. Root can replace the pending-review sentence with a factual record of dual acceptance. What is left is minor wording, listed under its own heading below.

The manifest checked clean at the start (13:40:37) and the end (13:42:16): 25 of 25 files match their hashes, no files are unlisted, and the manifest hash is `ad365acf…c7d9` both times. The root report and `plan.md` were last written at 13:38 and 13:39, before I started. HEAD is `c8fef250e`. I edited nothing and ran no builds, installs or processes.

## The #23282 correction

**Why Sol was right and my earlier acceptance was wrong.** In my last pass I accepted all 44 hosted-only exclusions. For #23282 I treated a `scheduledTasks/webhook*` path as proof of hosted infrastructure. That was wrong.

- **What the captured evidence shows:** all 6 changed files are listed: `mcp/toolkits/orchestrator/tools.ts`, `scheduledTasks/webhookFilter.ts` and `webhookTemplate.ts` with their tests, and `contracts/scheduledTask.ts`.
- **What the PR body says:** it describes local filter logic (`[]` matching over arrays) and template rendering, and calls itself "server-only logic".
- **What is not there:** none of T3 Connect, relay, Clerk, a tunnel or a cloud path appears.

A GitHub webhook example on its own does not establish a hosted dependency. Reclassifying #23282 as mixed, with its backend intent unassessed, is correct. It is not promoted to a candidate.

**The other three webhook rows stay excluded, correctly.**

- #14600's body says it is "backed by a T3 Connect inbox".
- #15487 and #16232 change relay, `HeldHooksWaker` and `cloud/*` paths.

Their own scheduled-task paths are tangled with relay delivery. The shared `decisionBasis` text says every backend path sits inside the hosted slice, which slightly overstates #14600. That is a wording issue only.

**The changed counts all reconcile.**

- **Records:** the durable ledger (decompressed), CSV and receipts.
- **Rows:** 3,927 IDs, identical to the raw census, and the CSV and JSON dispositions agree.
- **F5 re-triage of complete file lists:** 304 rows = 245 mixed + 16 mobile-only + 43 hosted-only. The 245 mixed rows were previously 161 UI, 39 desktop, 29 mobile and 16 cloud. Exactly one row, #14290, comes from a truncated list, under the separate "connect" correction.
- **Unassessed backend backlog:** 593.
- **Cloud-connect exclusions:** down from 82 to 81.
- **Promoted to candidate:** none (0 of 305).
- **Receipt and validation file:** both record 44 hosted rows audited, 43 kept with explicit evidence, and [23282] reclassified.
- **Earlier corrections, unchanged:**
  - 3,106 / 177 / 644 nightly reachability.
  - 332 stacked PRs with positive ancestry.
  - 174 parent-PR inferences plus 3 unresolved.
  - 5 null metrics for unavailable file lists.
  - 61 truncated lists marked mixed/unknown.

## Durable bundle integrity

- **Raw census and ledger:** the compressed raw census decompresses to the original hash. The compressed ledger decompresses to the original Sonnet bytes, which match the `/tmp` source.
- **Formatted copies:** the receipt, validation, `curated.json` and truncation-corrections files are reformatted but have the same content as the originals.
- **Matrix JSON:** it differs from the original only where `/tmp` paths became `all-closed-prs.json.gz`.
- **Reconstruction file:** the ledger as it was before the truncation correction is compressed in the bundle and matches its source.
- **Original vs durable hashes:** these are explained separately in `rawSonnetSourceHashes` and checked out.
- **Links:** no broken Markdown links in the bundle or the root report. The remaining `/tmp` strings are inside historical scripts, receipts and a CSV note. They are provenance, not links.

## Root presentation and plan §16.19

The fixes I asked for last round are in:

- **Performance ports:** the terminal and Git ports are marked as integrated at `f64dd8ca1`.
- **Source pins:** `0ab699566`, `3b134e4` and `0c05baa3f` are stated against the current `c8fef250e`, with an instruction to refresh before implementing.
- **G05 (schedules):** a candidate, not verified as absent.
- **G12 (PR watch and settle):** limited to ordinary chats, with Symphony's PR polling and settlement acknowledged.
- **Performance figures:** they match the receipts. Terminal large-string reads went from 1,368,145 to 123,036, and unused Git scans from 256 to 0. These are single-run harness numbers.
- **Plan wording:** §16.19 records the same census and correction counts, the unresolved 38-versus-39 body-read discrepancy, and that Codex continuation failed on credits and Claude hit its usage limit. It does not claim either passed.

## Minor residual wording (not blocking)

1. The `decisionBasis` boilerplate for hosted-only rows overstates #14600, whose scheduled-task paths sit beside the hosted inbox.
2. The §16.19 summary still says "issue-origin/result links partial". The report and matrix say "planned W6 handoff, Track C; partial foundations". It also says "terminal backpressure unverified", while the report names the unbounded local callback queue as a concrete candidate. These are consistent in substance but worded differently.
3. The root report's sentence defining "missing" no longer has any row that uses it.
4. Eleven `web,mobile` rows with no backend files still carry a `mobile-excluded` reason. They are excluded either way.
5. The root report could mention the 245/59/593 counts and #23282 in its reconciliation section. The counts are already correct in the T3 report and §16.19.

## Is the bounded source delivery sufficiently evidenced?

Yes, for this bounded delivery, with formal core exit still open. The plan records:

- **Reviews:** dual Sol and Opus acceptance of the outcome lane at `c8fef250e` (including Sol's correction of the 1,000-event cap) and of the performance lane at `f64dd8ca1`.
- **Focused tests:**
  - 202 tests for outcome, contracts, SQL, event store and client, plus 135 Symphony tests, at the current HEAD.
  - 143 terminal and Git tests, plus 241 registry, adapter and SDK tests, reused at stated snapshots whose files did not change.
- **Typecheck:** typecheck passes for all 10 packages.

Those test sets cover disjoint files, so they don't add up to a single full-suite run.

The normal-thread Chrome and database evidence supports the Stop and continuation behaviour in these fixes. Copilot was approved, stopped, reloaded and continued with the exact expected reply. Turn `37f986cc…` stayed interrupted and its successor `f7a037a7…` completed. Provider refresh still shows Codex, Claude and Copilot, with OpenCode 2 unsupported.

Still required before merge: the final `vp check` (run separately), remote checks under the skip-CI constraint, and the PR154 merge receipt. PR150 stays held.

## Exact proof limits

- **Triage depth:** about 98% of PRs are rule-based triage. About 65 have body or description reads, 17 have patch reads, and 29 have Neokod comparisons, all pinned to older commits.
- **Incomplete file data:** 61 truncated file lists and 5 unavailable ones.
- **Upstream inclusion:** nightly reachability proves the source is included, not that the behaviour is enabled, released or working. Parent-PR links are inference.
- **Competitors:** evidence is public source and docs only; nothing was run.
- **Neokod:** source presence is not live acceptance.
- **Runtime evidence:** Chrome and Symphony checks are synthetic reads and UI views. They do not prove tracker-to-PR, a confirmed Symphony ownership Stop, crash or restart, or an installed app. No native Mac app has been installed or tested.

## Feature recommendations for the owner

These follow the plan's existing order and gates, and lift no hold.

1. Finish the §16.19 core and provider reliability work. The terminal and Git ports are already integrated.
2. Bounded candidate: a per-subscriber terminal output budget (G11, after T3 #18429). Trace transport flow control first.
3. Track C, issue to task to PR with the result in the originating chat (G04): implement the existing W6 handoff spec.
4. W5 saved owner machines and acknowledged continuation (G02).
5. W6-C managed chat children and isolated worktrees (G01/G06), only after formal core exit.
6. Usage history and graphs (U-1–U-7, G03): planned and still held by §13.2.
7. Candidates once tracks A to C are done, with no verified absence:
   - In-thread find (G09).
   - Ordinary-chat PR watch and settle (G12).
   - Durable user schedules (G05). #23282's local filter logic is a reference here, and hosted inboxes stay excluded.
8. Investigate only: project memory (G08) and skills/MCP/compaction capability display (G10).
