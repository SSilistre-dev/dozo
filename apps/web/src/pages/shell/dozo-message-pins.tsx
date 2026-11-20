import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoMessagePin, ThreadMessage } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Pin, PinOff } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { errorText, toastError } from "../../lib/dozo-error-text";
import { queryClient, useSave, useSpaceQueries } from "../../lib/query";

/** The caller's pins in one chat. Read again on the roster signal a pin change sends. */
function usePins(threadId: string | undefined, enabled = true) {
  const queries = useSpaceQueries();
  const input = { threadId: threadId ?? "" };
  const pins = useQuery({
    ...queries.dozoMessages.pins.queryOptions({ input }),
    enabled: Boolean(threadId) && enabled,
  });
  return { pins: pins.data?.pins, key: queries.dozoMessages.pins.key({ input }) };
}

/** Reads every open chat's pins again; the roster signal carries a pin change. */
export function dozoPinsChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) && path.slice(-2).join(".") === "dozoMessages.pins",
  });
}

/** Pin or Unpin in a message's More menu, once the chat's pins are known. */
export function DozoPinMenuItem({
  message,
  menuOpen,
}: {
  message: ThreadMessage;
  menuOpen: boolean;
}) {
  const { pins, key } = usePins(message.threadId, menuOpen);
  const pinned = pins?.some((pin) => pin.messageId === message.id) ?? false;
  const save = useSave({
    save: (next: boolean, rpc) =>
      rpc.dozoMessages.pin({ threadId: message.threadId, messageId: message.id, pinned: next }),
    stale: [key],
    onFailed: (error) => toastError(errorText(error)),
  });
  if (!pins) return null;
  return (
    <DropdownMenuItem disabled={save.pending} onClick={() => save.run(!pinned)}>
      {pinned ? <PinOff size={14} strokeWidth={1.7} /> : <Pin size={14} strokeWidth={1.7} />}
      {pinned ? <Trans>Unpin</Trans> : <Trans>Pin</Trans>}
    </DropdownMenuItem>
  );
}

/**
 * A pin in the chat header, only while the chat has pinned messages. It lists them, newest first;
 * choosing one opens the chat at that message, as a search result does.
 */
export function DozoPinnedMessages({ threadId }: { threadId: string | undefined }) {
  const { t } = useLingui();
  const { pins } = usePins(threadId);
  const [searchParams, setSearchParams] = useSearchParams();
  if (!pins?.length) return null;
  const open = (messageId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("m", messageId);
    setSearchParams(next);
  };
  return (
    <DropdownMenu>
      <IconTooltip label={t`Pinned`}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="floating"
              size="icon-lg"
              aria-label={t`Pinned`}
              data-testid="dozo-pinned-messages"
              className="app-no-drag"
            />
          }
        >
          <Pin strokeWidth={1.6} className="size-[17px]" />
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent align="end" className="max-h-[min(420px,calc(100vh-96px))] w-72">
        {pins.map((pin) => (
          <DropdownMenuItem key={pin.messageId} onClick={() => open(pin.messageId)}>
            <span className="line-clamp-2 min-w-0 text-body-sm" dir="auto">
              {pinLabel(pin, t`Page`, t`Message`)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function pinLabel({ preview }: DozoMessagePin, page: string, message: string): string {
  return preview.text || preview.attachment?.name || (preview.page ? page : message);
}
