import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { DozoMessagePin, MessageAuthor } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { Alert } from "react-native";
import { blockPerson } from "./dozo-blocked-people";
import type { MobileMessage } from "./mobile-types";
import { queryClient, rpcQuery, useSave } from "./query";
import { useRosterSignals } from "./roster-signals";
import { errorText } from "./user-error";

/**
 * Edit, Regenerate, Pin, Report and Block in a message's menu. The server names the messages Edit
 * and Regenerate apply to; the iOS menu is built before it opens, so the chat keeps that answer
 * current (`useDozoThreadMenus`) and each message only reads it. An earlier message removes every
 * later one, so it is confirmed first.
 */
export type DozoMessageAction = {
  name: "dozoEdit" | "dozoRegenerate" | "dozoPin" | "dozoReport" | "dozoBlock";
  text: string;
  /** SF Symbol for the iOS menu. */
  symbol:
    | "pencil"
    | "arrow.clockwise"
    | "pin"
    | "pin.slash"
    | "exclamationmark.bubble"
    | "hand.raised";
  /** Ionicons name for the Android menu. */
  icon:
    | "create-outline"
    | "refresh-outline"
    | "pin-outline"
    | "pin"
    | "flag-outline"
    | "hand-left-outline";
  onPress: () => void;
};

export const revisableRead = (threadId: string) => rpcQuery("dozoMessages/revisable", { threadId });
export const pinsRead = (threadId: string) => rpcQuery("dozoMessages/pins", { threadId });

/** The chat's pins, newest first; read again on the roster signal a pin change sends. */
export function useDozoPins(threadId: string | undefined): DozoMessagePin[] | undefined {
  const read = pinsRead(threadId ?? "");
  const pins = useQuery({ ...read, enabled: Boolean(threadId), staleTime: Infinity }, queryClient);
  useRosterSignals(
    () => queryClient.invalidateQueries({ queryKey: read.queryKey }),
    Boolean(threadId),
  );
  return pins.data?.pins;
}

/** A bot's or a group's chat and its pins, for the entries that open the pinned list. */
export function useDozoChatPins(target: { botId: string } | { groupId: string }) {
  const botId = "botId" in target ? target.botId : "";
  const groupId = "groupId" in target ? target.groupId : "";
  const bot = useQuery(
    { ...rpcQuery("bots/get", { botId }), enabled: Boolean(botId) },
    queryClient,
  ).data;
  const groups = useQuery(
    { ...rpcQuery("groups/list"), enabled: Boolean(groupId) },
    queryClient,
  ).data;
  const threadId = botId ? bot?.threadId : groups?.find((group) => group.id === groupId)?.threadId;
  return { threadId, pins: useDozoPins(threadId) };
}

/** A pin's line in the pinned list: its text, else its file, else what kind of message it is. */
export function pinLabel({ preview }: DozoMessagePin, page: string, message: string): string {
  return preview.text || preview.attachment?.name || (preview.page ? page : message);
}

/**
 * Going back to an earlier message removes the later ones: the person says so first, told how
 * many go.
 */
export function confirmRemoval(
  t: ReturnType<typeof useLingui>["t"],
  count: number,
  act: () => void,
): void {
  Alert.alert(
    t`${plural(count, { one: "Remove # message?", other: "Remove # messages?" })}`,
    undefined,
    [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Remove`, style: "destructive", onPress: act },
    ],
  );
}

/** How many messages changing this one removes when it is an earlier one, else null. */
function earlierRemoves(
  revisable: DozoRevisable | undefined,
  kind: "edit" | "regenerate",
  messageId: string,
): number | null {
  const ids =
    kind === "edit" ? revisable?.earlierEditMessageIds : revisable?.earlierRegenerateMessageIds;
  return ids?.includes(messageId) ? (revisable?.removedCounts?.[messageId] ?? 0) : null;
}

// The edit screen takes the text from here rather than from its route, which would carry it.
const editDrafts = new Map<string, EditDraft>();

/** The text Edit opens with, and how many later messages sending it removes (null: none). */
export type EditDraft = { text: string; removes: number | null };

/**
 * How Edit opens its screen, set by the chat's module (`dozo-thread-menus.ts`) so a message row
 * never loads the router itself.
 */
let openEdit: ((threadId: string, messageId: string) => void) | null = null;

export function setDozoEditOpener(open: (threadId: string, messageId: string) => void): void {
  openEdit = open;
}

/** How Report opens the feedback form, set the same way as Edit's opener. */
let openReport: ((threadId: string, messageId: string) => void) | null = null;

export function setDozoReportOpener(open: (threadId: string, messageId: string) => void): void {
  openReport = open;
}

/** What the edit screen opens with, once. */
export function takeEditDraft(messageId: string): EditDraft {
  const draft = editDrafts.get(messageId) ?? { text: "", removes: null };
  editDrafts.delete(messageId);
  return draft;
}

function messageText(message: MobileMessage): string {
  return message.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * What this message's menu adds: Edit, Regenerate, then Pin or Unpin, as the server allows, and
 * Report on a message someone else wrote (a bot's reply, another member's message) while the
 * server takes feedback, and Block on another member's message.
 */
export function useDozoMessageActions(
  message: MobileMessage,
  readOnly: boolean,
  inGroup: boolean,
  /** Another person wrote it, in a shared chat. */
  otherAuthor?: MessageAuthor,
): DozoMessageAction[] {
  const { t } = useLingui();
  const threadId = message.threadId ?? "";
  const messageId = message.id;
  const reportable = message.role !== "user" || Boolean(otherAuthor);
  const sent = Boolean(threadId) && !messageId.startsWith("progress:");
  const revisable = useQuery(
    {
      ...revisableRead(threadId),
      enabled: sent && !readOnly && !inGroup,
      staleTime: Infinity,
    },
    queryClient,
  ).data;
  const pins = useQuery({ ...pinsRead(threadId), enabled: sent, staleTime: Infinity }, queryClient)
    .data?.pins;
  const feedback = useQuery(
    { ...rpcQuery("dozoFeedback/status"), enabled: sent && reportable, staleTime: Infinity },
    queryClient,
  ).data;
  const failed = (error: Error) => Alert.alert(errorText(error, t`Try again.`));
  const regenerate = useSave({
    save: (_, send) => send("dozoMessages/regenerate", { threadId, messageId }),
    stale: [revisableRead(threadId).queryKey],
    onFailed: failed,
  });
  const pin = useSave({
    save: (pinned: boolean, send) => send("dozoMessages/pin", { threadId, messageId, pinned }),
    stale: [pinsRead(threadId).queryKey],
    onFailed: failed,
  });
  const editRemoves = sent ? earlierRemoves(revisable, "edit", messageId) : null;
  const regenerateRemoves = sent ? earlierRemoves(revisable, "regenerate", messageId) : null;
  const canEdit = editRemoves !== null || (sent && revisable?.editMessageId === messageId);
  const canRegenerate =
    regenerateRemoves !== null || (sent && revisable?.regenerateMessageId === messageId);
  const pinned = pins?.some((entry) => entry.messageId === messageId) ?? false;
  const showPin = sent && pins !== undefined;
  const showReport = sent && reportable && Boolean(feedback?.mode);
  // The menu keeps its entries while only a save's state changes; a press runs the latest save.
  const saves = useRef({ regenerate, pin });
  saves.current = { regenerate, pin };
  const text = canEdit ? messageText(message) : "";
  return useMemo(() => {
    const actions: DozoMessageAction[] = [];
    if (canEdit)
      actions.push({
        name: "dozoEdit",
        text: t`Edit`,
        symbol: "pencil",
        icon: "create-outline",
        onPress: () => {
          editDrafts.set(messageId, { text, removes: editRemoves });
          openEdit?.(threadId, messageId);
        },
      });
    if (canRegenerate)
      actions.push({
        name: "dozoRegenerate",
        text: t`Regenerate`,
        symbol: "arrow.clockwise",
        icon: "refresh-outline",
        onPress: () => {
          const run = () => saves.current.regenerate.run();
          if (regenerateRemoves === null) run();
          else confirmRemoval(t, regenerateRemoves, run);
        },
      });
    if (showPin)
      actions.push({
        name: "dozoPin",
        text: pinned ? t`Unpin` : t`Pin`,
        symbol: pinned ? "pin.slash" : "pin",
        icon: pinned ? "pin" : "pin-outline",
        onPress: () => saves.current.pin.run(!pinned),
      });
    if (showReport)
      actions.push({
        name: "dozoReport",
        text: t`Report`,
        symbol: "exclamationmark.bubble",
        icon: "flag-outline",
        onPress: () => openReport?.(threadId, messageId),
      });
    if (sent && otherAuthor)
      actions.push({
        name: "dozoBlock",
        text: t`Block`,
        symbol: "hand.raised",
        icon: "hand-left-outline",
        // Asked first; the alert says it holds on this phone only.
        onPress: () =>
          Alert.alert(
            t`Block ${ph({ name: otherAuthor.name })}?`,
            t`Their messages are hidden on this phone.`,
            [
              { text: t`Cancel`, style: "cancel" },
              {
                text: t`Block`,
                style: "destructive",
                onPress: () => blockPerson(otherAuthor.id, threadId),
              },
            ],
          ),
      });
    return actions;
  }, [
    canEdit,
    canRegenerate,
    editRemoves,
    regenerateRemoves,
    showPin,
    pinned,
    showReport,
    otherAuthor,
    text,
    threadId,
    messageId,
    t,
  ]);
}

/** The iOS menu's section for these actions, after upstream's. */
export function dozoMenuEntries(actions: readonly DozoMessageAction[]) {
  if (actions.length === 0) return [];
  return [
    {
      id: "dozo",
      title: "",
      displayInline: true,
      subactions: actions.map((action) => ({
        id: action.name,
        title: action.text,
        image: action.symbol,
      })),
    },
  ];
}

/** The Android menu's group for these actions, after upstream's. */
export function dozoSheetGroups(actions: readonly DozoMessageAction[]) {
  return actions.length === 0 ? [] : [actions.map((action) => ({ ...action }))];
}
