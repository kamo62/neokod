Implemented and pushed on `work/core-composer-recovery`.

Commit: `a16c410505472ae061d0ba9e685c6d34d5fd88b8`
`fix(web): keep queued send identity across every retry [skip ci]`

## Design decision

A queued entry now has one logical send identity for its whole lifetime: the identity already recorded on the entry, or the deterministic identity derived from the immutable queue entry id.

I did not add a generation counter or a distinct deterministic successor for failed retries. Current `failed` outcomes are local `not_sent`/`not_attempted`, but a failed record may itself be the restored state after an accepted attempt whose claim was lost. A distinct successor could therefore duplicate an already accepted command. Reusing the recorded identity is the fail-closed choice, and the server receipt deduplicates it. The code documents that a future affirmative definitive rejection would need a replacement identity derived deterministically from the persisted failed record, never a random one.

## Behaviour

- `resolveQueuedDispatchAttempt` reuses the recorded identity for every prior state, including `failed`; only an entry with no recorded dispatch derives ids from the entry id.
- `claimQueuedMessageDispatch` retains the recorded identity for any existing dispatch record. A restored failed record cannot become an unrelated fresh id.
- First-attempt `messageCreatedAt` remains stable across retries.
- Accepted sends are removed. `unknown` becomes unconfirmed. Local `not_sent`/`not_attempted` stays unconfirmed when no failed record exists, and failed when a failed record already exists. Neither is auto-replayed.
- Queued failures never restore into the ordinary draft, so a newer draft is untouched and the entry keeps its identity and content. Ordinary direct sends still restore exactly as before.
- Acknowledgement now also covers an entry with no claim: its deterministic identity is compared with thread history. This releases accepted retries after a lost replacement claim.
- No server protocol, replay library or new queue infrastructure was introduced.

## Files

- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/composerDraftStore.test.ts`

## Verification

- Focused unit tests: 2 files, 150 tests passed.
- `apps/web`: `pnpm exec tsgo --noEmit` passed.
- Scoped `vp lint --report-unused-disable-directives` passed on all five files.
- Scoped `vp fmt --check` passed.
- `git diff --check` passed before commit.
- Working tree clean; local HEAD and `neokod/work/core-composer-recovery` both at `a16c41050`.

Covered by regressions: accepted manual retry reconstructed from a restored failed record, repeated reconstruction from the same failed record, lost first claim plus local `not_sent` without draft release, stable plan follow-up id and first attempt time, no automatic replay of unconfirmed/failed entries, and direct-send restore remaining unchanged.

## Limits

- No build, install, app launch, browser run or live provider call was performed.
- The storage readback still proves only that browser storage accepted the claim. It is not an fsync or operating-system disk-flush proof, so a force-kill before the browser writes its cache can still lose the claim.
- `ChatView` has no render harness. The no-restore wiring and acknowledgement effect are covered through focused pure helpers and source review, not an end-to-end runtime test.
- A lost first claim has no recorded first attempt time, so a replay from `dispatch: null` uses the replay time. Once a claim exists, the timestamp is stable.
- An accepted retry from an older build under a random identity that was never persisted cannot be reconstructed. The fix prevents new occurrences but cannot recover that historical ambiguity.
- A definitive server rejection remains classified as unknown, so retrying under the same identity may keep returning the same rejection until the user removes the entry. This is pre-existing and unchanged.
- No merge to `dev` or `main`, and no 2.2 work started.
