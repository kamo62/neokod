import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type DesktopWslState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import { applyWslEnableSelection } from "./ConnectionsSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  createServerPairingCredential,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  usePrimarySessionState,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";

// Sentinels for the consolidated WSL backend picker. The colon is
// rejected by DISTRO_NAME_PATTERN (validated on the desktop side) so
// neither can collide with a real distro name.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

const PAIRING_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthEnvironmentScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "View environment",
    description: "Read threads, status, diffs, and configuration.",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "Operate tasks",
    description: "Start tasks and perform changes in the environment.",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "Use terminals",
    description: "Create terminals and send input to running shells.",
  },
  {
    scope: AuthReviewWriteScope,
    title: "Write reviews",
    description: "Create comments while reviewing changes.",
  },
  {
    scope: AuthAccessReadScope,
    title: "View access",
    description: "Inspect pairing links and authorized clients.",
  },
  {
    scope: AuthAccessWriteScope,
    title: "Manage access",
    description: "Issue and revoke credentials for other clients.",
  },
];

function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const scopeCountLabel = `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${label}: show ${scopeCountLabel}`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">Granted scopes</p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      title={tooltipText}
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Direct row in the card – same pattern as the Provider / ACP-agent list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

function accessRowClassName() {
  return ITEM_ROW_CLASSNAME;
}

function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;
  const { copyToClipboard } = useCopyToClipboard<"code">({
    target: "pairing code",
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Pairing code copied",
        description: "Paste it into another client to finish pairing.",
      });
    },
    onError: (error) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard ? "Could not copy pairing code" : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });
  const copyPairingCode = useCallback(() => {
    copyToClipboard(pairingLink.credential, "code");
  }, [copyToClipboard, pairingLink.credential]);

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={accessRowClassName()}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">
              {pairingLink.label ?? "Pairing link"}
            </h3>
          </div>
          <p
            className="text-xs text-muted-foreground"
            title={formatAccessTimestamp(pairingLink.expiresAt)}
          >
            {formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
            <span aria-hidden> · </span>
            <AccessScopeSummary scopes={pairingLink.scopes} label="Pairing link scopes" />
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Copy the code into another client configured for this environment.
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard ? (
              <Button size="xs" variant="outline" onClick={copyPairingCode}>
                Copy code
              </Button>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                Show code
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>Pairing code</DialogTitle>
                <DialogDescription>
                  Clipboard copy is unavailable here. Manually copy this code into another client.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Textarea
                  readOnly
                  value={pairingLink.credential}
                  rows={3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
    </div>
  );
});
type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : "Connected"
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : "Not connected yet.";
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={accessRowClassName()}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-[10px] text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {deviceInfoBits.length > 0 ? (
              <>
                {deviceInfoBits.join(" · ")}
                <span aria-hidden> · </span>
              </>
            ) : null}
            <AccessScopeSummary scopes={clientSession.scopes} label="Client scopes" />
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthEnvironmentScope>>([
    ...AuthStandardClientScopes,
  ]);
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createServerPairingCredential({ label: pairingLabel, scopes: pairingScopes });
      setPairingLabel("");
      setPairingScopes([...AuthStandardClientScopes]);
      setDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing URL",
          description: message,
        }),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel, pairingScopes]);

  const togglePairingScope = useCallback((scope: AuthEnvironmentScope, checked: boolean) => {
    setPairingScopes((current) =>
      checked ? [...current, scope] : current.filter((currentScope) => currentScope !== scope),
    );
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "Revoking…" : "Revoke others"}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
            setPairingScopes([...AuthStandardClientScopes]);
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Create link
            </Button>
          }
        />
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time link that another device can use to pair with this backend as an
              authorized client.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Client label (optional)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="e.g. Living room iPad"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-foreground">Permissions</h3>
                  <p className="text-xs text-muted-foreground">
                    Limit what the paired client can do.
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() => setPairingScopes([AuthOrchestrationReadScope])}
                  >
                    Read only
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() => setPairingScopes([...AuthStandardClientScopes])}
                  >
                    Standard
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {PAIRING_SCOPE_OPTIONS.map(({ scope, title, description }) => (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={pairingScopes.includes(scope)}
                      disabled={isCreatingPairingLink}
                      onCheckedChange={(checked) => togglePairingScope(scope, checked === true)}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">{title}</span>
                      <span className="block text-xs leading-snug text-muted-foreground">
                        {description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {pairingScopes.length === 0 ? (
                <p className="text-xs text-destructive">Select at least one permission.</p>
              ) : pairingScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-xs text-warning">
                  This client can create or revoke access for other devices.
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isCreatingPairingLink || pairingScopes.length === 0}
              onClick={() => void handleCreatePairingLink()}
            >
              {isCreatingPairingLink ? "Creating…" : "Create link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const PairingClientsList = memo(function PairingClientsList({
  isLoading,
  pairingLinks,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={accessRowClassName()}>
          <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
        </div>
      ) : null}
    </>
  );
});

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  const canManageLocalBackend = currentSessionScopes?.includes(AuthAccessWriteScope) ?? false;
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(
    primaryEnvironment?.serverConfig ?? null,
  );

  const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
    string | null
  >(null);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);
  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);

  type PendingWslChange =
    | { readonly kind: "disable"; readonly wasWslOnly: boolean }
    | { readonly kind: "distro"; readonly nextDistro: string | null }
    | { readonly kind: "enable"; readonly nextDistro: string | null }
    | { readonly kind: "wsl-only"; readonly nextValue: boolean };
  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);

  const authAccessChanges = useEnvironmentQuery(
    canManageLocalBackend && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  );
  const desktopWsl = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
  );
  const desktopWslState = desktopWsl.data;
  const desktopWslError = desktopWslMutationError ?? desktopWsl.error;
  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;
  const desktopAccessManagementError =
    desktopAccessManagementMutationError ?? authAccessChanges.error;
  const isLoadingDesktopAccessManagement =
    authAccessChanges.isPending && authAccessChanges.data === null;
  const desktopPairingLinks = useMemo(() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  }, [authAccessChanges.data]);
  const desktopClientSessions = useMemo(() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  }, [authAccessChanges.data]);

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementMutationError(null);
    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementMutationError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to revoke client access.";
        setDesktopAccessManagementMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke client access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementMutationError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title:
          revokedCount === 1 ? "Revoked 1 other client" : "Revoked " + revokedCount + " clients",
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke other clients",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  const applyWslSettingChange = useCallback(
    async (apply: () => Promise<DesktopWslState>) => {
      if (!desktopBridge) return;
      setIsUpdatingWslBackend(true);
      setDesktopWslMutationError(null);
      try {
        await apply();
        refreshDesktopWslState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update WSL backend.";
        setDesktopWslMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change WSL backend",
            description: message,
          }),
        );
        refreshDesktopWslState();
      } finally {
        setIsUpdatingWslBackend(false);
      }
    },
    [desktopBridge],
  );

  const loadWslState = useCallback(() => {
    setDesktopWslMutationError(null);
    refreshDesktopWslState();
  }, []);

  const hasWslRegistrationToLose = useMemo(
    () =>
      environments.some((environment) => isDesktopLocalConnectionTarget(environment.entry.target)),
    [environments],
  );

  const handleSelectWslMode = useCallback(
    (value: string) => {
      if (!desktopBridge || !desktopWslState) return;
      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
      if (value === BACKEND_VALUE_WSL_OFF) {
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
        const wasWslOnly = desktopWslState.wslOnly;
        if (hasWslRegistrationToLose || wasWslOnly) {
          setPendingWslChange({ kind: "disable", wasWslOnly });
          return;
        }
        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
        return;
      }

      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
      const resolvedNext = nextDistro ?? defaultDistroName;
      if (!desktopWslState.enabled) {
        setPendingWslChange({ kind: "enable", nextDistro });
        return;
      }
      const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;
      if (resolvedCurrent === resolvedNext) return;
      if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
        setPendingWslChange({ kind: "distro", nextDistro });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, hasWslRegistrationToLose],
  );

  const handleConfirmEnableWsl = useCallback(
    (mode: "both" | "wsl-only") => {
      if (!desktopBridge || pendingWslChange?.kind !== "enable") return;
      const nextDistro = pendingWslChange.nextDistro;
      setPendingWslChange(null);
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro: desktopWslState?.distro ?? null,
        }),
      );
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, pendingWslChange],
  );

  const handleToggleWslOnly = useCallback(
    (enabled: boolean) => {
      if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
      setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
    },
    [desktopBridge, desktopWslState],
  );

  const handleConfirmWslChange = useCallback(() => {
    if (!desktopBridge || !pendingWslChange || pendingWslChange.kind === "enable") return;
    const change = pendingWslChange;
    setPendingWslChange(null);
    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);
        return change.wasWslOnly ? await desktopBridge.setWslOnly(false) : next;
      });
      return;
    }
    if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
  }, [applyWslSettingChange, desktopBridge, pendingWslChange]);

  const renderWslRow = () => {
    if (!desktopWslState) {
      return desktopWslError && canManageLocalBackend ? (
        <SettingsRow
          title="WSL backend"
          description="Couldn't load the WSL backend state."
          status={<span className="block text-destructive">{desktopWslError}</span>}
          control={
            <Button size="xs" variant="outline" onClick={loadWslState} disabled={isLoadingWslState}>
              {isLoadingWslState ? "Retrying…" : "Retry"}
            </Button>
          }
        />
      ) : null;
    }

    if (!desktopWslState.available) {
      if (!desktopWslState.enabled && !desktopWslState.wslOnly) return null;
      return (
        <SettingsRow
          title="WSL backend"
          description="WSL is no longer available, so the Windows backend is running instead. Switch off the WSL backend to clear this preference."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              Switch to Windows
            </Button>
          }
        />
      );
    }

    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? "Off"
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? "Default distro"
          : selectValue;

    return (
      <>
        <SettingsRow
          title="WSL backend"
          description="Run a second backend inside a WSL distro alongside the Windows one. Pick a distro to start it; pick Off to stop it."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                WSL backend couldn't start: {desktopWslState.preflightError}
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) => {
                if (typeof value === "string") handleSelectWslMode(value);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-56"
                aria-label="WSL backend"
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  Off
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    Default distro
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title="WSL only"
            description="Stop the Windows backend and run only the WSL backend. The desktop app restarts when you change this."
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={handleToggleWslOnly}
                aria-label="Run WSL only"
              />
            }
          />
        ) : null}
      </>
    );
  };

  return (
    <SettingsPageContainer>
      {canManageLocalBackend ? (
        <>
          <SettingsSection title="This environment">
            {primaryVersionMismatch ? (
              <SettingsRow
                title="Version drift"
                description={
                  <span className="flex items-center gap-1 text-warning">
                    <TriangleAlertIcon className="size-3.5 shrink-0" />
                    Client {primaryVersionMismatch.clientVersion}, server{" "}
                    {primaryVersionMismatch.serverVersion}. Sync them if RPC calls or reconnects
                    fail.
                  </span>
                }
              />
            ) : null}
            <SettingsRow title="Local access" description="Limited to this machine." />
            {desktopBridge ? renderWslRow() : null}
          </SettingsSection>

          <SettingsSection
            title="Authorized clients"
            headerAction={
              <AuthorizedClientsHeaderAction
                clientSessions={desktopClientSessions}
                isRevokingOtherClients={isRevokingOtherDesktopClients}
                onRevokeOtherClients={handleRevokeOtherDesktopClients}
              />
            }
          >
            <ScrollArea
              scrollFade
              className="max-h-[22.5rem]"
              data-testid="authorized-clients-scroll-area"
            >
              {desktopAccessManagementError ? (
                <div className={accessRowClassName()}>
                  <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
                </div>
              ) : null}
              <PairingClientsList
                isLoading={isLoadingDesktopAccessManagement}
                pairingLinks={desktopPairingLinks}
                clientSessions={desktopClientSessions}
                revokingPairingLinkId={revokingDesktopPairingLinkId}
                revokingClientSessionId={revokingDesktopClientSessionId}
                onRevokePairingLink={handleRevokeDesktopPairingLink}
                onRevokeClientSession={handleRevokeDesktopClientSession}
              />
            </ScrollArea>
          </SettingsSection>

          <AlertDialog
            open={pendingWslChange !== null}
            onOpenChange={(open) => {
              if (!isUpdatingWslBackend && !open) setPendingWslChange(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? "Turn off WSL and switch back to Windows?"
                      : "Disable WSL backend?"
                    : pendingWslChange?.kind === "distro"
                      ? "Switch WSL distro?"
                      : pendingWslChange?.kind === "enable"
                        ? "Start the WSL backend"
                        : pendingWslChange?.nextValue
                          ? "Run only the WSL backend?"
                          : "Re-enable the Windows backend?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === "enable"
                    ? "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL?"
                    : "This change can interrupt sessions using the affected backend."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  Cancel
                </AlertDialogClose>
                {pendingWslChange?.kind === "enable" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => handleConfirmEnableWsl("wsl-only")}
                      disabled={isUpdatingWslBackend}
                    >
                      Use only WSL
                    </Button>
                    <Button
                      onClick={() => handleConfirmEnableWsl("both")}
                      disabled={isUpdatingWslBackend}
                    >
                      Run both backends
                    </Button>
                  </>
                ) : (
                  <Button onClick={handleConfirmWslChange} disabled={isUpdatingWslBackend}>
                    {isUpdatingWslBackend ? (
                      <>
                        <Spinner className="size-3.5" />
                        Applying…
                      </>
                    ) : (
                      "Confirm"
                    )}
                  </Button>
                )}
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : (
        <SettingsSection title="This environment">
          <SettingsRow
            title="Administrative access"
            description="Pairing links and client-session management require the access:write scope for this backend."
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
