import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@neokod/contracts";
import { memo, useMemo, useState, type ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ModelEsque } from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * Combined model + provider-options composer control. Wraps the same
 * `ModelPickerContent` that `ProviderModelPicker` uses (unchanged, reused
 * as-is) behind a single trigger whose label summarizes both the selected
 * model and its primary trait (e.g. "GPT-5.4 · High"), and presents the
 * provider-options control (`traitsFooter`, typically a rendered
 * `TraitsPicker`) as an adjacent section below the model list. Neither the
 * model nor the traits selection state is forked here — both remain owned
 * by `ProviderModelPicker`/`TraitsPicker`'s existing derivation.
 */
export const ComposerModelTraitsControl = memo(function ComposerModelTraitsControl(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Combined "Model · Trait" summary, derived by ComposerModelTraitsControl.logic.ts. */
  summaryLabel: string;
  /** Pre-rendered provider-options control (e.g. from renderProviderTraitsPicker), or null when the provider has no options for this model. */
  traitsFooter?: ReactNode;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-model-traits-control="true"
            className={cn(
              "min-w-0 justify-between whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className={showInstanceBadge ? "size-5" : "size-4"}
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              indicatorBackground="var(--input)"
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3",
                "px-0.5 text-[7px]",
              )}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {props.summaryLabel}
            </TooltipTrigger>
            <TooltipPopup side="top">{props.summaryLabel}</TooltipPopup>
          </Tooltip>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ChevronDownIcon aria-hidden="true" className="!ms-0 !-me-1 size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0]"
        viewportClassName="!overflow-hidden p-0"
      >
        <div className="flex w-full max-w-100 flex-col gap-1.5">
          <ModelPickerContent
            activeInstanceId={activeInstanceId}
            model={props.model}
            lockedProvider={props.lockedProvider}
            lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
            instanceEntries={props.instanceEntries}
            {...(props.keybindings ? { keybindings: props.keybindings } : {})}
            modelOptionsByInstance={props.modelOptionsByInstance}
            terminalOpen={props.terminalOpen ?? false}
            onRequestClose={() => setIsMenuOpen(false)}
            {...(props.getModelDisabledReason
              ? { getModelDisabledReason: props.getModelDisabledReason }
              : {})}
            onInstanceModelChange={handleInstanceModelChange}
          />
          {props.traitsFooter ? (
            <div
              data-chat-model-traits-control-footer="true"
              className="flex items-center justify-between gap-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-lg/5"
            >
              <span className="font-medium text-muted-foreground text-xs">Provider options</span>
              {props.traitsFooter}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
