export interface ReferenceRepo {
  readonly id: string;
  readonly prefix: string;
  readonly repository: string;
  readonly latestRef: string;
  /**
   * Optional version-source resolution. When absent, the repo is treated as
   * "latest-only": the sync always pins `latestRef` (the current `main`
   * branch), because no installed dependency version maps to it. Reference
   * repos that track an installed package version set this to the file and
   * JSON/YAML path that pins it.
   */
  readonly versionSourcePath?: string | undefined;
  readonly packageVersionPath?: ReadonlyArray<string> | undefined;
  readonly versionTagPrefix?: string | undefined;
}

export const referenceRepos: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect-smol",
    prefix: ".repos/effect-smol",
    repository: "https://github.com/Effect-TS/effect-smol.git",
    latestRef: "main",
    versionSourcePath: "pnpm-workspace.yaml",
    packageVersionPath: ["catalog", "effect"],
    versionTagPrefix: "effect@",
  },
  {
    id: "symphony",
    prefix: ".repos/symphony",
    repository: "https://github.com/openai/symphony.git",
    latestRef: "main",
  },
];
