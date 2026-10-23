Request changes. Three P2 UI issues remain; no P0/P1 found.

1. Exact-run evidence does not update drawer actions. [SymphonyWorkView.tsx:651](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkView.tsx:651) derives cancellation solely from the capped collection. If a card’s attempt falls outside recent runs, the new exact query can successfully load an active attempt, but the drawer still offers no Stop action. Feed that exact fact through the existing projection, preserving incomplete coverage and freshness. This needs no broad server-completeness change.

2. History does not consume the published `delivering` state. [SymphonyWorkDetail.tsx:278](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkDetail.tsx:278) labels every non-answered question “Question closed” and hides its answer. With feedback `51eca0f22`, successful delivery followed by failed history finalisation leaves a `delivering` record. The helper exposes `deliveryPending`, but this renderer ignores it; its badge switch also lacks that state. Handle it explicitly and show the stored/redacted content with the pending-finalisation label. This is UI compatibility with the corrected dependency, not another shared-service finding.

3. Older requests route correctly but remain unattributed. [SymphonyWorkDetail.tsx:500](/Users/kamogelo/.codex/worktrees/neokod-work-ui/t3code/apps/web/src/components/symphony/SymphonyWorkDetail.tsx:500) loads the owning attempt but renders only its request controls. Multiple older requests, including outside-board requests, show generic agent wording without their attempt/provider identity. Operators cannot distinguish otherwise identical requests before acting. Display the loaded attempt number, provider instance and execution context beside each request.

The correction restores structured payloads and exact attempt routing, makes outside-board attention reachable, qualifies unknown empty states, and distinguishes absent accepted guidance from current tracker text.

Reviewed HEAD: `0967ea61aec12fcd8739ff35b1de82c2313d8328` against `0b5ccd78e`. Branch `feat/neokod-work-ui`; working tree and index clean. Projection source matches `4a0e84545`.

Source-only review with focused test inspection. No edits, tests, `vp check`, typecheck, builds, installs, browser use or subagents. Visual acceptance and real-provider continuation remain separate evidence.
