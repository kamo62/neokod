# Copilot

GitHub Copilot as a Neokod provider, including Neokod's in-app GitHub device sign-in.

## What It Is

Neokod's Copilot provider drives GitHub Copilot's coding-agent runtime through the official
`@github/copilot-sdk`. This is different from Claude, Codex, Cursor, and Grok: Neokod does not spawn
a `copilot` binary that you install and update yourself. The Copilot CLI runtime ships bundled inside
the SDK, and Neokod resolves and runs it directly.

## Install

Nothing to install first. Neokod bundles the Copilot runtime through `@github/copilot-sdk`. The
"Runtime path" setting below exists only to point Neokod at a different Copilot CLI build; leave it
blank to use the bundled runtime, which is what most sessions should use.

## Authenticate

Sign in from inside Neokod, not from a terminal. Open Settings, find the Copilot provider, and click
"Sign in with GitHub":

1. Neokod starts a GitHub device-code flow and shows a short code, plus a button that opens
   `github.com/login/device`.
2. Enter the code at GitHub and approve the sign-in.
3. Neokod polls for authorization, confirms once it succeeds, then verifies Copilot access.

No separate `copilot login` command is needed. A GitHub account with a Copilot subscription or an
assigned Copilot seat is required; signing in without one completes the GitHub step but fails the
Copilot access check that follows. The GitHub token this flow captures is stored as a server secret
and is not sent back to the browser. Sign out from the same Settings panel to clear it.

If you cannot use the in-app flow, for example on a headless machine, Copilot also accepts a token
from the environment: set `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` on the provider
instance.

## Neokod Settings

```text
Display name: Copilot
Runtime path: empty (use the bundled runtime)
COPILOT_HOME path: empty (use your normal home directory)
```

Leave "Runtime path" blank unless you specifically need a different Copilot CLI build; there is no
separate binary for Neokod to keep updated the way there is for Claude or Codex. Give a second Copilot
provider instance its own `COPILOT_HOME path` (for example `~/.copilot_work`) the same way you would
isolate a second Claude or Codex account, to keep its session state and config separate from your
default instance.

## Known Limitations

- A GitHub account without a Copilot subscription or assigned seat can complete GitHub sign-in but
  will fail the Copilot access check afterward.
- Copilot has no AI reviewer of its own: Neokod's "Auto" runtime mode falls back to asking you for
  approval for Copilot, the same as "Supervised". Only "Full access" mode auto-approves.
- Copilot can be configured as a Symphony code-review agent. Symphony's execution agent is Codex
  only today; see [Symphony architecture](../architecture/symphony.md).
