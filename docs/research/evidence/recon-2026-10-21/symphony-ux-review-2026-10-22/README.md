# Symphony adversarial review evidence, 22 October 2026

The [adjudicated report](../../../../design/symphony-exploration-2026-10-21/REVIEW-2026-10-22.md) is authoritative. `opus-review.md` is the independent first pass; `opus-addendum.md` records corrections after Sol challenged findings and supplied more captures. The report supersedes their initial incorrect claims and remedies.

Sol operated Chrome through Computer Use. Captures 01–20 cover the landing page, Work assignment/plan/preview, A Runs and tracking loss, B workflow/native child, C plan/decision/evidence, Work receipt tabs and narrow layouts. Opus inspected source and captures 01–17; Sol checked 18–20 independently. `walkthrough.txt` and `workflow.txt` contain accessibility snapshots, not a screen-reader usability test.

`model-receipt.json` records the actual first-party Opus 5.5 session and successful independent/follow-up turns. No OpenCode fallback was needed for this review. `source-manifest.json` pins the reviewed prototype contents.

`cross-tab-check.cjs` executes the actual prototype functions in two isolated VM contexts sharing an in-memory storage stub, replacing only rendering with a no-op. It reproduced duplicate acceptance/receipt IDs and overwriting a different issue's receipt. It does not touch browser storage, trackers, providers or servers. The saved script points to the review checkout; adjust its `path` if replaying elsewhere. `cross-tab-result.txt` records the successful assertions. This is prototype function evidence, not a real browser concurrency test or a production backend finding.

No builds, real dispatch, tracker writes, provider launches, deployment or production fault injection were performed. Demo decision D-3 was saved locally during the walkthrough; execution approval was not granted.
