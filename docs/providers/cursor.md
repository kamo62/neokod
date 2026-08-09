# Cursor

Cursor's agent CLI as a Neokod provider, over the Agent Client Protocol (ACP).

## What It Is

Neokod's Cursor provider spawns the Cursor CLI and talks to it over ACP (Agent Client Protocol), the
same open protocol Neokod uses for Grok. Cursor ships as an Early Access provider in Neokod's UI:
expect rougher edges than Claude, Codex, or Copilot.

## Install

Install Cursor's CLI from [cursor.com/cli](https://cursor.com/cli).

## Authenticate

Log in with the Cursor CLI itself, outside Neokod:

```bash
cursor-agent login
```

There is no in-app sign-in for Cursor; authentication is entirely the CLI's own login, and Neokod
reads back whatever session it finds.

Neokod defaults the "Binary path" setting to `cursor-agent`. If Neokod cannot find the CLI, set it
to the full path reported by `which cursor-agent`.

## Neokod Settings

```text
Display name: Cursor
Binary path: cursor-agent (default)
API endpoint: empty (override only for a custom Cursor API endpoint)
```

Neokod spawns `<Binary path> acp` (adding `-e <API endpoint>` first if you set one) and speaks ACP
over its stdio.

## Known Limitations

- Cursor ships as Early Access.
- The parameterized model picker, with per-model reasoning effort, context window, and fast-mode
  options, requires Cursor CLI 2026.04.08 or newer on Cursor's `lab` channel. Older or other-channel
  installs get a plain model list. Run `cursor-agent set-channel lab && cursor-agent update` to
  switch.
- Cursor has no AI reviewer of its own: Neokod's "Auto" runtime mode falls back to asking you for
  approval for Cursor, the same as "Supervised".
- Cursor can be configured as a Symphony code-review agent. Symphony's execution agent is Codex
  only today; see [Symphony architecture](../architecture/symphony.md).
