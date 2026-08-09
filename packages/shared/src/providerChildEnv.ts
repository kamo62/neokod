/**
 * Shared allowlist-based provider-child environment builder
 * (Issue #101 spec section 9, implementation-sequence step 2).
 *
 * Neokod spawns provider CLIs (Codex app-server, and later `kiro-cli acp`) as
 * child processes. Those children must never inherit neokod's own secrets, the
 * user's source-control PATs, cloud credentials, other providers' API keys,
 * telemetry secrets, database URLs, or desktop bootstrap credentials.
 *
 * The previous Symphony approach removed a blocklist of secret names and then
 * re-merged the full parent environment with `extendEnv: true`, which
 * reintroduced every removed key. That defeated the blocklist entirely.
 *
 * This builder replaces that path with an allowlist model:
 *
 * - The child environment starts EMPTY. Only names on an explicit allowlist of
 *   required process basics (plus caller-approved additions) are ever copied
 *   from the parent environment.
 * - The result is meant to be spawned with `extendEnv: false`, and the builder
 *   returns that flag so no later spawn layer can re-merge `process.env`.
 * - Anything not on the allowlist is dropped by construction, so secret names
 *   never need to be enumerated to be excluded.
 *
 * The builder is a pure function so it can be exercised by both a fast unit
 * test and a production-spawner canary test that proves real parent secrets do
 * not reach an actual spawned child.
 */

/**
 * POSIX process basics a spawned CLI needs to locate its runtime, resolve the
 * user home/temp directories, and render output. Deliberately excludes `PWD`
 * (the spawner sets `cwd` explicitly and a stale inherited `PWD` is
 * misleading).
 */
export const POSIX_BASE_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TMPDIR",
  "TZ",
];

/**
 * Windows process basics. Windows treats environment variable names
 * case-insensitively, so matching is case-insensitive on `win32`; both common
 * casings are listed for clarity.
 */
export const WINDOWS_BASE_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "SYSTEMDRIVE",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "TZ",
];

/** Locale variables so the child renders text and dates consistently. */
export const LOCALE_ALLOWLIST: ReadonlyArray<string> = [
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
];

/**
 * Certificate/CA-bundle paths so the child's TLS stack trusts the same roots
 * the host does. These are filesystem paths, not credentials.
 */
export const CERTIFICATE_ALLOWLIST: ReadonlyArray<string> = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];

export interface BuildProviderChildEnvInput {
  /** The parent environment to filter. Never mutated. */
  readonly parentEnv: NodeJS.ProcessEnv;
  /**
   * Explicit, individually documented additions (e.g. `CODEX_HOME`, an approved
   * Kiro configuration variable). Always included in the result and, when a key
   * collides with an allowlisted parent name, this value wins. A key mapped to
   * `undefined` is omitted entirely.
   */
  readonly additions?: NodeJS.ProcessEnv;
  /**
   * Additional parent variable names the caller explicitly approves to pass
   * through, on top of the process basics. Use for individually documented
   * provider-configuration variables that live in the parent environment.
   */
  readonly allow?: ReadonlyArray<string>;
  /** Host platform supplied by the runtime. */
  readonly platform: NodeJS.Platform;
}

export interface ProviderChildEnv {
  /** The fully-built child environment. Contains only allowlisted names. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Always `false`. Spawn the child with this value so no downstream layer
   * re-merges `process.env` on top of the built environment.
   */
  readonly extendEnv: false;
  /** Names copied from the parent (sorted), for debug-level logging. */
  readonly allowedNames: ReadonlyArray<string>;
  /**
   * Names present in the parent that were dropped (sorted). Log the NAMES at
   * debug level only; never log values.
   */
  readonly omittedNames: ReadonlyArray<string>;
}

function baseAllowlistForPlatform(platform: NodeJS.Platform): ReadonlyArray<string> {
  const base = platform === "win32" ? WINDOWS_BASE_ALLOWLIST : POSIX_BASE_ALLOWLIST;
  return [...base, ...LOCALE_ALLOWLIST, ...CERTIFICATE_ALLOWLIST];
}

/**
 * Builds a provider-child environment from an explicit allowlist. The child
 * environment starts empty; only process basics, locale, certificate paths, the
 * caller's approved `allow` names, and explicit `additions` are included.
 *
 * The returned {@link ProviderChildEnv.extendEnv} is always `false` and must be
 * forwarded to the spawn call so the parent environment is never re-merged.
 */
export function buildProviderChildEnv(input: BuildProviderChildEnvInput): ProviderChildEnv {
  const platform = input.platform;
  const caseInsensitive = platform === "win32";

  const allowNames = [...baseAllowlistForPlatform(platform), ...(input.allow ?? [])];
  const allowSet = new Set(allowNames.map((name) => (caseInsensitive ? name.toUpperCase() : name)));

  const isAllowed = (name: string): boolean =>
    allowSet.has(caseInsensitive ? name.toUpperCase() : name);

  const additions = input.additions ?? {};
  const additionKeys = new Set(
    Object.keys(additions).map((name) => (caseInsensitive ? name.toUpperCase() : name)),
  );
  const isAddition = (name: string): boolean =>
    additionKeys.has(caseInsensitive ? name.toUpperCase() : name);

  const env: NodeJS.ProcessEnv = {};
  const allowedNames: Array<string> = [];
  const omittedNames: Array<string> = [];

  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) {
      continue;
    }
    // An explicit addition takes over this name; account for it under additions
    // so it is neither double-copied nor reported as omitted.
    if (isAddition(name)) {
      continue;
    }
    if (isAllowed(name)) {
      env[name] = value;
      allowedNames.push(name);
    } else {
      omittedNames.push(name);
    }
  }

  for (const [name, value] of Object.entries(additions)) {
    if (value === undefined) {
      continue;
    }
    env[name] = value;
    allowedNames.push(name);
  }

  allowedNames.sort();
  omittedNames.sort();

  return {
    env,
    extendEnv: false,
    allowedNames,
    omittedNames,
  };
}
