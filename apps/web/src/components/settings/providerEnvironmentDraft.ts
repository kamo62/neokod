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

export function environmentRowNeedsValue(row: EnvironmentDraftRow): boolean {
  return (
    row.stored !== undefined &&
    row.value === "" &&
    (!row.sensitive || row.name.trim() !== row.stored.name)
  );
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
    const { id: _id, stored: _stored, ...rest } = row;
    published.push({ ...rest, name });
  }
  return published;
}
