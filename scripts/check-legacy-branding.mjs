import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const ROOTS = ["apps", "packages", "scripts", "docs"];
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set(["dist", "dist-electron", "node_modules", ".vite-plus"]);
const LEGACY_PATTERN = /t3code|t3tools/i;

const ALLOW_RULES = [
  {
    reason: "allowlist implementation literals",
    path: /^scripts\/check-legacy-branding\.(mjs|ts)$/,
    line: LEGACY_PATTERN,
  },
  {
    reason: "disposable local scratch probe",
    path: /^apps\/server\/scratch-[^/]+\.ts$/,
    line: LEGACY_PATTERN,
  },
  {
    // The child-env scrubber must recognize legacy T3CODE_* prefixed secrets
    // (documented retained surface); its test needs the literal prefix.
    reason: "fixture proving legacy-prefix secret scrubbing",
    path: /^packages\/shared\/src\/providerChildEnv\.test\.ts$/,
    line: /T3CODE_LEGACY/,
  },
  {
    reason: "central compatibility documentation",
    path: /^docs\/reference\/legacy-t3code-compatibility\.md$/,
    line: LEGACY_PATTERN,
  },
  {
    reason: "legacy environment input or scrub test",
    path: /^(apps\/(desktop|server|web)\/|packages\/shared\/src\/projectScripts|scripts\/)/,
    line: /T3CODE_[A-Z0-9_]*/,
  },
  {
    reason: "browser storage and IndexedDB migration",
    path: /^apps\/web\/(index\.html|src\/(composerDraftStore\.test\.ts|hooks\/(useLocalStorage|useTheme)\.ts|lib\/storage\.ts|test\/browser\/reset\.ts|uiStateStore(\.test)?\.ts))$/,
    line: /legacy t3code|t3code[:.]/i,
  },
  {
    reason: "legacy repository config migration",
    path: /^apps\/server\/src\/vcs\/VcsProjectConfig(\.test)?\.ts$/,
    line: /\.t3code|t3code\/vcs/i,
  },
  {
    reason: "legacy desktop package metadata",
    path: /^apps\/desktop\/src\/app\/DesktopAppIdentity(\.test)?\.ts$/,
    line: /t3codeCommitHash/,
  },
  {
    reason: "fixed Grok OAuth compatibility referrer",
    path: /^apps\/server\/src\/provider\/acp\/GrokAcpSupport(\.test)?\.ts$/,
    line: /t3code/i,
  },
  {
    reason: "upstream repository URL fixture",
    path: /^(apps|scripts)\//,
    line: /github\.com.*t3code/i,
  },
  {
    reason: "source-control fixture copied from an upstream PR",
    path: /^apps\/server\/src\/(git\/GitManager|sourceControl\/GitHubCli)\.test\.ts$/,
    line: /(?:^|["'])t3code\/|[A-Za-z0-9_-]+\/t3code/i,
  },
  {
    reason: "upstream issue citation",
    path: /^apps\/server\/src\//,
    line: /upstream t3code#\d+|pingdotgg\/t3code\/issues\/\d+/i,
  },
  {
    reason: "documented removal of unsafe legacy telemetry fallbacks",
    path: /^apps\/server\/src\/telemetry\/AnalyticsService\.ts$/,
    line: /T3CODE_/,
  },
];

const listFiles = async (directory) => {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(NodePath.extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
};

const failures = [];
for (const root of ROOTS) {
  const files = await listFiles(root);
  for (const file of files) {
    const relativePath = file.split(NodePath.sep).join("/");
    const lines = (await NodeFSP.readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (!LEGACY_PATTERN.test(line)) {
        return;
      }
      if (ALLOW_RULES.some((rule) => rule.path.test(relativePath) && rule.line.test(line))) {
        return;
      }
      failures.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (failures.length > 0) {
  console.error("Unexpected T3Code/T3Tools references found:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  console.error(
    "\nRemove cosmetic references or document a deliberate compatibility rule in scripts/check-legacy-branding.mjs.",
  );
  process.exitCode = 1;
} else {
  console.log("Legacy branding check passed: only documented compatibility references remain.");
}
