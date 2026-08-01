// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

interface CodesignArgsInput {
  readonly filePath: string;
  readonly identity: string;
  readonly keychain?: string | undefined;
  readonly perFileOptions: {
    readonly entitlements?: string;
    readonly hardenedRuntime?: boolean;
    readonly requirements?: string;
    readonly signatureFlags?: string | ReadonlyArray<string>;
    readonly timestamp?: string;
    readonly additionalArguments?: ReadonlyArray<string>;
  };
}

// The hook runs inside electron-builder's Node process and is therefore plain
// CommonJS; load it the same way electron-builder does.
const hook = NodeModule.createRequire(import.meta.url)("./mac-nested-sign-hook.cjs") as {
  buildCodesignArgs: (input: CodesignArgsInput) => Array<string>;
  collectMachOFiles: (rootDir: string) => Array<string>;
  isMachO: (header: Buffer) => boolean;
  sign: unknown;
  sortDeepestFirst: (paths: ReadonlyArray<string>) => Array<string>;
};

const machO64LittleEndian = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const machO64BigEndian = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0x01, 0x00, 0x00, 0x0c]);
const machO32BigEndian = Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0x00, 0x00, 0x00, 0x0c]);
const machO32LittleEndian = Buffer.from([0xce, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x00]);
const machOFatTwoArches = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
const javaClassFile = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);
const elfBinary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const wasmBinary = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

it("detects Mach-O files by magic bytes, not extension", () => {
  assert.isTrue(hook.isMachO(machO64LittleEndian));
  assert.isTrue(hook.isMachO(machO64BigEndian));
  assert.isTrue(hook.isMachO(machO32BigEndian));
  assert.isTrue(hook.isMachO(machO32LittleEndian));
  assert.isTrue(hook.isMachO(machOFatTwoArches));

  assert.isFalse(hook.isMachO(javaClassFile), "Java class files share the fat magic");
  assert.isFalse(hook.isMachO(elfBinary));
  assert.isFalse(hook.isMachO(wasmBinary));
  assert.isFalse(hook.isMachO(Buffer.from("hello wo", "utf8")));
  assert.isFalse(hook.isMachO(Buffer.from([0xcf, 0xfa])), "truncated header");
});

it("orders paths deepest first so nested code is signed inside-out", () => {
  const framework = "/app/Contents/Resources/app.asar.unpacked/x/A.framework";
  const nestedBinary = `${framework}/A`;
  const deeperBinary = `${framework}/Versions/A/A`;
  const shallowBinary = "/app/Contents/Resources/app.asar.unpacked/native.node";

  assert.deepStrictEqual(
    hook.sortDeepestFirst([shallowBinary, framework, nestedBinary, deeperBinary]),
    [deeperBinary, nestedBinary, framework, shallowBinary],
  );
});

it("collects every Mach-O under a directory tree and skips symlinks", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mac-nested-sign-hook-"));
  try {
    const frameworkDir = NodePath.join(root, "vendor", "Pseudo.framework");
    const deepDir = NodePath.join(root, "deep", "nested", "dir");
    NodeFS.mkdirSync(frameworkDir, { recursive: true });
    NodeFS.mkdirSync(deepDir, { recursive: true });

    const frameworkBinary = NodePath.join(frameworkDir, "Pseudo");
    const nativeModule = NodePath.join(root, "native.node");
    const fatBinary = NodePath.join(deepDir, "tool");
    NodeFS.writeFileSync(frameworkBinary, machO64LittleEndian);
    NodeFS.writeFileSync(nativeModule, machO64BigEndian);
    NodeFS.writeFileSync(fatBinary, machOFatTwoArches);

    NodeFS.writeFileSync(NodePath.join(root, "readme.txt"), "not a binary");
    NodeFS.writeFileSync(NodePath.join(root, "module.wasm"), wasmBinary);
    NodeFS.writeFileSync(NodePath.join(root, "Program.class"), javaClassFile);
    NodeFS.symlinkSync(nativeModule, NodePath.join(root, "native-link.node"));

    assert.deepStrictEqual(hook.collectMachOFiles(root), [
      fatBinary,
      frameworkBinary,
      nativeModule,
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("builds the same per-file codesign invocation @electron/osx-sign uses", () => {
  assert.deepStrictEqual(
    hook.buildCodesignArgs({
      filePath: "/stage/App.app/Contents/Resources/app.asar.unpacked/native.node",
      identity: "Developer ID Application: Example (TEAMID9999)",
      keychain: "/tmp/builder.keychain",
      perFileOptions: {
        entitlements: "/stage/entitlements.mac.plist",
        hardenedRuntime: true,
        additionalArguments: [],
      },
    }),
    [
      "--sign",
      "Developer ID Application: Example (TEAMID9999)",
      "--force",
      "--keychain",
      "/tmp/builder.keychain",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      "/stage/entitlements.mac.plist",
      "/stage/App.app/Contents/Resources/app.asar.unpacked/native.node",
    ],
  );
});

it("honors requirements, timestamp URLs, and signature flags without duplicating runtime", () => {
  assert.deepStrictEqual(
    hook.buildCodesignArgs({
      filePath: "/stage/bin",
      identity: "ABCDEF0123456789",
      keychain: undefined,
      perFileOptions: {
        requirements: "=designated => anchor apple",
        timestamp: "http://timestamp.apple.com/ts01",
        signatureFlags: "library, runtime",
        hardenedRuntime: true,
      },
    }),
    [
      "--sign",
      "ABCDEF0123456789",
      "--force",
      "-r=designated => anchor apple",
      "--timestamp=http://timestamp.apple.com/ts01",
      "--options",
      "library,runtime",
      "/stage/bin",
    ],
  );

  assert.deepStrictEqual(
    hook.buildCodesignArgs({
      filePath: "/stage/bin",
      identity: "ABCDEF0123456789",
      perFileOptions: {
        requirements: "/stage/requirements.txt",
        signatureFlags: ["library"],
        additionalArguments: ["--digest-algorithm=sha256"],
      },
    }),
    [
      "--sign",
      "ABCDEF0123456789",
      "--force",
      "--requirements",
      "/stage/requirements.txt",
      "--timestamp",
      "--options",
      "library",
      "--digest-algorithm=sha256",
      "/stage/bin",
    ],
  );
});

it("exposes the hook under the export name electron-builder resolves for mac.sign", () => {
  assert.isFunction(hook.sign);
});
