import * as Schema from "effect/Schema";

export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";

/** Standalone schema for the v1.20 `elicitation/complete` notification. */
export type CompleteElicitationNotification = {
  readonly elicitationId: string;
  readonly _meta?: { readonly [x: string]: unknown } | null;
};
export const CompleteElicitationNotification = Schema.Struct({
  elicitationId: Schema.String,
  _meta: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
  ),
});

/**
 * Neokod compatibility extension retained for ACP providers that still expose
 * `session/set_model` (not part of the v1.20 standard method metadata).
 */
export type SetSessionModelRequest = {
  readonly sessionId: string;
  readonly modelId: string;
  readonly _meta?: { readonly [x: string]: unknown } | null;
};
export const SetSessionModelRequest = Schema.Struct({
  sessionId: Schema.String,
  modelId: Schema.String,
  _meta: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
  ),
});

export type SetSessionModelResponse = { readonly _meta?: { readonly [x: string]: unknown } | null };
export const SetSessionModelResponse = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
  ),
});
