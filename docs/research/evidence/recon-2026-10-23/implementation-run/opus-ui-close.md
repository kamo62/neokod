**Verdict: ACCEPT** — `daf6cfb55748f9d4f006a38421b258ed80054e86` on `feat/neokod-work-ui`, with no P0–P2 findings.

## How I reviewed it

- The worktree's reflog confirms HEAD is `daf6cfb55`, the only commit after `6debed050`. Git status was clean when the session started.
- I had no shell in this session, so I couldn't run `git diff 6debed050..HEAD`. I reviewed the files at HEAD instead, following the affected callers from the commit subject and the contracts. Any regression outside the paths below therefore isn't ruled out by this pass.
- I read README, AGENTS.md, `docs/architecture/state-and-evidence.md` and `plan.md` sections 16.15–16.17.
- Source only: no tests, typecheck, build or browser. Chrome validation remains the separate integration gate.

## What I verified

**1. Stop-all result** (`apps/web/src/components/symphony/globalControls.logic.ts:88`, caller `SymphonyGlobalControls.tsx:84`):

- **Mixed (confirmed + held):** reports both counts. Held runs are labelled "held with ownership retained", never stopped.
- **Held only, confirmed missing:** keeps "confirmed count not reported" explicit and never says nothing was running.
- **Legacy, `ok` only:** `ok:true` says closure is unknown and `ok:false` says there's no confirmed closure. `ok` is never treated as proof of stopping.
- **Explicit `0/0`:** "No runs needed stopping." This is the only "nothing to stop" message, and it needs both counts reported as zero.
- **One count missing:** never assumed to be zero.
- The server's current result mapping (`apps/server/src/ws.ts:464`) only produces the legacy shape, because the orchestrator returns a plain number. So today the UI honestly shows the unknown/legacy messages. As you said, the typed producer is a known dependency, not a UI finding.

**2. Exact-run Stop** (`SymphonyWorkDetail.tsx:237`):

- If the outcome names a different `runAttemptId`, that check runs before the confirmed or held branches. A different attempt never reads as confirmation.
- An absent outcome reads as "may still be running; this is not confirmation". A transport failure reads as "acknowledgement unknown".
- Both callers pass the exact attempt from the projection: the drawer (`SymphonyWorkView.tsx:866`) and the run page (`SymphonyRunDetailView.tsx:132`).
- Closures still only cover the exact attempt (`symphonyWork.logic.ts:517`).

**3. Delivery history** (`SymphonyWorkDetail.tsx:325`, `attention.logic.ts:99`):

- **Delivering or interrupted with a staged decision:** shows a "Staged answer/approval/rejection" badge plus "Delivery unknown: the staged decision may or may not have reached the agent." A question header reads "delivery pending" or "delivery unknown".
- **Redaction:** answers show `[redacted]` with a Redacted badge.
- **Unavailable history:** `historyUnavailable` shows a warning and stops the UI from claiming no content was stored.
- **Missing content on an answered row:** stated explicitly.
- **Notes:** labelled history only.
- **Receipt:** never claimed. Answers are marked "Provider receipt not confirmed".

**4. Drawer exact-run projection** (`SymphonyWorkView.tsx:580–738`):

- **Board:** staleness takes the first of `boardError`, the collection's board staleness, then connection staleness.
- **Runs and attention:** staleness takes the first of `detailQuery.error`, the item's staleness, the collection's staleness, then connection staleness.
- **Connection:** covers network offline or unknown, plus every environment phase other than connected.
- **Exact-run detail:** loading it separately downgrades complete coverage to "bounded".
- **Closures:** only accepted when the detail query has no error.
- Lifecycle freshness comes from the card, which carries the stale reasons. A stale or mismatched detail record is caught by the projection's identity checks rather than trusted.
- I found nothing that makes stale data look fresh.

**5. Earlier semantics:** In what I read, the accepted-guidance, refusal, header, current-lifecycle and closure behaviour is unchanged, and no `ok`-based "Stopped" wording remains in the web code.

## Known dependencies (not UI findings)

- **Typed stop-all producer:** the server still returns a plain number, so typed counts can't appear yet. This is fixed in the recovery/guidance branches scheduled for composition.
- **Staged decision on interrupted rows:** at this HEAD, the server overwrites `decision` with `'interrupted'` when it reconciles a stuck delivery (`ApprovalRepository.ts:368`). The UI's interrupted-staged branch therefore only works with your `05d62b3f8` decision-preservation fix. Until then, such rows show "Question closed" or "Approval interrupted" with their content kept and receipt unconfirmed. That is incomplete but not a false claim.

## Below P2 (optional)

- **Missing tests:** no unit test covers `stopAcknowledgementNote`, including the different-attempt check, or the staged-decision rendering in `ApprovalRequestHistoryList`. I verified both by reading the code. A small table-driven test would lock them in.
- **Run page connection staleness:** `SymphonyRunDetailView.tsx:86` doesn't include connection or network staleness. The drawer is the requirement here, so I'm noting this rather than raising it as a finding.
