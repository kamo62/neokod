/**
 * Fork-owned compact control for Copilot's hidden per-environment fleet/agent
 * settings. These settings already exist and are already patchable — this only
 * surfaces an interactive entry point by REUSING the existing settings-write
 * path (`useUpdateEnvironmentSettings` → patch through `settings.providers`),
 * exactly like the `managedClientEvidence` governance precedent. No new RPC,
 * no contract change.
 *
 * ponytail: intentionally minimal — toggles fleet mode and selects among
 * EXISTING `customAgents`. No agent CRUD / editor / org presets. Upgrade path:
 * add a custom-agent editor surface if authoring (not just selecting) is ever
 * needed; today authoring lives in `settings.json`.
 */
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { CopilotCustomAgents } from "@t3tools/contracts/settings";
import { Bot } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { selectRailPopoverOpenNonce, useWorkspaceRailUiStore } from "../../workspaceRailUiStore";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface AgentOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Pure: build the "Active agent" option list. The empty-string value is the
 * "no custom agent / default" selection that `activeAgent` uses as its default.
 */
export function buildAgentOptions(customAgents: CopilotCustomAgents): AgentOption[] {
  return [
    { value: "", label: "Default" },
    ...customAgents.map((agent) => ({
      value: agent.name,
      label: agent.displayName ?? agent.name,
    })),
  ];
}

export const CopilotThreadControls = memo(function CopilotThreadControls({
  environmentId,
  threadRef,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
}) {
  // Read the whole `providers` object so we can spread it into the patch the
  // same way the governance precedent does; derive the copilot fields from it.
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.providers);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  // Open the popover when a `/fleet` command (or other caller) requests it.
  const [open, setOpen] = useState(false);
  const openNonce = useWorkspaceRailUiStore((s) =>
    selectRailPopoverOpenNonce(s, threadRef, "fleet"),
  );
  const handledNonce = useRef(openNonce);
  useEffect(() => {
    if (openNonce === handledNonce.current) return;
    handledNonce.current = openNonce;
    setOpen(true);
  }, [openNonce]);

  const copilot = providers.githubCopilot;

  const setFleetMode = useCallback(
    (fleetMode: boolean) => {
      updateSettings({
        providers: {
          ...providers,
          githubCopilot: { ...providers.githubCopilot, fleetMode },
        } as typeof providers,
      });
    },
    [providers, updateSettings],
  );

  const setActiveAgent = useCallback(
    (activeAgent: string) => {
      updateSettings({
        providers: {
          ...providers,
          githubCopilot: { ...providers.githubCopilot, activeAgent },
        } as typeof providers,
      });
    },
    [providers, updateSettings],
  );

  // Keep this out of the rail entirely for users who disabled Copilot.
  if (copilot.enabled !== true) {
    return null;
  }

  const agentOptions = buildAgentOptions(copilot.customAgents);
  const hasCustomAgents = copilot.customAgents.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Copilot controls" />}
            />
          }
        >
          <Bot aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">Copilot fleet &amp; agent</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="bottom" className="w-56">
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-foreground">Fleet mode</span>
            <Switch
              checked={copilot.fleetMode}
              onCheckedChange={(checked) => setFleetMode(checked)}
            />
          </label>

          {hasCustomAgents && (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-foreground text-sm">Active agent</span>
              <Select
                value={copilot.activeAgent}
                onValueChange={(value) => setActiveAgent(typeof value === "string" ? value : "")}
              >
                <SelectTrigger size="sm" aria-label="Active agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="start">
                  {agentOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
