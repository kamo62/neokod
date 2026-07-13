import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { DesktopWslState } from "@neokod/contracts";

import { applyWslEnableSelection } from "./ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

type PendingWslChange =
  | { readonly kind: "disable"; readonly wasWslOnly: boolean }
  | { readonly kind: "distro"; readonly nextDistro: string | null }
  | { readonly kind: "enable"; readonly nextDistro: string | null }
  | { readonly kind: "wsl-only"; readonly nextValue: boolean };

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(
    primaryEnvironment?.serverConfig ?? null,
  );
  const desktopWsl = useEnvironmentQuery(desktopBridge ? desktopWslStateAtom : null);
  const desktopWslState = desktopWsl.data;
  const [isUpdating, setIsUpdating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingWslChange | null>(null);
  const desktopWslError = mutationError ?? desktopWsl.error;

  const hasWslRegistrationToLose = useMemo(
    () => environments.some(({ entry }) => isDesktopLocalConnectionTarget(entry.target)),
    [environments],
  );

  const applyWslSettingChange = useCallback(
    async (apply: () => Promise<DesktopWslState>) => {
      if (!desktopBridge) return;
      setIsUpdating(true);
      setMutationError(null);
      try {
        await apply();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update WSL backend.";
        setMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change WSL backend",
            description: message,
          }),
        );
      } finally {
        refreshDesktopWslState();
        setIsUpdating(false);
      }
    },
    [desktopBridge],
  );

  const handleSelectWslMode = useCallback(
    (value: string) => {
      if (!desktopBridge || !desktopWslState) return;
      const defaultDistro =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
      if (value === BACKEND_VALUE_WSL_OFF) {
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
        if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
          setPendingChange({ kind: "disable", wasWslOnly: desktopWslState.wslOnly });
          return;
        }
        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
        return;
      }
      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
      if (!desktopWslState.enabled) {
        setPendingChange({ kind: "enable", nextDistro });
        return;
      }
      if ((desktopWslState.distro ?? defaultDistro) === (nextDistro ?? defaultDistro)) return;
      if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
        setPendingChange({ kind: "distro", nextDistro });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, hasWslRegistrationToLose],
  );

  const confirmEnable = useCallback(
    (mode: "both" | "wsl-only") => {
      if (!desktopBridge || pendingChange?.kind !== "enable") return;
      const nextDistro = pendingChange.nextDistro;
      setPendingChange(null);
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro: desktopWslState?.distro ?? null,
        }),
      );
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, pendingChange],
  );

  const confirmChange = useCallback(() => {
    if (!desktopBridge || pendingChange === null || pendingChange.kind === "enable") return;
    const change = pendingChange;
    setPendingChange(null);
    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);
        return change.wasWslOnly ? desktopBridge.setWslOnly(false) : next;
      });
    } else if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
    } else {
      void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
    }
  }, [applyWslSettingChange, desktopBridge, pendingChange]);

  const renderWslRow = () => {
    if (!desktopWslState) {
      return desktopWslError ? (
        <SettingsRow
          title="WSL backend"
          description="Couldn't load the WSL backend state."
          status={<span className="block text-destructive">{desktopWslError}</span>}
          control={
            <Button size="xs" variant="outline" onClick={refreshDesktopWslState}>
              Retry
            </Button>
          }
        />
      ) : null;
    }
    if (!desktopWslState.available) {
      return desktopWslState.enabled || desktopWslState.wslOnly ? (
        <SettingsRow
          title="WSL backend"
          description="WSL is unavailable, so the Windows backend is running instead."
          control={
            <Button
              variant="outline"
              disabled={isUpdating}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              Switch to Windows
            </Button>
          }
        />
      ) : null;
    }

    const defaultDistro = desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const value = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistro ?? BACKEND_VALUE_DEFAULT_WSL);
    return (
      <>
        <SettingsRow
          title="WSL backend"
          description="Run a bearer-protected backend inside a WSL distro."
          status={
            desktopWslError || desktopWslState.preflightError ? (
              <span className="block text-destructive">
                {desktopWslError ?? `WSL backend couldn't start: ${desktopWslState.preflightError}`}
              </span>
            ) : null
          }
          control={
            <Select value={value} onValueChange={(next) => handleSelectWslMode(String(next))}>
              <SelectTrigger className="w-full sm:w-56" disabled={isUpdating}>
                <SelectValue />
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
            description="Stop the Windows backend and run only the WSL backend."
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdating}
                onCheckedChange={(nextValue) => setPendingChange({ kind: "wsl-only", nextValue })}
              />
            }
          />
        ) : null}
      </>
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="This environment">
        {primaryVersionMismatch ? (
          <SettingsRow
            title="Version drift"
            description={
              <span className="flex items-center gap-1 text-warning">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                Client {primaryVersionMismatch.clientVersion}, server{" "}
                {primaryVersionMismatch.serverVersion}.
              </span>
            }
          />
        ) : null}
        <SettingsRow
          title="Local access"
          description="Loopback access is direct and limited to this machine."
        />
        {desktopBridge ? renderWslRow() : null}
      </SettingsSection>

      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!isUpdating && !open) setPendingChange(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Change WSL backend?</AlertDialogTitle>
            <AlertDialogDescription>
              This change can interrupt sessions using the affected backend.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isUpdating} />}>
              Cancel
            </AlertDialogClose>
            {pendingChange?.kind === "enable" ? (
              <>
                <Button variant="outline" onClick={() => confirmEnable("wsl-only")}>
                  Use only WSL
                </Button>
                <Button onClick={() => confirmEnable("both")}>Run both backends</Button>
              </>
            ) : (
              <Button onClick={confirmChange} disabled={isUpdating}>
                {isUpdating ? (
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
    </SettingsPageContainer>
  );
}
