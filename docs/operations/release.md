# Neokod releases

`.github/workflows/release.yml` builds and publishes GitHub Releases for:

- macOS arm64 DMG and update ZIP
- macOS x64 DMG and update ZIP
- Windows x64 NSIS installer with the WSL `node-pty` prebuild

The workflow uses GitHub-hosted runners and has no hosted application-service dependency.

`.github/workflows/publish-npm.yml` publishes the same server build as the `neokod` CLI package to
npm on every GitHub Release, so it can be installed on a machine that already has the agent CLIs
(a desktop build can't reach that use case). It authenticates through npm Trusted Publishing (OIDC)
against this repository and the workflow's filename, so there is no long-lived npm token in
repository secrets.

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

The repository is public, so anyone can download releases or use the updater without authenticated
GitHub access. macOS builds are signed and notarized with a Developer ID. Windows builds are not
signed, so Windows SmartScreen may warn on install.
