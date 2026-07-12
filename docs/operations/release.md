# Neokod desktop releases

`.github/workflows/release.yml` builds and publishes private GitHub Releases for:

- macOS arm64 DMG and update ZIP
- macOS x64 DMG and update ZIP
- Windows x64 NSIS installer with the WSL `node-pty` prebuild

The workflow uses GitHub-hosted runners and does not require T3 Connect, Clerk, Cloudflare, npm,
Vercel, Discord, or a separate GitHub App.

## Stable releases

Push a `vX.Y.Z` tag or dispatch the workflow with `channel=stable` and a version. Plain `X.Y.Z`
versions become the latest GitHub Release; suffixed versions are prereleases.

## Nightly releases

The scheduled job checks every three hours and skips when `HEAD` matches the latest nightly tag. A
manual dispatch with `channel=nightly` uses the same path.

Nightly versions retain the upstream format:

```text
X.Y.(Z+1)-nightly.YYYYMMDD.RUN_NUMBER
```

Both stable and nightly builds include the Electron updater manifests and blockmaps. The updater
repository is derived from `GITHUB_REPOSITORY`, so Neokod builds point at the Neokod repository.

Because the repository is private, users need authenticated GitHub access to download releases or
use the updater. Signing is not configured in the initial workflow; macOS Gatekeeper and Windows
SmartScreen may warn on internal test builds.
