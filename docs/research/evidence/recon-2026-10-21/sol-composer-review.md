Found three actionable P2 gaps in `cc054117d..8eed3c91f`.

1. **P2: Remounting can dispatch the same queue entry twice.**  
   `apps/web/src/components/ChatView.tsx:4457–4484`  
   Trigger: a queued send is awaiting settings/start acknowledgement while the thread still reports `ready`; navigate Home and return before it settles. The entry remains in the shared store, but the new component’s dispatch/in-flight guards start clear, so it dispatches the same entry again. `clearComposerContent` preserves queued entries, and the command scheduler serialises calls rather than deduplicating them. Each invocation also creates fresh message/command IDs. Track the queue claim outside the component lifetime, or correlate retries through a stable dispatch identity.

2. **P2: Clearing a send blocker does not restart a retained queue.**  
   `apps/web/src/components/ChatView.tsx:4461–4469`, `4517`  
   Trigger: the drain evaluates with a ready thread, empty draft and queued item while the environment is unavailable, then reconnects without changing those values. The new guard correctly retains the item, but the effect does not depend on environment availability, `isConnecting` or `isSendBusy`. Clearing those blockers therefore does not retry dispatch. The queue can remain stranded until another listed dependency changes. Make dispatch readiness reactive in the drain effect.

3. **P2: The plan-rejection fence rejects the same target after a round trip.**  
   `apps/web/src/components/ChatView.tsx:4113`  
   Trigger: submit a plan follow-up in thread A, visit thread B, then return to A before the request rejects, leaving A’s composer empty. `routeThreadRef` is recreated when the route parameters change (`1024–1027`), so reference equality fails even though the current environment/thread matches the submission target. Restoration is skipped, losing the prompt and all snapshotted attachments/contexts. Compare stable scoped target identities rather than object references.

Source-only review of the three changed files and necessary callers/store mutations. No edits, builds, tests, app/browser/provider actions, agents, commits or external messages. Worker-reported checks were not independently rerun.
