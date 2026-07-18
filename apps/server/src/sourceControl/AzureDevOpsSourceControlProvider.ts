import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type SourceControlProviderAuth,
} from "@neokod/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

const AZURE_DEVOPS_EXTENSION_ARGS = ["extension", "show", "--name", "azure-devops"];
const AZURE_DEVOPS_EXTENSION_INSTALL_HINT =
  "Install the Azure DevOps CLI extension: az extension add --name azure-devops";

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account !== undefined && account.length > 0) {
    return providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

// Matches the az CLI's own wording when an extension is not installed, e.g.
// `The extension azure-devops is not installed.` Requiring both the extension name and
// a "not installed"/"not found" phrase keeps this from misfiring on unrelated az failures
// (corrupt config, tenant errors, transient network issues) that also exit non-zero.
function isAzureDevOpsExtensionNotInstalledMessage(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("azure-devops") &&
    (normalized.includes("not installed") || normalized.includes("not found"))
  );
}

function refineAzureAuth(input: {
  readonly auth: SourceControlProviderAuth;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly cwd: string;
}): Effect.Effect<SourceControlProviderAuth> {
  // Only a confirmed Azure login is worth refining further; leave unauthenticated
  // and unknown auth states as-is since the extension check would be moot.
  if (input.auth.status !== "authenticated") {
    return Effect.succeed(input.auth);
  }

  return input.process
    .run({
      operation: "source-control.discovery.azure-devops-extension",
      command: "az",
      args: AZURE_DEVOPS_EXTENSION_ARGS,
      cwd: input.cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 8_000,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) => {
        if (result.exitCode === 0) {
          return input.auth;
        }

        // Any other non-zero exit is an unrelated az failure, not proof the extension is
        // missing: fail open and keep the already-confirmed authenticated state.
        if (!isAzureDevOpsExtensionNotInstalledMessage(`${result.stdout}\n${result.stderr}`)) {
          return input.auth;
        }

        return providerAuth({
          status: "unknown",
          account: Option.getOrUndefined(input.auth.account),
          host: "dev.azure.com",
          detail: AZURE_DEVOPS_EXTENSION_INSTALL_HINT,
        });
      }),
      Effect.orElseSucceed(() => input.auth),
    );
}

export const discovery = {
  type: "cli",
  kind: "azure-devops",
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  parseAuth: parseAzureAuth,
  refineAuth: refineAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: false,
  };
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      azure.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      azure.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      azure.getDefaultBranch({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "checkoutChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
