"use strict";

// electron-builder custom macOS sign hook, wired as build config `mac.sign` by
// scripts/build-desktop-artifact.ts for signed builds.
//
// Placement: in electron-builder 26.15.6 MacPackager.sign() runs notarization
// immediately after doSign() (macPackager.js), so the `afterSign` hook only
// fires after notarization. Replacing the sign step through `mac.sign` is the
// hook point that runs after signing and before notarization.
//
// Behavior: run electron-builder's default signing unchanged, then verify every
// Mach-O under Contents/Resources/app.asar.unpacked with
// `codesign --verify --strict`. Binaries that fail (for example a vendored
// *.framework directory that ships a bare dylib whose original resource
// envelope was stripped by npm packaging) are re-signed as plain files with the
// identity and per-file options electron-builder resolved, deepest paths first,
// and the default signing runs once more so the enclosing bundles and the app
// seal the repaired content. If verification still fails, the build aborts
// before uploading to Apple.
//
// This file runs inside electron-builder's Node process, which loads hook
// modules with require(), so it is dependency-free CommonJS rather than the
// repo's Effect TypeScript.

const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const MACH_O_MAGICS = new Set([
  0xfeedface, // MH_MAGIC, 32-bit big-endian
  0xcefaedfe, // MH_CIGAM, 32-bit little-endian
  0xfeedfacf, // MH_MAGIC_64, 64-bit big-endian
  0xcffaedfe, // MH_CIGAM_64, 64-bit little-endian
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
  0xbebafeca, // FAT_CIGAM
]);
// FAT_MAGIC collides with the Java class file magic. Bytes 4-7 disambiguate:
// a universal binary stores its architecture count there (single digits in
// practice) while a class file stores minor/major version with major >= 45.
const FAT_MAGIC = 0xcafebabe;
const FAT_MAX_ARCH_COUNT = 44;

const MACH_O_HEADER_LENGTH = 8;

function isMachO(header) {
  if (!Buffer.isBuffer(header) || header.length < MACH_O_HEADER_LENGTH) {
    return false;
  }
  const magic = header.readUInt32BE(0);
  if (magic === FAT_MAGIC) {
    return header.readUInt32BE(4) <= FAT_MAX_ARCH_COUNT;
  }
  return MACH_O_MAGICS.has(magic);
}

function readFileHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(MACH_O_HEADER_LENGTH);
    const bytesRead = fs.readSync(fd, buffer, 0, MACH_O_HEADER_LENGTH, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// Deepest paths first so nested code is always handled before anything that
// encloses it, matching the inside-out order @electron/osx-sign uses.
function sortDeepestFirst(paths) {
  return [...paths].sort((a, b) => {
    const depthDifference = b.split(path.sep).length - a.split(path.sep).length;
    return depthDifference !== 0 ? depthDifference : a.localeCompare(b);
  });
}

// Packaged apps contain no symlinks (electron-builder dereferences while
// staging), so symlinks are skipped rather than followed out of the tree.
function collectMachOFiles(rootDir) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && isMachO(readFileHeader(entryPath))) {
        found.push(entryPath);
      }
    }
  };
  walk(rootDir);
  return sortDeepestFirst(found);
}

// Mirrors the per-file codesign invocation @electron/osx-sign builds in
// signApplication(), fed with the per-file options electron-builder resolved.
function buildCodesignArgs(input) {
  const { filePath, identity, keychain, perFileOptions } = input;
  const args = ["--sign", identity, "--force"];
  if (keychain) {
    args.push("--keychain", keychain);
  }
  if (perFileOptions.requirements) {
    if (perFileOptions.requirements.startsWith("=")) {
      args.push(`-r${perFileOptions.requirements}`);
    } else {
      args.push("--requirements", perFileOptions.requirements);
    }
  }
  args.push(perFileOptions.timestamp ? `--timestamp=${perFileOptions.timestamp}` : "--timestamp");
  const optionsArguments = [];
  if (Array.isArray(perFileOptions.signatureFlags)) {
    optionsArguments.push(...perFileOptions.signatureFlags);
  } else if (typeof perFileOptions.signatureFlags === "string") {
    optionsArguments.push(...perFileOptions.signatureFlags.split(",").map((flag) => flag.trim()));
  }
  if (perFileOptions.hardenedRuntime && !optionsArguments.includes("runtime")) {
    optionsArguments.push("runtime");
  }
  if (optionsArguments.length > 0) {
    args.push("--options", [...new Set(optionsArguments)].join(","));
  }
  if (perFileOptions.additionalArguments) {
    args.push(...perFileOptions.additionalArguments);
  }
  if (perFileOptions.entitlements) {
    args.push("--entitlements", perFileOptions.entitlements);
  }
  args.push(filePath);
  return args;
}

// The default signing lives in app-builder-lib (macCodeSign.sign wraps
// @electron/osx-sign's signAsync with retries). This hook runs inside
// electron-builder's process, so resolve that exact module instead of bundling
// a second copy: prefer the instance the caller already loaded (doSign lives
// next to it), and fall back to resolving through the CLI entry module.
function resolveDefaultSign() {
  const macCodeSignSuffix = path.join("app-builder-lib", "out", "codeSign", "macCodeSign.js");
  const cachedPath = Object.keys(require.cache).find((modulePath) =>
    modulePath.endsWith(macCodeSignSuffix),
  );
  if (cachedPath !== undefined) {
    return require.cache[cachedPath].exports.sign;
  }
  const entry = require.main && require.main.filename;
  if (!entry) {
    throw new Error(
      "mac-nested-sign-hook: unable to resolve app-builder-lib's default mac signing.",
    );
  }
  const appBuilderLibPath = createRequire(entry).resolve("app-builder-lib");
  return createRequire(appBuilderLibPath)("app-builder-lib/out/codeSign/macCodeSign").sign;
}

async function verifyAll(filePaths) {
  const failures = [];
  for (const filePath of filePaths) {
    try {
      await execFileAsync("codesign", ["--verify", "--strict", "--verbose=2", filePath]);
    } catch (error) {
      const detail = error && (error.stderr || error.message);
      failures.push({ filePath, detail: String(detail ?? "codesign verification failed").trim() });
    }
  }
  return failures;
}

function formatFailures(reason, failures) {
  const details = failures
    .map((failure) => `  ${failure.filePath}\n    ${failure.detail.replace(/\n/g, "\n    ")}`)
    .join("\n");
  return `mac-nested-sign-hook: ${failures.length} Mach-O file(s) under app.asar.unpacked failed codesign verification and ${reason}:\n${details}`;
}

// electron-builder resolves the `mac.sign` hook by this export name and calls
// it in place of the default signing (MacPackager.doSign).
async function sign(configuration) {
  const defaultSign = resolveDefaultSign();
  await defaultSign(configuration);

  const unpackedRoot = path.join(configuration.app, "Contents", "Resources", "app.asar.unpacked");
  if (!fs.existsSync(unpackedRoot)) {
    return;
  }

  const machOFiles = collectMachOFiles(unpackedRoot);
  const firstPass = await verifyAll(machOFiles);
  if (firstPass.length === 0) {
    console.log(
      `  • mac-nested-sign-hook: verified ${machOFiles.length} Mach-O file(s) under app.asar.unpacked`,
    );
    return;
  }

  if (typeof configuration.identity !== "string" || configuration.identity.length === 0) {
    throw new Error(formatFailures("no signing identity is available to repair them", firstPass));
  }

  console.log(
    `  • mac-nested-sign-hook: re-signing ${firstPass.length} of ${machOFiles.length} Mach-O file(s) under app.asar.unpacked`,
  );
  // verifyAll preserves collectMachOFiles order, so repairs run deepest first.
  for (const failure of firstPass) {
    await execFileAsync(
      "codesign",
      buildCodesignArgs({
        filePath: failure.filePath,
        identity: configuration.identity,
        keychain: configuration.keychain,
        perFileOptions: configuration.optionsForFile
          ? configuration.optionsForFile(failure.filePath)
          : {},
      }),
    );
  }

  // Re-run the default signing so enclosing bundles and the outer app bundle
  // re-seal the repaired files, then prove the repair actually worked.
  await defaultSign(configuration);
  const secondPass = await verifyAll(collectMachOFiles(unpackedRoot));
  if (secondPass.length > 0) {
    throw new Error(formatFailures("re-signing them did not produce valid signatures", secondPass));
  }
  console.log(
    `  • mac-nested-sign-hook: repaired and verified ${firstPass.length} Mach-O file(s) under app.asar.unpacked`,
  );
}

module.exports = {
  buildCodesignArgs,
  collectMachOFiles,
  isMachO,
  sign,
  sortDeepestFirst,
};
