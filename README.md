# Neokod

Neokod is a local-first desktop app for coding with the AI agent CLIs you already use. It brings agent chats, terminals, git worktrees, diffs, and provider sessions into one focused workspace that runs entirely on your machine.

Neokod began as a fork of T3 Code and has been carved down to a local-first 2.0 release: no cloud service, no mobile app, no remote-access control plane. Your projects, threads, and history stay on your machine, and Neokod talks directly to the providers you choose.

## What it does

- Drive coding agents from one desktop workspace: parallel threads, per-thread git worktrees, diffs, branches, commits, and PRs.
- Keep the agent chat, an embedded terminal, and file and preview views together in the same window.
- Get notified when an agent finishes or needs you, so you do not have to watch a thread. An in-app toast appears when you are elsewhere in the app, a native system notification when the window is hidden, and clicking either jumps straight to that thread. Notifications are opt-out and only request OS permission when you ask.
- Stay local. There is no Neokod cloud holding your repositories, chats, or history. The provider you pick still receives the prompts, diffs, and tool output a session needs, but that traffic goes to that provider, not through a Neokod service.

## Providers

Neokod drives agent CLIs you have installed and authenticated yourself. Supported providers:

- Claude (Claude Code)
- Codex (Codex CLI)
- Copilot (GitHub Copilot CLI)
- Cursor (Cursor CLI)
- Grok
- OpenCode

Install and authenticate at least one provider before use, for example:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

## Install and run

### Desktop app

Install the latest macOS or Windows build from [Neokod releases](https://github.com/kamo62/neokod/releases). The initial builds are unsigned, so macOS Gatekeeper and Windows SmartScreen may require manual confirmation.

### Run the CLI without installing

```bash
npx neokod@latest
```

Use `npx neokod@latest --help` for the full reference.

## Local access boundary

Neokod is local-first. The native desktop backend and the standalone `neokod serve` listen on `127.0.0.1` and use direct HTTP and WebSocket connections with no application session, pairing flow, cookie, or bearer credential.

The only non-loopback exception is a desktop-managed WSL backend. It listens on `0.0.0.0` inside WSL and stays fail-closed behind a desktop-generated bearer for HTTP plus short-lived, single-use WebSocket tickets. The WSL credential is delivered only through the live desktop topology and is never persisted.

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
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue. Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
