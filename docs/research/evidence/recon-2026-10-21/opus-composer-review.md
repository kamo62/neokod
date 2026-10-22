I found four actionable P2 findings and no P0 or P1 findings.

## Findings

1. **P2: a plan follow-up that fails after a thread switch loses its draft for good.** `ChatView.tsx:4094` saves which thread the composer belongs to before sending. `ChatView.tsx:4113` restores the draft only if the stored and current thread references are the same object. The draft was already wiped from the store at line 4108, so any failed restore is permanent.
   - Trigger: send a plan follow-up on thread A and switch to thread B before it fails. The route renders `ChatView` without a per-thread key (`routes/_chat.$environmentId.$threadId.tsx:66`), so the same instance moves to B and its draft target changes. A's text and attachments are never written back to A. Going back to A before the failure does not help: the target is rebuilt with `useMemo` at line 1024, so object equality still fails.
   - Fix: compare a stable thread key. When the target has changed, write the saved draft straight into A's store entry, and only if that entry is empty. Do not touch the shared refs or the cursor.

2. **P2: the direct-send restore writes into whichever thread is on screen, and the queue now relies on it.** The direct-send restore at `ChatView.tsx:4410-4438` has no thread check. It tests whether the composer is empty using shared refs, then calls `restoreComposerDraftSnapshot` (lines 4025-4040), which sets those shared refs to A's content.
   - Trigger: a queued send or direct send from A is in flight, you switch to B with an empty composer, then the send fails. A's store gets its text back, which is correct. B's refs (`promptRef`, `composerImagesRef` and the others) now hold A's content, but B's store and visible composer are still empty. The composer only re-syncs refs when its values change (`ChatComposer.tsx:1343-1357`), so sending from B's empty-looking composer posts A's text and images to B.
   - The queue settle at line 4476 reads the same contaminated `promptRef` to decide whether to remove A's entry. The unchecked restore predates this branch, but this branch extracted it and added a check only to the plan path.

3. **P2: a queued entry can now be sent twice if the app reloads or crashes mid-send.** The entry now stays in the persisted store until the send settles (lines 4475-4486). The store flushes to disk on `beforeunload` (`composerDraftStore.ts:82-83`).
   - Trigger: reload, quit or crash while a queued message's `startThreadTurn` request is in flight and the server has accepted it. After reload the entry is still there. When the new turn finishes and the phase returns to `ready`, the queue drain effect (lines 4506-4517) sends it again with a new message id.
   - The old code could lose the message in this window, but never sent it twice. Narrow window, but the duplicate send happens with no user action.

4. **P2: the in-flight queued entry still shows working controls that do nothing.** During the send, the entry is still rendered with its Remove and Steer controls (`ChatComposer.tsx:2556-2562`).
   - Remove only deletes it from the store. If the send is accepted, the message goes out anyway. If the send fails and the composer is empty, the text is restored into the composer even though the user removed it.
   - Once the phase flips to `running`, Steer is enabled but does nothing, because `sendInFlightRef` blocks it at line 4465.
   - Suggested fix: mark the entry as dispatching (keep it out of the persisted state), or hide or disable its controls until the send settles.

## Checked with no actionable issue

- **Send outcome:** each dispatch reads its own `onSend` return value instead of a shared ref. Every early return is `not_attempted`, start failure is `failed`, and success is `accepted`. Every path that sets `failure` sets `turnStartSucceeded` consistently.
- **Duplicate text:** the old `insertTextAtEnd` call is gone. A failed send that restored the text removes the entry once. Newer text in the composer keeps the entry, so nothing is lost.
- **Dispatch blockers:** the new blockers in `dispatchQueuedMessage` match the guard at the top of `onSend`. Steer stays hidden while there are pending user-input questions, so the missing `activePendingProgress` check cannot be reached through the UI.
- **Drain races:** `sendInFlightRef` is set before the first `await` in both the direct and plan paths, and an accepted send keeps `isSendBusy` set until the server acknowledges it. I found no new double drain.
- **Plan follow-up restore contents:** prompt, images, all terminal contexts, element contexts, preview annotations and review comments are restored. Clearing the composer does not revoke image preview URLs, so reusing the images without cloning is safe. Nothing is restored after acceptance.
- **Pre-existing gap, not part of these commits:** an accepted plan follow-up sends `attachments: []` and only the text (line 4798). Any attachments or contexts in the composer are cleared without being sent. The U-07 card excludes this deliberately.

## Limitations

This is a source-only review. I did not run builds, tests or the app. Two points come from reading code rather than running it: that TanStack Router reuses the same `ChatView` instance when the thread changes, and how React's microtask ordering interacts with the drain effect.
