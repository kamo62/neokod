import * as Schema from "effect/Schema";

export const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
export const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
