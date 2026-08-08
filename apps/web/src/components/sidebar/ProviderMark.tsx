import { useAtomValue } from "@effect/atom-react";
import {
  isProviderDriverKind,
  type ProviderDriverKind,
  type ServerProvider,
} from "@neokod/contracts";

import { primaryServerProvidersAtom } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "../../lib/utils";
import { DRIVER_OPTION_BY_VALUE } from "../settings/providerDriverMeta";

/**
 * Resolves the driver kind that ran a thread's session. `session.providerName`
 * is the routing-time driver slug and is the primary source. Older or
 * in-flight sessions can carry a `providerInstanceId` without it having
 * synced yet, so that's resolved against the live provider roster (the same
 * one the settings UI reads) as a fallback. Returns `null` for threads with
 * no session at all — an empty draft — so callers render no icon rather than
 * a placeholder.
 */
export function resolveThreadDriverKind(
  thread: Pick<SidebarThreadSummary, "session">,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): ProviderDriverKind | null {
  const session = thread.session;
  if (!session) return null;
  if (session.providerName && isProviderDriverKind(session.providerName)) {
    return session.providerName;
  }
  if (session.providerInstanceId) {
    const match = providers.find((provider) => provider.instanceId === session.providerInstanceId);
    if (match) return match.driver;
  }
  return null;
}

/**
 * Quiet brand mark for the agent/LLM that ran a thread — codex, claude,
 * copilot, and so on — rendered at the start of sidebar thread rows so
 * "who did this work" reads at a glance. Threads without a provider yet
 * (empty drafts) render nothing.
 */
export function ProviderMark({
  thread,
  className,
}: {
  thread: SidebarThreadSummary;
  className?: string;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const driverKind = resolveThreadDriverKind(thread, providers);
  if (!driverKind) return null;
  const Icon = DRIVER_OPTION_BY_VALUE[driverKind]?.icon;
  if (!Icon) return null;
  return <Icon className={cn("size-3.5 shrink-0 text-text-tertiary", className)} aria-hidden />;
}
