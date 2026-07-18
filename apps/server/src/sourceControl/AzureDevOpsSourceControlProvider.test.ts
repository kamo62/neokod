import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessSpawnError } from "@neokod/contracts";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import { probeSourceControlProvider } from "./SourceControlProviderDiscovery.ts";

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCli["Service"]>) {
  return AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function notFound(input: VcsProcess.VcsProcessInput): VcsProcessSpawnError {
  return new VcsProcessSpawnError({
    operation: input.operation,
    command: input.command,
    cwd: input.cwd,
    cause: new Error(`${input.command} not found`),
  });
}

it.effect("maps Azure DevOps PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "azure-devops",
      number: 42,
      title: "Add Azure provider",
      url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }),
);

it.effect("adds change-request context while retaining Azure CLI causes", () =>
  Effect.gen(function* () {
    const cause = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
      operation: "execute",
      command: "az",
      cwd: "/repo",
      argumentCount: 2,
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      checkoutPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .checkoutChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "azure-devops",
        operation: "checkoutChangeRequest",
        command: "az",
        cwd: "/repo",
        reference: "#42",
        detail: "Azure DevOps CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["createPullRequest"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Azure CLI repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);

it.effect(
  "keeps Azure CLI auth authenticated during discovery when the DevOps extension is installed",
  () =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) => {
          if (input.args.join(" ") === "--version") {
            return Effect.succeed(processResult("azure-cli 2.60.0\n"));
          }
          if (input.args.join(" ") === "account show --query user.name -o tsv") {
            return Effect.succeed(processResult("azure-user@example.com\n"));
          }
          if (input.args.join(" ") === "extension show --name azure-devops") {
            return Effect.succeed(processResult("azure-devops extension installed\n"));
          }
          return Effect.fail(notFound(input));
        },
      };

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOpsSourceControlProvider.discovery,
        process,
        cwd: "/repo",
      });

      assert.deepStrictEqual(
        {
          status: item.status,
          auth: item.auth.status,
          account: item.auth.account,
          detail: item.auth.detail,
        },
        {
          status: "available",
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
      );
    }),
);

it.effect(
  "reports Azure DevOps as detected-but-not-ready during discovery when the CLI extension is missing",
  () =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) => {
          if (input.args.join(" ") === "--version") {
            return Effect.succeed(processResult("azure-cli 2.60.0\n"));
          }
          if (input.args.join(" ") === "account show --query user.name -o tsv") {
            return Effect.succeed(processResult("azure-user@example.com\n"));
          }
          if (input.args.join(" ") === "extension show --name azure-devops") {
            return Effect.succeed(
              processResult("", {
                stderr: "ERROR: The extension azure-devops is not installed.\n",
                exitCode: ChildProcessSpawner.ExitCode(1),
              }),
            );
          }
          return Effect.fail(notFound(input));
        },
      };

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOpsSourceControlProvider.discovery,
        process,
        cwd: "/repo",
      });

      // Extension-missing is reported as "unknown" (not "unauthenticated") because the
      // account genuinely is authenticated; only whether DevOps commands will work is in
      // question. The parsed account is preserved and the remediation detail is set so
      // the UI can surface it instead of a generic "not verified" message.
      assert.deepStrictEqual(
        {
          status: item.status,
          auth: item.auth.status,
          account: item.auth.account,
          detail: item.auth.detail,
        },
        {
          status: "available",
          auth: "unknown",
          account: Option.some("azure-user@example.com"),
          detail: Option.some(
            "Install the Azure DevOps CLI extension: az extension add --name azure-devops",
          ),
        },
      );
    }),
);

it.effect(
  "keeps Azure CLI auth authenticated during discovery when the extension probe fails to spawn",
  () =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) => {
          if (input.args.join(" ") === "--version") {
            return Effect.succeed(processResult("azure-cli 2.60.0\n"));
          }
          if (input.args.join(" ") === "account show --query user.name -o tsv") {
            return Effect.succeed(processResult("azure-user@example.com\n"));
          }
          if (input.args.join(" ") === "extension show --name azure-devops") {
            return Effect.fail(notFound(input));
          }
          return Effect.fail(notFound(input));
        },
      };

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOpsSourceControlProvider.discovery,
        process,
        cwd: "/repo",
      });

      assert.deepStrictEqual(
        {
          status: item.status,
          auth: item.auth.status,
          account: item.auth.account,
          detail: item.auth.detail,
        },
        {
          status: "available",
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
      );
    }),
);

it.effect(
  "keeps Azure CLI auth authenticated during discovery when the extension probe fails for an unrelated reason",
  () =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) => {
          if (input.args.join(" ") === "--version") {
            return Effect.succeed(processResult("azure-cli 2.60.0\n"));
          }
          if (input.args.join(" ") === "account show --query user.name -o tsv") {
            return Effect.succeed(processResult("azure-user@example.com\n"));
          }
          if (input.args.join(" ") === "extension show --name azure-devops") {
            return Effect.succeed(
              processResult("", {
                stderr: "ERROR: Please run 'az login' to setup account.\n",
                exitCode: ChildProcessSpawner.ExitCode(1),
              }),
            );
          }
          return Effect.fail(notFound(input));
        },
      };

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOpsSourceControlProvider.discovery,
        process,
        cwd: "/repo",
      });

      // A non-zero exit that does not actually say the extension is missing (corrupt
      // config, tenant error, transient failure, ...) must not downgrade a genuinely
      // authenticated account.
      assert.deepStrictEqual(
        {
          status: item.status,
          auth: item.auth.status,
          account: item.auth.account,
          detail: item.auth.detail,
        },
        {
          status: "available",
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
      );
    }),
);

it.effect(
  "does not probe the DevOps extension during discovery when the Azure CLI is missing",
  () =>
    Effect.gen(function* () {
      let extensionProbed = false;
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) => {
          if (input.args.join(" ") === "extension show --name azure-devops") {
            extensionProbed = true;
          }
          return Effect.fail(notFound(input));
        },
      };

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOpsSourceControlProvider.discovery,
        process,
        cwd: "/repo",
      });

      assert.strictEqual(item.status, "missing");
      assert.strictEqual(extensionProbed, false);
    }),
);
