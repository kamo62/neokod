import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { IsoDateTime } from "@neokod/contracts";

/** Current time as an ISO-8601 string, matching the orchestration layer. */
export const nowIso: Effect.Effect<IsoDateTime> = Effect.map(DateTime.now, DateTime.formatIso);
