import type { ProviderInstanceEnvironmentVariable } from "@neokod/contracts";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
  /** Present when the row was loaded with a stored secret; holds the key it is stored under. */
  readonly stored?: { readonly name: string };
};

export function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
    ...(variable.sensitive && variable.valueRedacted === true
      ? { stored: { name: variable.name } }
      : {}),
  };
}

export function applyEnvironmentRowPatch(
  row: EnvironmentDraftRow,
  patch: Partial<Omit<EnvironmentDraftRow, "id" | "stored">>,
): EnvironmentDraftRow {
  const merged = { ...row, ...patch };
  if (row.stored !== undefined) {
    // The stored secret stays linked only while the row still targets the
    // original stored name, remains sensitive, and has no replacement value.
    // Any other combination detaches the link and requires a new value before
    // the section may publish.
    return {
      ...merged,
      valueRedacted:
        merged.value === "" && merged.sensitive && merged.name.trim() === row.stored.name,
    };
  }
  if (patch.value !== undefined) return { ...merged, valueRedacted: false };
  if (patch.sensitive === false) return { ...merged, valueRedacted: false };
  return merged;
}

/**
 * Reconcile draft rows with the stored secrets the server currently reports.
 *
 * A row only keeps a stored-secret link while that name is still present in
 * the authoritative environment as a redacted sensitive variable. When a
 * replacement was acknowledged under a new name, the link moves to that name;
 * when the name is gone, the link is dropped so restoring the old name cannot
 * re-publish `valueRedacted` for a secret that no longer exists.
 *
 * Row drafts (name, value, sensitive) are never rewritten here, so a failed
 * save keeps whatever the user typed and keeps ownership of the still-stored
 * original secret.
 */
export function reconcileEnvironmentRows(
  rows: ReadonlyArray<EnvironmentDraftRow>,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<EnvironmentDraftRow> {
  const storedSecretNames = new Set<string>();
  for (const variable of environment) {
    if (variable.sensitive && variable.valueRedacted === true) {
      storedSecretNames.add(variable.name.trim());
    }
  }

  let changed = false;
  const reconciled = rows.map((row) => {
    const name = row.name.trim();
    const storedName =
      row.stored !== undefined && storedSecretNames.has(row.stored.name)
        ? row.stored.name
        : storedSecretNames.has(name)
          ? name
          : undefined;
    const valueRedacted =
      storedName !== undefined && row.value === "" && row.sensitive && name === storedName;
    const storedUnchanged =
      storedName === undefined ? row.stored === undefined : row.stored?.name === storedName;

    if (storedUnchanged && row.valueRedacted === valueRedacted) return row;

    changed = true;
    const { stored: _stored, valueRedacted: _valueRedacted, ...rest } = row;
    return {
      ...rest,
      ...(storedName !== undefined ? { stored: { name: storedName } } : {}),
      valueRedacted,
    };
  });

  return changed ? reconciled : rows;
}

export function environmentRowNeedsValue(row: EnvironmentDraftRow): boolean {
  if (row.stored !== undefined) {
    return row.value === "" && (!row.sensitive || row.name.trim() !== row.stored.name);
  }
  // A named sensitive row without an authoritative stored link has no secret
  // to preserve. Require a value instead of publishing an empty sensitive
  // variable, which the server treats as "remove any secret under this name".
  return row.sensitive && row.value === "" && row.name.trim().length > 0;
}

export function publishableEnvironment(
  rows: ReadonlyArray<EnvironmentDraftRow>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> | null {
  const published: ProviderInstanceEnvironmentVariable[] = [];
  for (const row of rows) {
    if (environmentRowNeedsValue(row)) return null;
    const name = row.name.trim();
    if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      if (
        name.length > 0 ||
        row.value.length > 0 ||
        row.sensitive !== true ||
        row.valueRedacted !== undefined
      ) {
        return null;
      }
      continue;
    }
    if (
      row.valueRedacted === true &&
      (row.value !== "" || !row.sensitive || row.stored?.name !== name)
    ) {
      return null;
    }
    const { id: _id, stored: _stored, ...rest } = row;
    published.push({ ...rest, name });
  }
  return published;
}
