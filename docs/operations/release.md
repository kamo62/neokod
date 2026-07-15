# Neokod desktop releases

`.github/workflows/release.yml` builds and publishes private GitHub Releases for:

- macOS arm64 DMG and update ZIP
- macOS x64 DMG and update ZIP
- Windows x64 NSIS installer with the WSL `node-pty` prebuild

The workflow uses GitHub-hosted runners and has no hosted application-service or npm-publishing
dependency.

## Normal releases

Every push to `main`, including merged pull requests, builds a normal release. The version is the top
entry of `CHANGELOG.md`, so bumping the changelog and merging cuts that release. A push whose version
already has a release is skipped, so merges that do not change the version do not rebuild or
republish. A manual dispatch with `channel=stable` and an explicit `version` pins a specific version
and always publishes. Plain `X.Y.Z` versions become the latest GitHub Release; suffixed versions are
prereleases.

## Nightly releases

Nightly prereleases are built on demand only: dispatch the workflow with `channel=nightly`. There is
no scheduled or per-commit nightly build.

Nightly versions retain the upstream format:

```text
X.Y.(Z+1)-nightly.YYYYMMDD.RUN_NUMBER
```

Both stable and nightly builds include the Electron updater manifests and blockmaps. The updater
repository is derived from `GITHUB_REPOSITORY`, so Neokod builds point at the Neokod repository.

Because the repository is private, users need authenticated GitHub access to download releases or
use the updater. Signing is not configured in the initial workflow; macOS Gatekeeper and Windows
SmartScreen may warn on internal test builds.
