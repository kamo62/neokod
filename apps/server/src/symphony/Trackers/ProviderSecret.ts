export interface ResolvedProviderSecret {
  readonly resolved: string | undefined;
  readonly envName: string | undefined;
}

/** Resolve a literal, an explicit `$VAR`, or the adapter's documented env fallback. */
export const resolveProviderSecret = (
  value: string | undefined,
  defaultEnvName: string,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedProviderSecret => {
  const match = value === undefined ? null : /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  const envName = value === undefined ? defaultEnvName : match?.[1];
  if (envName === undefined) {
    return { resolved: value, envName: undefined };
  }
  const resolved = env[envName];
  return {
    resolved: resolved === undefined || resolved.length === 0 ? undefined : resolved,
    envName,
  };
};
