# Legacy T3Code compatibility

Neokod is the product identity. First-party UI copy, package scopes, temporary names, editor namespaces, and newly introduced configuration must use `Neokod`, `neokod`, `@neokod/*`, or `NEOKOD_*` as appropriate.

A small set of T3Code-era values remains intentionally supported so existing local installations and automation do not lose state or silently change behavior. These values are compatibility inputs, not product branding.

## Retained surfaces

- **Environment variables:** `NEOKOD_*` is authoritative. Documented `T3CODE_*` names remain read-only fallbacks in CLI, desktop, development, build, source-control, and project-script paths. When both exist, the Neokod value wins. Child-process environment scrubbing recognizes both prefixes so legacy secrets cannot leak.
- **Browser state:** legacy `t3code:` and `t3code.` local-storage keys, renderer-state keys, the theme key, composer drafts, and the connection-runtime IndexedDB name are read or deleted only for migration/reset. New writes use Neokod keys.
- **Repository configuration:** `.t3code/vcs.json` remains a read fallback when `.neokod/vcs.json` is absent. New configuration is written under `.neokod`.
- **Desktop package metadata:** `t3codeCommitHash` remains a decode fallback for packages produced before `neokodCommitHash`.
- **Project scripts:** `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH` continue to be exported beside their `NEOKOD_*` equivalents for existing user scripts.
- **Grok OAuth:** the referrer value `t3code` is fixed provider compatibility data. Rename it only after provider confirmation and a migration plan.
- **Upstream provenance and fixtures:** links to `pingdotgg/t3code`, cited upstream issue numbers, and source-control fixtures copied from real upstream pull requests remain because changing them would erase provenance or weaken parser coverage.
- **Telemetry history:** comments documenting removal of unsafe `T3CODE_POSTHOG_*` fallbacks remain as a security rationale; those variables are not accepted by the runtime.

## Not allowed

Do not add T3Code/T3Tools product copy, package names, temporary-directory prefixes, test-only cosmetic names, editor namespaces, or new legacy-only environment switches. New environment controls must use `NEOKOD_*`; add a legacy fallback only when an existing released input must remain readable.

## Validation and retirement

Run:

```bash
node scripts/check-legacy-branding.mjs
```

The check scans `apps`, `packages`, `scripts`, and `docs` and fails every reference outside the path-and-content allowlist in `/scripts/check-legacy-branding.ts`.

A retained surface may be removed only with all of the following:

1. a documented support-window decision;
2. migration or explicit data-loss impact for persisted state;
3. focused tests updated to prove the retirement behavior; and
4. release notes that identify the removed fallback.
