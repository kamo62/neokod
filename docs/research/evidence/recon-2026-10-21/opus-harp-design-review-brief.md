# Opus design review brief: Harp and Neokod

Owner explicitly asked Opus to inspect Harp's clean terminal UI, added 21 October 2026. Requested reviewer: actual Claude Opus 5.5 high. Existing Opus review is incomplete under its session usage limit; this brief is prepared, not a completed dispatch or approval. No model substitute.

Read canonical plan.md 16.6-16.8, docs/research/feature-verdicts-2026-10-04.md sections12-13, state-and-evidence, supplied three image references and prior Sonnet synthesis. Harp current source/release pin: bad92b3fee6224941c9de92eaa3968a53e61ae6b, v0.1.3. Evidence: harp-design-source-manifest.json. Inspect official images/hero-dark.png, sidebar-dark.png, limit-rings-dark.png and light variants, then actual vertical_tabs.rs/telemetry/test code and commit release notes. No builds, app installation or live provider action.

Assess: sidebar density and hierarchy; grouped stable session positions; group attention counts; sticky approval-needed priority over background activity; unread versus completion versus intentionally inactive; status/elapsed semantics with unknown evidence; provider usage window visibility without false precision; keyboard/reduced-motion/contrast; narrow layouts. Compare Neokod's existing components, ordinary-child graph and Symphony Attention/run views. Recommend smallest own-component adaptations and placement. Distinguish screenshot judgement, README claims, source behaviour and actual runtime evidence. Harp is terminal/tmux observation, not proof of durable managed-child identity or orchestration. Its inherited Warp cloud stack is outside our local-first scope.

Return a short accept/adapt/defer table with concrete component targets, state/evidence contract and visual acceptance criteria. Do not implement or expand mobile scope. No claim review completed until actual model metadata and report retained.

## Owner routing amendment, 21 October 2026

Always try onboard Claude first. Following the recorded direct session-limit rejection, the owner authorises Opus 5.5 through OpenCode Copilot. The no-substitute text above is historical and superseded for this explicitly named provider route. ACP session `ses_ea0986fc6ffeTqolhA70Z2Hn15` has actual first assistant metadata `github-copilot/claude-opus-5.5`, variant `high`; review pending.
