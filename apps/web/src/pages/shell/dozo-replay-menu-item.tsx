import { Trans } from "@lingui/react/macro";
import { DropdownMenuItem } from "@rakazo/ui-web";
import { Clapperboard } from "lucide-react";
import { useParams } from "react-router-dom";
import { openDozoSurface } from "../dozo-surfaces";
import type { DozoMessageMenuItemProps } from "./dozo-message-extensions";

/**
 * Share replay on a bot's reply that took steps, in that bot's own chat (never a group's). The
 * server decides the rest: only the bot's owner, for a finished reply to their own message.
 */
export function DozoReplayMenuItem({ message }: DozoMessageMenuItemProps) {
  const { botId } = useParams();
  if (
    message.role !== "bot" ||
    !message.runId ||
    !botId ||
    message.botId !== botId ||
    !message.blocks.some((block) => block.kind === "steps")
  )
    return null;
  return (
    <DropdownMenuItem onClick={() => openDozoSurface("replay", { messageId: message.id })}>
      <Clapperboard size={14} strokeWidth={1.7} />
      <Trans>Share replay</Trans>
    </DropdownMenuItem>
  );
}
