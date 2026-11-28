import { useLingui } from "@lingui/react/macro";
import type { BotAvatarSet, MessageBlock } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { FALLBACK_BOT_COLOR } from "./chat/chat-shared";

type PeerBot = { name?: string; color: string; avatarSet?: BotAvatarSet };

/**
 * A handoff in a one-to-one chat: the other bot, as a button to its chat, and the handoff note.
 * In the handing bot's chat the arrow leads to the next bot; in the next bot's chat it leads away
 * from the bot that handed it over.
 */
export function DozoHandoffMarkerView({
  block,
  botId,
  peerBot,
  onOpenBot,
}: {
  block: Extract<MessageBlock, { kind: "handoff" }>;
  /** The bot that wrote the message, which is the chat's own bot. */
  botId: string | undefined;
  peerBot: (botId: string) => PeerBot | undefined;
  onOpenBot: (botId: string) => void;
}) {
  const { t } = useLingui();
  const incoming = botId === block.toBotId;
  const peerId = incoming ? block.fromBotId : block.toBotId;
  const peer = peerBot(peerId);
  const arrow = <span aria-hidden="true">↪</span>;
  return (
    <div className="flex flex-col items-center gap-1 py-1 text-body text-muted-foreground">
      <button
        type="button"
        disabled={!peer?.name}
        aria-label={peer?.name ? t`Open chat with ${peer.name}` : undefined}
        onClick={() => onOpenBot(peerId)}
        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-body-sm transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {incoming ? null : arrow}
        <BotAvatar
          avatarSet={peer?.avatarSet}
          color={peer?.color ?? FALLBACK_BOT_COLOR}
          identity={peerId}
          size={16}
        />
        {peer?.name ? (
          <span dir="auto" className="truncate font-medium">
            {peer.name}
          </span>
        ) : null}
        {incoming ? arrow : null}
      </button>
      <span dir="auto" className="whitespace-pre-wrap text-center">
        {block.text}
      </span>
    </div>
  );
}
