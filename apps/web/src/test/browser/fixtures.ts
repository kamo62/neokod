import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ClientOrchestrationCommand,
  type OrchestrationThreadStreamItem,
  type ServerConfig,
  type TerminalEvent,
} from "@neokod/contracts";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@neokod/client-runtime/connection";

export const BROWSER_ENVIRONMENT_ID = EnvironmentId.make("browser-environment");
export const BROWSER_HTTP_URL = "http://127.0.0.1:3773";
export const BROWSER_WS_URL = "ws://127.0.0.1:3773/ws";

const target = new PrimaryConnectionTarget({
  environmentId: BROWSER_ENVIRONMENT_ID,
  label: "Browser environment",
  httpBaseUrl: BROWSER_HTTP_URL,
  wsBaseUrl: "ws://127.0.0.1:3773",
});

export const browserConnectionFixture: PreparedConnection = {
  environmentId: BROWSER_ENVIRONMENT_ID,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: BROWSER_WS_URL,
  wslBearerAuthorization: null,
  target,
};

export const browserServerConfigFixture: ServerConfig = {
  environment: {
    environmentId: BROWSER_ENVIRONMENT_ID,
    label: "Browser environment",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-browser-test",
    capabilities: { repositoryIdentity: true },
  },
  cwd: "/tmp/browser-workspace",
  keybindingsConfigPath: "/tmp/browser-workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/browser-logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

export const browserTerminalOutputFixture: TerminalEvent = {
  type: "output",
  threadId: "thread-browser",
  terminalId: "term-browser",
  sequence: 1,
  data: "browser RPC round-trip",
};

export const browserTerminalExitFixture: TerminalEvent = {
  type: "exited",
  threadId: "thread-browser",
  terminalId: "term-browser",
  sequence: 2,
  exitCode: 0,
  exitSignal: null,
};

export const browserApprovalCommandFixture = {
  type: "thread.approval.respond",
  commandId: "command-browser-approval",
  threadId: "thread-browser",
  requestId: "approval-browser",
  decision: "accept",
  createdAt: "2026-07-14T10:00:00.000Z",
} as unknown as ClientOrchestrationCommand;

export const browserInputCommandFixture = {
  type: "thread.user-input.respond",
  commandId: "command-browser-input",
  threadId: "thread-browser",
  requestId: "input-browser",
  answers: { answer: "yes" },
  createdAt: "2026-07-14T10:00:01.000Z",
} as unknown as ClientOrchestrationCommand;

export const browserThreadEventFixtures: ReadonlyArray<OrchestrationThreadStreamItem> = [];
