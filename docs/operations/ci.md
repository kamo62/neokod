# CI quality gates

- `.github/workflows/ci.yml` runs checks, typechecks, tests, and the desktop build on GitHub-hosted runners for pull requests and pushes to `main`.
- `.github/workflows/release.yml` builds Neokod for macOS (`arm64` and `x64`) and Windows (`x64`) and publishes one private GitHub Release.
- Stable and nightly channels use the same version/tag scheme as upstream T3 Code. Initial artifacts are unsigned.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
