import * as NodeModule from "node:module";

export const getCopilotPlatformPackageNames = (
  platform: NodeJS.Platform,
  architecture: string,
): ReadonlyArray<string> =>
  (platform === "linux" ? ["linux", "linuxmusl"] : [platform]).map(
    (variant) => `@github/copilot-${variant}-${architecture}`,
  );

export const rewriteAsarPath = (path: string): string =>
  path.replace(/\.asar(?=[/\\]|$)/g, ".asar.unpacked");

export type CopilotModuleResolver = (fromPathOrUrl: string, request: string) => string;

const defaultResolveFrom: CopilotModuleResolver = (fromPathOrUrl, request) =>
  NodeModule.createRequire(fromPathOrUrl).resolve(request);

// The native runtime is only reachable through the dependency chain
// server -> @github/copilot-sdk -> @github/copilot -> @github/copilot-<platform>-<arch>,
// because pnpm isolates transitive dependencies, so resolution hops require
// contexts along that chain. @github/copilot has no exports map (subpaths are
// open), and the platform package's "." export is the native binary itself.
export const resolveBundledCopilotRuntime = (input?: {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly resolveFrom?: CopilotModuleResolver;
}): string | undefined => {
  const platform = input?.platform ?? process.platform;
  const architecture = input?.architecture ?? process.arch;
  const resolveFrom = input?.resolveFrom ?? defaultResolveFrom;

  let copilotPackageJson: string;
  try {
    const sdkEntry = resolveFrom(import.meta.url, "@github/copilot-sdk");
    copilotPackageJson = resolveFrom(sdkEntry, "@github/copilot/package.json");
  } catch {
    // The SDK's default resolution remains the development fallback.
    return undefined;
  }

  for (const packageName of getCopilotPlatformPackageNames(platform, architecture)) {
    try {
      return rewriteAsarPath(resolveFrom(copilotPackageJson, packageName));
    } catch {
      // Try the next platform variant.
    }
  }
  return undefined;
};
