# S6 independent source review

What this change does: It preserves ordinary Codex questions whose options are absent, null or empty, retains label-only choices, and uses the existing composer custom-answer path. Request IDs and independent question IDs remain intact through the inspected normal-thread answer flow.

Reviewer: gpt-6.1-sol, high. Workflow: ponytail-review. This assessment was reasoned independently before receiving main/Opus review notes.

Base: `0b5ccd78e6448bba891cb393e0563fb869751894`.

Reviewed working-tree diff SHA-256 (`git diff --binary 0b5ccd78e`): `72bc39bbfbb13c82697742be0687968a1f45b246297c451ef6eb44d72d125809`.

## Must fix

1. [P1] A secret question is newly accepted as ordinary unmasked text (`apps/server/src/provider/Layers/CodexAdapter.ts:341-346`, `364`).

   What this is: The installed Codex protocol schema explicitly supports `isSecret?: boolean` in both question schemas (`packages/effect-codex-app-server/src/_generated/schema.gen.ts:13210-13243`). The new comment says this flag is handled as an ordinary custom-answer question, while the canonical question schema has no sensitivity field.

   Problem: Send a valid request containing `{id:"secret",header:"Credential",question:"Enter the credential",isSecret:true,options:null}`. This previously discarded no-options question now becomes a normal question with `options: []`, loses its sensitivity marker, and directs the user into the ordinary visible composer. The answer then follows the ordinary resolved-answer event path (`CodexSessionRuntime.ts:1401-1430`, `CodexAdapter.ts:1264-1278`, `ProviderRuntimeIngestion.ts:652-667`). Saying that masking is not claimed does not preserve the request's sensitive semantics.

   Fix: Keep this slice limited to supported non-secret free-text questions. Handle an unsupported sensitive request explicitly and visibly without collecting the secret in the ordinary composer, silently dropping a blocking request, or submitting only the remaining questions of a mixed request. Alternatively, preserve sensitivity through the existing contract and input handling if the shared-contract owner chooses that implementation. Add one focused regression with a secret/no-options request and a mixed secret/non-secret request.

   If skipped: The newly supported request shape invites sensitive input into a UI and event path that cannot retain its sensitivity.

## Checked source behaviour

- The adapter preserves null, omitted and empty options for ordinary questions; its existing schema decoding still rejects invalid wire shapes. Label-only choices are retained using the label as their display description.
- The web parser accepts the same ordinary free-text shapes and explicitly rejects a non-array options container. This review does not establish that malformed/unsupported requests receive a useful user-visible error.
- `ChatView.tsx:1875-1911` keys answer drafts and question progress by request ID; `4805-4901` keys independent answers by question ID and submits the complete answer map with the owning request ID. `pendingUserInput.ts` supports custom text for empty options without duplicating it under other IDs.
- `ChatComposer.tsx:1583-1600` sends edits into the active pending question draft; the existing advance/submission flow remains in use. No new composer or independent answer engine was introduced.
- Added tests exercise two independent free-text questions, a mixed choice/free-text request, label-only options, and progression/completeness. They do not cover sensitivity/unsupported handling.

## Exact reviewed file SHA-256 hashes

```text
4d8dae8b68ab6d03f4acaf0bbea2ef1762710560cf7705b7cccc05dc316e4efc  apps/server/src/provider/Layers/CodexAdapter.ts
6397a60c70b94a64880ea9eba2669f0199f7c9a42e41701bff19385f059c1f40  apps/server/src/provider/Layers/CodexAdapter.test.ts
fdb9859ed147f4ccf591ab5ada8210dfc5cb9c7c5f8b3735e6216b7948cc0c95  apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx
85cc3e88b493afe45d586084753b620f5bb09cc72ca439df4a4d8deb2ef0f68c  apps/web/src/session-logic.ts
447e90635bde34c0e23861d01e4adf9d65fb9fa16b97e6735625c51872c0155c  apps/web/src/session-logic.test.ts
841bfb113957aff54e259e2b6fc6e8fb86f749412607a8f86118939340b8cd1d  apps/web/src/pendingUserInput.test.ts
```

Verdict: Fix 1 first. Ordinary non-secret S6 behaviour is consistent with the traced existing answer flow, subject to the implementer's checks and final-delta re-review.

Not checked: No tests, compiler builds, installs, browser automation or provider sessions run by this reviewer. This is source/diff evidence for a local single-user normal-thread path, not observed provider continuation. Final commit is not yet reviewed; request a recheck once the implementer provides its SHA.
