/**
 * Fork-owned `/mcp` view: a compact rail popover that lists the Copilot MCP
 * servers configured in `settings.providers.githubCopilot.mcpServers` and lets
 * the user enable/disable each one without editing JSON. Toggling writes the
 * per-server `enabled` flag through the existing `settings.providers` write
 * path; the server-side resolver drops disabled servers before building the
 * SDK config, so a toggle takes effect on the next session.
 *
 * It also surfaces the two auto-injected servers as read-only, informational
 * rows so the list matches what the agent actually sees: the `neokod`
 * automation server (always injected per session) and the AI-Orch gateway
 * (injected when governance is enabled).
 *
 * ponytail: `isMcpServerEnabled` mirrors the server-side predicate in
 * `provider/copilot/CopilotMcpServers.ts`. It's a one-line `enabled !== false`
 * that web can't import from the server module and that doesn't belong in the
 * schema-only contracts package; if a third consumer appears, hoist it to
 * `@neokod/shared`.
 */
import type {
  CopilotMcpServers,
  EnvironmentId,
  ProviderInstanceId,
  ScopedThreadRef,
} from "@neokod/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@neokod/contracts";
import { Boxes } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { selectRailPopoverOpenNonce, useWorkspaceRailUiStore } from "../../workspaceRailUiStore";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type CopilotMcpServer = CopilotMcpServers[string];

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("githubCopilot");

/**
 * Whether the thread's active model-selection instance resolves to the GitHub
 * Copilot driver. Custom instances carry their `driver` in
 * `settings.providerInstances`; built-in instances use the driver's default
 * instance id (`defaultInstanceIdForDriver`). MCP config here is Copilot-only,
 * so the `/mcp` view is gated on this.
 */
export function threadUsesCopilot(
  instanceId: ProviderInstanceId | null | undefined,
  providerInstances: Readonly<Record<string, { readonly driver: ProviderDriverKind }>> | undefined,
): boolean {
  if (!instanceId) return false;
  const custom = providerInstances?.[instanceId]?.driver;
  if (custom) return custom === COPILOT_DRIVER_KIND;
  return String(instanceId) === String(defaultInstanceIdForDriver(COPILOT_DRIVER_KIND));
}

/** A server is active unless it has been explicitly disabled (`enabled: false`). */
export function isMcpServerEnabled(server: CopilotMcpServer): boolean {
  return server.enabled !== false;
}

/** Flip one server's `enabled` flag, returning a new servers record. */
export function toggleCopilotMcpServerEnabled(
  servers: CopilotMcpServers,
  name: string,
): CopilotMcpServers {
  const server = servers[name];
  if (!server) return servers;
  return { ...servers, [name]: { ...server, enabled: !isMcpServerEnabled(server) } };
}

/** Short human-readable transport summary for a server row. */
export function describeMcpServer(server: CopilotMcpServer): string {
  if ("url" in server) {
    return `${server.type} · ${server.url}`;
  }
  const args = server.args && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
  return `stdio · ${server.command}${args}`;
}

export const CopilotMcpControls = memo(function CopilotMcpControls({
  environmentId,
  threadRef,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
}) {
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.providers);
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const copilot = providers.githubCopilot;
  // Shell-only subscription: modelSelection lives on the thread shell, and the
  // detail atom churns on every streaming delta this popover does not care about.
  const modelSelection = useThreadShell(threadRef)?.modelSelection;
  const usesCopilot = threadUsesCopilot(modelSelection?.instanceId, providerInstances);

  const [open, setOpen] = useState(false);
  const openNonce = useWorkspaceRailUiStore((s) => selectRailPopoverOpenNonce(s, threadRef, "mcp"));
  const handledNonce = useRef(openNonce);
  useEffect(() => {
    if (openNonce === handledNonce.current) return;
    handledNonce.current = openNonce;
    if (usesCopilot) {
      setOpen(true);
      return;
    }
    // `/mcp` is Copilot-only; other agents manage MCP servers in their own
    // config, so point the user there instead of opening an empty view.
    toastManager.add({
      type: "info",
      title: "MCP servers are managed per agent",
      description:
        "This thread isn't using GitHub Copilot. Configure MCP servers for the active agent in its own configuration.",
    });
  }, [openNonce, usesCopilot]);

  // Only surface the MCP button/popover when the thread is actually on Copilot.
  if (!usesCopilot) {
    return null;
  }

  const servers = copilot.mcpServers;
  const names = Object.keys(servers).sort((a, b) => a.localeCompare(b));
  const governanceOn =
    copilot.managedClientEvidence.enabled &&
    copilot.managedClientEvidence.governanceUrl.trim().length > 0 &&
    copilot.managedClientEvidence.credential.trim().length > 0;

  const setServerEnabled = (name: string) => {
    updateSettings({
      providers: {
        ...providers,
        githubCopilot: { ...copilot, mcpServers: toggleCopilotMcpServerEnabled(servers, name) },
      } as typeof providers,
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="MCP servers" />}
            />
          }
        >
          <Boxes aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">MCP servers</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="bottom" className="w-72">
        <div className="flex flex-col gap-2.5">
          <p className="text-xs font-medium text-foreground">MCP servers</p>
          {names.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No MCP servers configured. Add them under Settings → Providers → GitHub Copilot.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {names.map((name) => {
                const server = servers[name]!;
                return (
                  <li key={name} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {describeMcpServer(server)}
                      </p>
                    </div>
                    <Switch
                      checked={isMcpServerEnabled(server)}
                      onCheckedChange={() => setServerEnabled(name)}
                      aria-label={`Enable MCP server ${name}`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            <p>Auto-injected (read-only):</p>
            <p className="mt-0.5">• neokod — browser/preview automation</p>
            {governanceOn ? <p>• ai-orch — governance gateway</p> : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
