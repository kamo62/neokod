Accept at source level. No concrete P0–P2 finding in the reviewed S6 delta.

Reviewed commit: `bdf22d5338c628d8557c28edf494dcce3a545c9a`  
Base: `0b5ccd78e6448bba891cb393e0563fb869751894`

The initial secret-input finding is corrected: any `isSecret: true` question produces a warning for the whole request, including mixed requests, before ordinary question normalisation. No pending composer question or partial answer map is created. The warning reaches the production activity timeline. The provider request remains pending for operator intervention; this is warning handling, not automatic protocol rejection.

Non-secret omitted, null and empty options survive the adapter and web parser. Production callers preserve request/question association and distinct custom answers through composer drafts, command dispatch, provider routing, Codex response conversion and persisted resolved-answer history.

Read README, AGENTS, state-and-evidence, plan 16.15–16.17 S6 and the specified initial Sol receipt. No Opus review files opened.

Evidence limits: source inspection and `git diff --check` only, which passed. No edits, subagents, tests, typechecks, builds, installs, runtime or provider execution. Browser behaviour, reload behaviour and real Codex continuation remain unobserved; required verification and live acceptance gates remain outstanding.
