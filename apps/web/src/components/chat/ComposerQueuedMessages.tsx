import { CornerDownRightIcon, XIcon } from "lucide-react";
import type { QueuedComposerMessage } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerQueuedMessagesProps {
  messages: ReadonlyArray<QueuedComposerMessage>;
  /**
   * Steer is only offered while a turn is running and the composer itself is
   * empty. Promoting a queued item swaps it into the live prompt for the
   * length of the send, so anything the user is mid-typing has to be out of
   * the way first.
   */
  canSteer: boolean;
  onRemove: (queuedMessageId: string) => void;
  onSteer: (queuedMessageId: string) => void;
  className?: string;
}

/**
 * Compact, oldest-first list of follow-ups submitted while a turn was
 * running. Each row can be removed, or (when `canSteer`) promoted to send
 * immediately into the running turn instead of waiting for it to finish.
 */
export function ComposerQueuedMessages({
  messages,
  canSteer,
  onRemove,
  onSteer,
  className,
}: ComposerQueuedMessagesProps) {
  if (messages.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-0.5", className)} data-chat-composer-queue="true">
      {messages.map((message) => (
        <div
          key={message.id}
          className="group flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1"
          title={message.text}
        >
          <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground">
            {message.text}
          </span>
          {canSteer ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onSteer(message.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Send now into the running turn"
                  >
                    <CornerDownRightIcon className="size-3" aria-hidden />
                    Steer
                  </button>
                }
              />
              <TooltipPopup side="top">Send now into the running turn</TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
            onClick={() => onRemove(message.id)}
            aria-label="Remove queued message"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}
