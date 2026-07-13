# CI quality gates

- `.github/workflows/ci.yml` runs checks, typechecks, tests, the desktop build, and a separate blocking Chromium browser-test job on GitHub-hosted runners for pull requests and pushes to `main`.
- Run the browser lane locally with:

  ```sh
  vp install --frozen-lockfile
  vp run --filter @neokod/web test:browser:install
  vp run --filter @neokod/web test:browser
  ```

  `test:browser:install` installs Chromium and its required system dependencies. The CI job caches `~/.cache/ms-playwright`; system packages from the Chromium install are not cached.

- Browser tests run serially in deterministic Chromium: 1280×900 viewport, DPR 1, `en-US`, UTC, light color scheme, and reduced motion. Use role, text, and state assertions—no screenshots, geometry checks, or arbitrary sleeps in this blocking lane.
- `browser_test` is separate from the existing 10-minute unit-test job and is blocking: it has no retries or `continue-on-error` exceptions.
- `.github/workflows/release.yml` builds Neokod for macOS (`arm64` and `x64`) and Windows (`x64`) and publishes one private GitHub Release.
- Stable and nightly channels use the same version/tag scheme as upstream T3 Code. Initial artifacts are unsigned.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
