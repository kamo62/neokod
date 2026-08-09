// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import packageJson from "../../package.json" with { type: "json" };

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;

type ProcessResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};

export class UpgradeError extends Schema.TaggedErrorClass<UpgradeError>()("UpgradeError", {
  operation: Schema.Union([
    Schema.Literal("readLatestVersion"),
    Schema.Literal("install"),
    Schema.Literal("restart"),
  ]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Supervisor =
  | {
      readonly kind: "systemd-user" | "systemd-system";
      readonly identifier: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly requiresRoot: boolean;
    }
  | {
      readonly kind: "launchd-user" | "launchd-system";
      readonly identifier: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly requiresRoot: boolean;
    };

function toText(value: string | Buffer | null | undefined): string {
  return typeof value === "string" ? value : (value?.toString() ?? "");
}

function runCaptured(command: string, args: ReadonlyArray<string>): ProcessResult {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: toText(result.stdout),
    stderr: toText(result.stderr),
    error: result.error,
  };
}

function runInherited(command: string, args: ReadonlyArray<string>): ProcessResult {
  const result = NodeChildProcess.spawnSync(command, [...args], { stdio: "inherit" });
  return {
    status: result.status,
    stdout: "",
    stderr: "",
    error: result.error,
  };
}

function succeeded(result: ProcessResult): boolean {
  return result.error === undefined && result.status === 0;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function displayCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].map(shellWord).join(" ");
}

function parseSystemdUnits(output: string): ReadonlyArray<string> {
  const units = new Set<string>();
  for (const line of output.split("\n")) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit?.endsWith(".service")) units.add(unit);
  }
  return [...units];
}

function detectSystemd(scope: "user" | "system"): ReadonlyArray<Supervisor> {
  const scopeArgs = scope === "user" ? ["--user"] : [];
  const list = runCaptured("systemctl", [
    ...scopeArgs,
    "list-units",
    "--type=service",
    "--state=active",
    "--no-legend",
    "--no-pager",
  ]);
  if (!succeeded(list)) return [];

  const supervisors: Array<Supervisor> = [];
  for (const unit of parseSystemdUnits(list.stdout)) {
    const details = runCaptured("systemctl", [
      ...scopeArgs,
      "show",
      unit,
      "--property=ActiveState",
      "--property=ExecStart",
      "--property=FragmentPath",
      "--no-pager",
    ]);
    if (!succeeded(details) || !/^ActiveState=active$/m.test(details.stdout)) continue;

    const isNeokod = /neokod/i.test(unit) || /(?:^|[\s/])neokod(?:$|[\s/.-])/i.test(details.stdout);
    if (!isNeokod) continue;

    const args = [...(scope === "user" ? ["--user"] : []), "restart", unit];
    supervisors.push({
      kind: scope === "user" ? "systemd-user" : "systemd-system",
      identifier: unit,
      command:
        scope === "user"
          ? displayCommand("systemctl", args)
          : `sudo ${displayCommand("systemctl", args)}`,
      args,
      requiresRoot: scope === "system",
    });
  }
  return supervisors;
}

function parseLaunchctlLabels(output: string): ReadonlyArray<string> {
  const labels = new Set<string>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0] === "PID") continue;
    const label = fields.slice(2).join(" ");
    if (label.length > 0) labels.add(label);
  }
  return [...labels];
}

function detectLaunchd(
  scope: "user" | "system",
  uid: number | undefined,
): ReadonlyArray<Supervisor> {
  const list = runCaptured("launchctl", scope === "user" ? ["list"] : ["list", "system"]);
  if (!succeeded(list)) return [];

  const domain = scope === "user" ? (uid === undefined ? undefined : `gui/${uid}`) : "system";
  if (domain === undefined) return [];

  const supervisors: Array<Supervisor> = [];
  for (const label of parseLaunchctlLabels(list.stdout)) {
    const details = runCaptured("launchctl", ["print", `${domain}/${label}`]);
    if (!succeeded(details)) continue;
    if (!/neokod/i.test(label) && !/(?:^|[\s/])neokod(?:$|[\s/.-])/i.test(details.stdout)) {
      continue;
    }

    const args = ["kickstart", "-k", `${domain}/${label}`];
    supervisors.push({
      kind: scope === "user" ? "launchd-user" : "launchd-system",
      identifier: label,
      command:
        scope === "user"
          ? displayCommand("launchctl", args)
          : `sudo ${displayCommand("launchctl", args)}`,
      args,
      requiresRoot: scope === "system",
    });
  }
  return supervisors;
}

export function detectSupervisors(platform: NodeJS.Platform): ReadonlyArray<Supervisor> {
  const supervisors =
    platform === "linux" ? [...detectSystemd("user"), ...detectSystemd("system")] : [];
  if (platform === "darwin") {
    const uid = NodeOS.userInfo().uid;
    supervisors.push(...detectLaunchd("user", uid), ...detectLaunchd("system", uid));
  }
  return supervisors;
}

function readLatestVersion(): string {
  const output = NodeChildProcess.execFileSync(
    "npm",
    ["view", packageJson.name, "version", "--json"],
    { encoding: "utf8" },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new Error("npm returned invalid JSON while looking up the latest neokod version.", {
      cause,
    });
  }
  const version = typeof parsed === "string" ? parsed : undefined;
  if (version === undefined || !VERSION_PATTERN.test(version)) {
    throw new Error(`npm returned an invalid latest version: ${JSON.stringify(parsed)}.`);
  }
  return version;
}

function processFailure(result: ProcessResult): string {
  if (result.error !== undefined) return result.error.message;
  return `exit status ${String(result.status)}`;
}

export const runUpgrade = Effect.fn("runUpgrade")(function* (check: boolean) {
  const installedVersion = packageJson.version;
  yield* Console.log(`Installed version: ${installedVersion}`);

  const latestVersion = yield* Effect.try({
    try: readLatestVersion,
    catch: (cause) =>
      new UpgradeError({
        operation: "readLatestVersion",
        message: "Could not determine the latest published neokod version.",
        cause,
      }),
  });
  yield* Console.log(`Latest published version: ${latestVersion}`);

  if (check) {
    yield* Console.log("Check complete; no files, packages, or services were changed.");
    return;
  }

  if (installedVersion === latestVersion) {
    yield* Console.log(
      "The installed version is already latest; reinstalling it and restarting the server anyway.",
    );
  }

  yield* Console.log("Installing the latest Neokod package globally...");
  const install = runInherited("npm", ["install", "--global", `${packageJson.name}@latest`]);
  if (!succeeded(install)) {
    return yield* new UpgradeError({
      operation: "install",
      message: `Global install failed (${processFailure(install)}); the running server was not restarted.`,
      cause: install.error ?? install,
    });
  }
  yield* Console.log(`Global install completed: ${packageJson.name}@${latestVersion}.`);

  yield* Console.log("Looking for a running Neokod supervisor...");
  const supervisors = detectSupervisors(yield* HostProcessPlatform);
  if (supervisors.length === 0) {
    yield* Console.log("No running Neokod supervisor could be identified.");
    yield* Console.log("The new package is installed, but no server was restarted.");
    yield* Console.log("Start the server by hand with: neokod serve");
    return;
  }
  if (supervisors.length > 1) {
    yield* Console.error("Multiple Neokod supervisors were found; no restart was attempted:");
    for (const supervisor of supervisors) {
      yield* Console.error(`- ${supervisor.kind}: ${supervisor.identifier}`);
    }
    yield* Console.error("The new package is installed. Choose the service to restart manually.");
    for (const supervisor of supervisors) yield* Console.error(`  ${supervisor.command}`);
    return;
  }

  const supervisor = supervisors[0];
  if (supervisor === undefined) return;
  if (supervisor.requiresRoot) {
    yield* Console.log(`Detected ${supervisor.kind} supervisor: ${supervisor.identifier}.`);
    yield* Console.log("Restart requires root, so no privileged command was run automatically.");
    yield* Console.log(`Run this by hand: ${supervisor.command}`);
    return;
  }

  yield* Console.log(`Detected ${supervisor.kind} supervisor: ${supervisor.identifier}.`);
  yield* Console.log(`Restarting with: ${supervisor.command}`);
  const restart = runInherited(
    supervisor.kind.startsWith("systemd") ? "systemctl" : "launchctl",
    supervisor.args,
  );
  if (!succeeded(restart)) {
    yield* Console.error(
      `Restart failed (${processFailure(restart)}). The new package is installed, but the old server may still be running.`,
    );
    yield* Console.error(`Run manually: ${supervisor.command}`);
    return yield* new UpgradeError({
      operation: "restart",
      message: "Neokod restart failed after the global install.",
      cause: restart.error ?? restart,
    });
  }
  yield* Console.log("Server restart completed successfully.");
});

export const upgradeCommand = Command.make(
  "upgrade",
  {
    check: Flag.boolean("check").pipe(
      Flag.withAlias("dry-run"),
      Flag.withDescription("Report installed versus latest versions without changing anything."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => runUpgrade(check),
).pipe(
  Command.withAlias("update"),
  Command.withDescription("Install the latest Neokod server and restart its supervisor."),
);
