import * as Schema from "effect/Schema";

import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

const DesktopBackendBootstrapCommon = {
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  neokodHome: Schema.optional(Schema.String),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
} as const;

// The desktop parent is the only producer of this private envelope. Keep the
// host and transport discriminated so a wildcard listener cannot be requested
// without explicitly selecting the authenticated WSL path.
export const DesktopBackendBootstrap = Schema.Union([
  Schema.Struct({
    ...DesktopBackendBootstrapCommon,
    transport: Schema.Literal("loopback"),
    host: Schema.Literal("127.0.0.1"),
  }),
  Schema.Struct({
    ...DesktopBackendBootstrapCommon,
    transport: Schema.Literal("wsl-bearer"),
    host: Schema.Literal("0.0.0.0"),
    wslBearerToken: TrimmedNonEmptyString,
  }),
]);

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
