import * as NetService from "@neokod/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@neokod/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@neokod/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";

export const modeFlag = Flag.choice("mode", ServerConfig.RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode."),
  Flag.optional,
);
export const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
export const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to NEOKOD_HOME)."),
  Flag.optional,
);
export const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
export const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
export const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
export const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to NEOKOD_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
const envConfig = <A>(
  name: string,
  legacyName: string,
  read: (key: string) => Config.Config<A>,
) => read(name).pipe(Config.orElse(() => read(legacyName)));

const EnvServerConfig = Config.all({
  logLevel: envConfig("NEOKOD_LOG_LEVEL", "T3CODE_LOG_LEVEL", Config.logLevel).pipe(Config.withDefault("Info")),
  traceMinLevel: envConfig("NEOKOD_TRACE_MIN_LEVEL", "T3CODE_TRACE_MIN_LEVEL", Config.logLevel).pipe(Config.withDefault("Info")),
  traceTimingEnabled: envConfig("NEOKOD_TRACE_TIMING_ENABLED", "T3CODE_TRACE_TIMING_ENABLED", Config.boolean).pipe(Config.withDefault(true)),
  traceFile: envConfig("NEOKOD_TRACE_FILE", "T3CODE_TRACE_FILE", Config.string).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxBytes: envConfig("NEOKOD_TRACE_MAX_BYTES", "T3CODE_TRACE_MAX_BYTES", Config.int).pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: envConfig("NEOKOD_TRACE_MAX_FILES", "T3CODE_TRACE_MAX_FILES", Config.int).pipe(Config.withDefault(10)),
  traceBatchWindowMs: envConfig("NEOKOD_TRACE_BATCH_WINDOW_MS", "T3CODE_TRACE_BATCH_WINDOW_MS", Config.int).pipe(Config.withDefault(200)),
  otlpTracesUrl: envConfig("NEOKOD_OTLP_TRACES_URL", "T3CODE_OTLP_TRACES_URL", Config.string).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: envConfig("NEOKOD_OTLP_METRICS_URL", "T3CODE_OTLP_METRICS_URL", Config.string).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: envConfig("NEOKOD_OTLP_EXPORT_INTERVAL_MS", "T3CODE_OTLP_EXPORT_INTERVAL_MS", Config.int).pipe(
    Config.withDefault(10_000),
  ),
  otlpServiceName: envConfig("NEOKOD_OTLP_SERVICE_NAME", "T3CODE_OTLP_SERVICE_NAME", Config.string).pipe(Config.withDefault("neokod-server")),
  mode: envConfig("NEOKOD_MODE", "T3CODE_MODE", (name) => Config.schema(ServerConfig.RuntimeMode, name)).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: envConfig("NEOKOD_PORT", "T3CODE_PORT", Config.port).pipe(Config.option, Config.map(Option.getOrUndefined)),
  neokodHome: envConfig("NEOKOD_HOME", "T3CODE_HOME", Config.string).pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: envConfig("NEOKOD_NO_BROWSER", "T3CODE_NO_BROWSER", Config.boolean).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: envConfig("NEOKOD_BOOTSTRAP_FD", "T3CODE_BOOTSTRAP_FD", Config.int).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: envConfig("NEOKOD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", Config.boolean).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: envConfig("NEOKOD_LOG_WS_EVENTS", "T3CODE_LOG_WS_EVENTS", Config.boolean).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

export interface CliServerFlags {
  readonly mode: Option.Option<ServerConfig.RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

export interface CliProjectLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

export const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: ServerConfig.RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(bootstrap?.mode),
        Option.fromUndefinedOr(env.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(bootstrap?.port),
        Option.fromUndefinedOr(env.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(ServerConfig.DEFAULT_PORT);
          }
          return findAvailablePort(ServerConfig.DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(bootstrap?.neokodHome),
          Option.fromUndefinedOr(env.neokodHome),
        ),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(bootstrap?.noBrowser),
        Option.fromUndefinedOr(env.noBrowser),
      ),
      () => mode === "desktop",
    );
    const wslBearerToken =
      bootstrap?.transport === "wsl-bearer" ? bootstrap.wslBearerToken : undefined;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const staticDir = devUrl ? undefined : yield* ServerConfig.resolveStaticDir();
    const transport = bootstrap?.transport ?? "loopback";
    const host = bootstrap?.host ?? "127.0.0.1";
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        bootstrap?.otlpTracesUrl ??
        env.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        bootstrap?.otlpMetricsUrl ??
        env.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      transport,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      wslBearerToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

export const resolveCliProjectConfig = (
  flags: CliProjectLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
