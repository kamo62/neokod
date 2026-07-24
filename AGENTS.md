# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

Neokod is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Upstream Sync Policy (local-first)

Neokod is a local-first fork of `pingdotgg/t3code`. When evaluating anything from
upstream (nightly releases, merged PRs, open PRs), the default is to exclude, not
include. Two hard filters apply to every upstream change before it is considered
for porting:

1. **Exclude all UI changes.** Do not port upstream UI work (sidebar chrome,
   composer surfaces, themes, dialog restyles, marketing pages, mobile screens,
   animation polish). Neokod owns its own UI. Any UI change we ship is a
   deliberate neokod decision made against our own components, never a
   cherry-pick from upstream.

2. **Exclude anything that does not match local-first.** Reject upstream features
   that depend on infrastructure Neokod has carved out: hosted or remote
   transports, T3 Connect, cloud sessions, remote server or standalone-service
   management, mobile apps, the marketing site, and public or loopback auth
   control planes.

What remains eligible: backend correctness fixes, provider (Codex/Claude/Copilot)
behavior, performance and reliability work, and self-contained protocol or SDK
changes that run fully local. Even eligible changes are ports, not merges: re-apply
the intent against Neokod's code, do not blindly take upstream diffs.

When in doubt, leave it out and raise it for discussion rather than porting
speculatively.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@neokod/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for web client code.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
