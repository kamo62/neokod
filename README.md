# Neokod

Neokod is a private fork of T3 Code: a minimal desktop GUI for coding agents including Codex, Claude, Cursor, OpenCode, and GitHub Copilot.

## Installation

> [!WARNING]
> Neokod currently supports Codex, Claude, Cursor, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest macOS or Windows desktop build from [Neokod releases](https://github.com/kamo62/neokod/releases).

The initial builds are unsigned, so macOS Gatekeeper and Windows SmartScreen may require manual confirmation.

### Local access boundary

Neokod is local-first. The native desktop backend and standalone `t3 serve`
listen on `127.0.0.1` and use direct HTTP and WebSocket connections without an
application session, pairing flow, cookie, or bearer credential.

The only non-loopback exception is a desktop-managed WSL backend. It listens on
`0.0.0.0` inside WSL and remains fail-closed behind a desktop-generated bearer
for HTTP plus short-lived, single-use WebSocket tickets. The WSL credential is
delivered only through the live desktop topology and is never persisted.

## Upstream updates

The fork keeps T3 Code's release-aware rebase helper. In a fresh clone, configure the public upstream once:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
scripts/rebase-upstream.sh
```

The helper selects the latest stable upstream version by default; use `--target <ref>` when you need an exact tag or nightly ref.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

Neokod uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
