import type { AttentionItem, EnvironmentId } from "@neokod/contracts";
import { Link } from "@tanstack/react-router";

import { Badge } from "../ui/badge";
import { attentionMode } from "./attention.logic";
import { SymphonyApprovalActions } from "./SymphonyApprovalActions";

const SEVERITY_BADGE: Record<string, "default" | "secondary" | "success" | "warning" | "info"> = {
  critical: "warning",
  high: "warning",
  medium: "info",
  low: "secondary",
};

/**
 * Attention rows with their decision controls. An item is only answerable when
 * the server published a request action for it (`approval` or `question`);
 * informational items such as `pr_creation_failed` render as evidence only.
 */
export function SymphonyAttentionList({
  items,
  environmentId,
  onChanged,
}: {
  readonly items: ReadonlyArray<AttentionItem>;
  readonly environmentId: EnvironmentId;
  readonly onChanged: () => void;
}) {
  return (
    <div className="divide-y rounded-2xl border bg-card">
      {items.map((item) => {
        const mode = attentionMode(item);
        return (
          <div key={item.id} className="space-y-2 px-4 py-3.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                {item.whatHappened}
              </span>
              <Badge variant={SEVERITY_BADGE[item.severity] ?? "secondary"} size="sm">
                {item.severity}
              </Badge>
              <Badge variant="outline" size="sm">
                {item.kind.replaceAll("_", " ")}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground/80">{item.whyHuman}</p>
            {item.recommendedResponse !== undefined ? (
              <p className="text-[11px] text-muted-foreground">{item.recommendedResponse}</p>
            ) : null}
            {item.runAttemptId !== undefined ? (
              <Link
                to="/symphony/$runId"
                params={{ runId: item.runAttemptId }}
                className="inline-block text-xs text-muted-foreground underline"
              >
                Open run
              </Link>
            ) : null}
            {mode === "info" ? null : (
              <SymphonyApprovalActions
                environmentId={environmentId}
                requestId={item.id}
                mode={mode}
                onDone={onChanged}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
