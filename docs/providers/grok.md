# Grok

xAI's Grok CLI as a Neokod provider, over the Agent Client Protocol (ACP).

## What It Is

Neokod's Grok provider spawns the Grok CLI and talks to it over ACP (Agent Client Protocol), the
same protocol Neokod uses for Cursor. Grok ships disabled by default and marked Early Access: Claude
and Copilot are Neokod's out-of-the-box providers, and Grok is opt-in.

## Install

Install the [Grok CLI](https://docs.x.ai/build/overview).

## Authenticate

Authenticate the Grok CLI directly, outside Neokod; there is no in-app Grok sign-in flow. Neokod
looks for credentials in this order:

1. An `XAI_API_KEY` environment variable set on the provider instance.
2. Otherwise, whatever session the Grok CLI itself has cached from a previous interactive login.

## Neokod Settings

```text
Display name: Grok
Binary path: grok
```

Grok is off by default; add a Grok provider instance from Settings to turn it on. Neokod spawns
`<Binary path> agent stdio` and speaks ACP over its stdio.

## Known Limitations

- Grok ships disabled by default and marked Early Access.
- Grok has no AI reviewer of its own: Neokod's "Auto" runtime mode falls back to asking you for
  approval for Grok, the same as "Supervised".
- Neokod asks Grok's ACP session to apply a changed model before the next turn, so model switching
  does not require a new thread. A CLI build that rejects `session/set_model` fails that turn instead
  of silently using the old model.
- Rolling back a Grok thread to an earlier point is not supported yet; the ACP session rejects the
  request.
- Grok can be configured as a Symphony code-review agent. Symphony's execution agent is Codex
  only today; see [Symphony architecture](../architecture/symphony.md).
