# Neokod

Neokod is a local-first, multi-provider, governed agent workbench for coding with the AI agent CLIs you already use. It runs agent chats, terminals, git worktrees, diffs, and provider sessions in one focused workspace on your own machine, with no application login and no cloud service holding your repositories or history.

Neokod began as a fork of T3 Code and has been carved down to a local-first tool: no cloud service, no mobile app, no remote-access control plane. Your projects, threads, and history stay on your machine, and Neokod talks directly to the providers you choose. The fork exists to add governance on top of that foundation: one place for an organization to route and control Claude and Copilot usage across its developers, in place of scattered personal CLI logins.

Neokod continues to track upstream T3 Code selectively: fixes and updates that apply to the local-first tree are backported as needed, with original authorship preserved. Upstream changes tied to the removed cloud, mobile, and relay layers are not ported.

## Two modes

Neokod keeps interactive work and autonomous work as two separate modes.

**Code mode** is the interactive mode: you drive an agent thread directly, with parallel threads, per-thread git worktrees, diffs, branches, commits, and PRs, an embedded terminal, and file and preview views in the same window. This is the shipped foundation of the app.

**Symphony mode** is autonomous and workflow-led. A daemon-driven scheduler pulls dispatchable issues from a tracker (GitHub Issues, GitHub Projects, Jira, Linear, GitLab, Asana, or Azure Boards), dispatches an agent into an isolated git worktree for each one, runs the validation configured for that repository, assembles an evidence bundle, and opens a pull request. A `WORKFLOW.md` file in the repository configures the tracker, dispatch rules, and approval policy. Autonomy is bounded by that policy throughout: work can require approval before merge, and merging stays off by default until a human or a configured gate approves it. Symphony is implemented and merged into the app, gated behind these policy controls. It has not yet been run end to end against a live tracker in production use, so treat it as present and policy-bounded. It is not a finished, battle-tested path yet.

Two further directions describe where the project is headed. Neither ships today. The goal is a provider-neutral capability graph, so that what an agent can do (its commands, tools, skills, and integrations) looks the same in the UI whichever provider is running it, and the UI does not branch per provider. Alongside that, the aim is centralized governance over which agents run, how, and under what controls, including governed delegation across multiple agents. Both are design direction today, not shipped features.

## What it does

- Drive coding agents from one desktop workspace: parallel threads, per-thread git worktrees, diffs, branches, commits, and PRs.
- Keep the agent chat, an embedded terminal, and file and preview views together in the same window.
- Find your way around with a project-tree sidebar and a cross-project "My Work" inbox, plus a Home dashboard for picking up where you left off.
- Watch a thread run in a run banner that shows plan-step progress, elapsed time, and status as the agent works.
- Track the workspace with an Environment panel: branch and base branch, change stats, and commit/push/PR actions.
- See what subagents are doing in a dedicated Subagents panel.
- Pick a provider model and its reasoning effort from one combined control.
- Get notified when an agent finishes or needs you, so you do not have to watch a thread. An in-app toast appears when you are elsewhere in the app, a native system notification when the window is hidden, and clicking either jumps straight to that thread. Notifications are opt-out and only request OS permission when you ask.
- Run Symphony mode alongside Code mode on a repository that has a `WORKFLOW.md`: dispatch tracker issues to agents, watch runs and evidence, and approve or hold merges under policy.
- Stay local. There is no Neokod cloud holding your repositories, chats, or history. The provider you pick still receives the prompts, diffs, and tool output a session needs. That traffic goes straight to the provider, with no Neokod service in the path.

## Providers

Neokod drives agent CLIs you have installed and authenticated yourself. Supported providers:

- Claude (Claude Code)
- Codex (Codex CLI)
- Copilot (GitHub Copilot CLI)
- Cursor (Cursor CLI)
- Grok
- OpenCode

A Kiro provider is in review as a draft PR. It is scoped to Code mode only; Kiro's multi-agent Crew capability is deliberately disabled behind safety gates that are not yet met, so it will not ship enabled by default.

Install and authenticate at least one provider before use, for example:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Copilot: install [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli), then sign in from Neokod using the in-app GitHub device sign-in flow, no separate login command needed
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
- Grok: install [Grok CLI](https://docs.x.ai/build/overview) and authenticate it directly
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

## Install and run

### Desktop app

Install the latest macOS or Windows build from [Neokod releases](https://github.com/kamo62/neokod/releases). macOS builds are signed and notarized. Windows builds are not signed yet, so Windows SmartScreen may require manual confirmation.

## Local access boundary

Neokod is local-first, and that boundary applies the same way to Code mode and Symphony mode: both run through the same local server, with no application session, pairing flow, cookie, or bearer credential on the loopback listener. The native desktop backend and the standalone `neokod serve` listen on `127.0.0.1` and use direct HTTP and WebSocket connections. This matches a single-user-per-machine model, like a local IDE. It is not a multi-user service.

The only non-loopback exception is a desktop-managed WSL backend. It listens on `0.0.0.0` inside WSL and stays fail-closed behind a desktop-generated bearer for HTTP plus short-lived, single-use WebSocket tickets. The WSL credential is delivered only through the live desktop topology and is never persisted.

## Security posture

The loopback listener validates `Host` and `Origin` on every request before any route runs, but it still trusts everything that can authenticate to it. Read this before assuming "local only" means "only I can reach it".

- `neokod serve` binds `127.0.0.1` with the `loopback` transport. Router-wide transport validation (`apps/server/src/transport/LocalTransportAuth.ts`) runs before route dispatch and before the `/ws` upgrade: it accepts loopback Hosts (`127.0.0.1`, `localhost`, `[::1]`) and loopback, dev, desktop-renderer (`neokod://app`, `neokod-dev://app`), or self Origins, and rejects anything else with a 403. Malformed or duplicated Host headers are rejected outright. Requests with no `Origin` (non-browser clients such as the desktop renderer) pass the Origin check but are still gated by the credential policy.
- On the `loopback` transport the server performs no application authentication of its own: the HTTP bearer check and the WebSocket ticket check both return immediately (`apps/server/src/transport/WslBearerAuth.ts`, `authorizeBearerHeader` and `consumeWebSocketTicket`). Only the WSL transport described above carries a credential.
- `neokod serve` and `neokod start` mint a per-launch token on the loopback transport when no desktop bootstrap delivered one (plan WS-A2). The token is printed at startup and passed to the browser on the startup URL; the web client uses it as an HTTP bearer and a short-lived WebSocket ticket. It is never persisted, so the loopback listener is unauthenticated only in the legacy desktop bootstrap path.
- A connection to `/ws` gets the full RPC surface. That includes reading and writing files in your workspaces (`projectsReadFile` and `projectsWriteFile`, `apps/server/src/ws.ts` near lines 1230-1260), opening and writing to interactive terminals (`terminalOpen` and `terminalWrite`, near lines 1440-1460), and dispatching the commands that drive agents under your provider credentials (`dispatchCommand`, near line 760). There is no permission layer behind the socket.
- Host and Origin validation blocks DNS rebinding: a page that re-points its own hostname to `127.0.0.1` sends a non-loopback `Host` header, which the listener rejects before any route runs. A page can no longer call the listener as if it were the page's own backend. "I have not exposed a port, so I am safe" is still the wrong conclusion for a machine whose operator visits untrusted pages, but the rebinding vector itself is closed.

Keep the threat in proportion. The loopback bind does keep remote hosts out, and internet-wide scanning does not reach it. What it does not keep out is a malicious or compromised page in your own browser that can authenticate to the listener through one of the accepted Origins, and through a reverse proxy that forwards it.

### Running behind a reverse proxy

The [self-hosting guide](./docs/operations/self-hosting.md) describes the supported way to publish the server at a real hostname: bind loopback and put a reverse proxy with its own authentication in front. That deployment is the awkward case for the listener, because at the socket level a legitimate reverse proxy and a DNS-rebinding attack are both non-loopback. The listener rejects non-loopback `Host` headers unless you declare the public hostname explicitly: run `neokod serve --public-host <hostname> --public-origin <origin>` (or set `NEOKOD_PUBLIC_HOST` / `NEOKOD_PUBLIC_ORIGIN`). The declared pairs are accepted by the router-wide validation; everything else is still rejected with a 403.

What protects a proxied deployment is the proxy's authentication, and only if its rule covers `/ws` as well as the plain HTTP routes. A policy that protects `/` but not the WebSocket upgrade leaves the entire RPC surface open while the login page suggests otherwise. The self-hosting guide covers this failure mode and how to verify the policy actually holds.

## Development

Neokod is a pnpm + Vite+ monorepo. Packages live under the `@neokod/*` scope (`@neokod/web`, `@neokod/desktop`, `@neokod/contracts`, `@neokod/shared`, `@neokod/client-runtime`).

Install the global `vp` tool:

```bash
# macOS / Linux
curl -fsSL https://vite.plus | bash
# Windows
irm https://vite.plus/ps1 | iex
```

Then:

```bash
vp i          # install dependencies
vp dev        # run the app
vp run typecheck
vp test
```

## Where things are

- Symphony mode's domain model and RPC surface: `packages/contracts/src/symphony.ts`. Its runtime lives under `apps/server/src/symphony/`.
- Tracker adapters for Symphony (GitHub Issues, GitHub Projects, Jira, Linear, GitLab, Asana, Azure Boards), each with its own `WORKFLOW.md` configuration keys: `docs/integrations/`.
- Provider drivers and adapters, one directory per provider: `apps/server/src/provider/`.
- Architecture and the access-boundary table: `docs/architecture/overview.md`.
- Full documentation index: [docs](./docs).

## Upstream updates

The fork keeps T3 Code's release-aware rebase helper. In a fresh clone, configure the public upstream once:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
scripts/rebase-upstream.sh
```

The helper selects the latest stable upstream version by default; use `--target <ref>` for an exact tag or nightly ref.

## Notes

Neokod is early. Expect bugs and fast-moving internals. We are not accepting contributions yet. There is no public docs site; see the markdown under [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Symphony tracker integrations](./docs/integrations/symphony-github.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue. Need support? Open an [issue](https://github.com/kamo62/neokod/issues).
