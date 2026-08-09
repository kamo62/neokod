# OpenCode

OpenCode as a Neokod provider, driven through the official `@opencode-ai/sdk` client against a local
or external OpenCode server.

## What It Is

Neokod's OpenCode provider works differently from the other CLI-driven providers. Instead of talking
to a spawned CLI process directly, Neokod starts (or connects to) an OpenCode server and drives it
over HTTP through `@opencode-ai/sdk`. OpenCode ships disabled by default: Claude and Copilot are
Neokod's out-of-the-box providers, and OpenCode is opt-in.

## Install

Install [OpenCode](https://opencode.ai). Neokod requires OpenCode 1.14.19 or newer; an older CLI
fails the provider status check with an explicit version error.

## Authenticate

Authenticate the OpenCode CLI directly, outside Neokod:

```bash
opencode auth login
```

Neokod does not drive this login itself. It connects to whichever upstream model providers your
OpenCode installation has already authenticated, and reads that state back from OpenCode.

## Neokod Settings

```text
Display name: OpenCode
Binary path: opencode
Server URL: empty (Neokod spawns and manages its own OpenCode server)
Server password: empty (only used when Server URL points at an external server)
```

Leave "Server URL" blank to let Neokod spawn `opencode serve` itself and manage its lifecycle. Set
"Server URL" (for example `http://127.0.0.1:4096`) if you already run your own OpenCode server and
want Neokod to connect to an already-running server; set "Server password" too if that server
requires one. Neokod sends it as HTTP Basic auth and stores it in plain text on disk.

Model selection uses OpenCode's `provider/model` slug format, for example `anthropic/claude-...`.

## Known Limitations

- OpenCode ships disabled by default; add an OpenCode provider instance from Settings to turn it on.
- OpenCode 1.14.19 or newer is required for the self-spawned server path.
- On macOS, a freshly downloaded OpenCode binary can fail Gatekeeper's quarantine check. If Neokod
  reports this, run `xattr -d com.apple.quarantine $(which opencode)`.
- If the self-spawned server takes too long to start on a slow host, raise
  `NEOKOD_OPENCODE_SERVER_TIMEOUT_MS`, or run `opencode serve` yourself and point "Server URL" at it.
- OpenCode's own retry policy has no attempt cap. Neokod terminates retry loops whose messages clearly
  identify an invalid credential, but rate limits, quota failures, network errors, and unrecognized
  retry messages can continue until you stop the turn.
- OpenCode can be configured as a Symphony code-review agent. Symphony's execution agent is Codex
  only today; see [Symphony architecture](../architecture/symphony.md).
