# Blueprint icon regeneration

Regenerate all development and nightly `blueprint-*` PNG/ICO assets with:

```bash
pnpm generate:blueprint-icons
```

The script uses the already-approved `assets/prod/black-universal-1024.png` Neokod master, resizes it for the 1024px, Apple Touch, and favicon PNGs, and assembles 16/32/48/256px ICO files. It overwrites every `assets/dev/blueprint-*` and `assets/nightly/blueprint-*` binary deterministically. The non-production channels intentionally use the same canonical mark; channel selection remains filename/build-config based.
