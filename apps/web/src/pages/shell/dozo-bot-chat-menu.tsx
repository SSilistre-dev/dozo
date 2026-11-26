import { useLingui } from "@lingui/react/macro";
import type { DozoBotChat } from "@rakazo/contracts";
import type { SnoozePreset } from "@rakazo/core";
import { SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@rakazo/ui-web";
import { Archive, Bell, BellDot, Clock, Pencil } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toastError } from "../../lib/dozo-error-text";
import { useSave } from "../../lib/query/query";
import { rpc as selectedSpaceRpc } from "../../lib/query/rpc";
import { useListKey } from "./dozo-bot-chats";
import { DozoChatExportMenu } from "./dozo-chat-export-menu";

type ChatAction =
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "snooze"; until: string }
  | { kind: "archive" };

/** A bot chat's right-click menu; loaded when one is opened (dozo-bot-chats.tsx). */
export function DozoBotChatMenu({
  chat,
  selected,
  onRename,
}: {
  chat: DozoBotChat;
  selected: boolean;
  onRename: () => void;
}) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const listKey = useListKey();
  const target = { chatBotId: chat.botId, chatId: chat.id };
  const presetLabels: Record<SnoozePreset, string> = {
    hour: t`1 hour`,
    threeHours: t`3 hours`,
    tomorrow: t`Tomorrow`,
    nextWeek: t`Next week`,
  };
  const change = useSave<ChatAction, unknown>({
    save: async (action, client) => {
      if (action.kind === "read") return client.threads.markRead(target);
      if (action.kind === "unread") return client.threads.markUnread(target);
      if (action.kind === "snooze")
        return client.threads.snooze({ ...target, until: action.until });
      return client.dozoChats.archive({ chatId: chat.id, archived: true });
    },
    stale: [listKey],
    onSaved: (_, action) => {
      if (action.kind === "archive" && selected) navigate(`/app/${chat.botId}`);
    },
    onFailed: (error) => toastError(t`Something went wrong. Try again.`, error),
  });
  const now = new Date();
  return (
    <ContextMenuContent aria-label={t`Actions for ${chat.name}`} className="w-[240px]">
      <ContextMenuItem onClick={onRename}>
        <Pencil />
        {t`Rename`}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => change.run({ kind: chat.unread ? "read" : "unread" })}>
        {chat.unread ? <BellDot /> : <Bell />}
        {chat.unread ? t`Mark as Read` : t`Mark as Unread`}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Clock />
          {t`Snooze`}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-[200px]">
          {SNOOZE_PRESETS.map((preset) => {
            const wake = snoozePresetTime(preset, now);
            return (
              <ContextMenuItem
                key={preset}
                onClick={() => change.run({ kind: "snooze", until: wake.toISOString() })}
              >
                {presetLabels[preset]}
                <span className="ms-auto text-label text-muted-foreground">
                  {i18n.date(wake, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                </span>
              </ContextMenuItem>
            );
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <DozoChatExportMenu
        rpc={selectedSpaceRpc}
        target={target}
        name={chat.name}
        onClose={() => {}}
      />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => change.run({ kind: "archive" })}>
        <Archive />
        {t`Archive`}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
