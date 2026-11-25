import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoRevisable, DozoRevisionConfirmed, ThreadMessage } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenuItem,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Pencil, RotateCcw } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { errorText, toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorCode } from "../../../../../packages/i18n/src/user-error";

/**
 * Edit for the caller's messages and Regenerate for the bot's replies, in the message's More menu.
 * The server names the messages each applies to, read while the menu is open, so a message it does
 * not name offers neither. An earlier one removes every later message, so the change asks first,
 * naming how many go.
 * The chat updates from the thread's own events.
 */
export function useDozoMessageRevision(message: ThreadMessage, menuOpen: boolean) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"edit" | "regenerate" | null>(null);
  const threadId = message.threadId;
  const input = { threadId };
  const revisable = useQuery({
    ...queries.dozoMessages.revisable.queryOptions({ input }),
    enabled: menuOpen && !message.id.startsWith("progress:"),
    staleTime: 0,
  });
  const stale = [queries.dozoMessages.revisable.key({ input })];
  const messageId = message.id;
  /**
   * After a refusal the chat may have changed since the confirm (a turn arrived and finished):
   * read again and, when the message can still change, ask again with what would go now.
   */
  const askAgain = async (kind: "edit" | "regenerate", error: Error) => {
    if (errorCode(error) !== "MESSAGE_NOT_REVISABLE") return false;
    const fresh = (await revisable.refetch()).data;
    if (!fresh || !named(fresh, kind, messageId)) return false;
    setConfirming(kind);
    return true;
  };
  const regenerate = useSave({
    save: (confirmed: DozoRevisionConfirmed | undefined, rpc) =>
      rpc.dozoMessages.regenerate({ threadId, messageId, confirmed }),
    stale,
    onFailed: (error) =>
      void askAgain("regenerate", error).then((asked) => {
        if (!asked) toastError(errorText(error));
      }),
  });
  const edit = useSave({
    save: (change: { text: string; confirmed?: DozoRevisionConfirmed }, rpc) =>
      rpc.dozoMessages.edit({ threadId, messageId, ...change }),
    stale,
    onSaved: () => setDraft(null),
    onFailed: (error) => void askAgain("edit", error),
  });
  const latest = revisable.data;
  // What the person confirms goes, sent back so the server refuses anything more.
  const confirmed: DozoRevisionConfirmed | undefined = latest?.removedCounts
    ? {
        removes: latest.removedCounts[messageId] ?? 0,
        lastMessageId: latest.lastMessageId ?? null,
      }
    : undefined;
  const earlierEdit = latest?.earlierEditMessageIds?.includes(messageId) ?? false;
  const earlierRegenerate = latest?.earlierRegenerateMessageIds?.includes(messageId) ?? false;
  const canEdit = latest !== undefined && named(latest, "edit", messageId);
  const canRegenerate = latest !== undefined && named(latest, "regenerate", messageId);
  const count = confirmed?.removes ?? 0;
  const startEdit = () => setDraft(messageText(message));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.trim()) return;
    if (earlierEdit) setConfirming("edit");
    else edit.run({ text: draft.trim(), confirmed });
  };

  // A reply a backup wrote names it, quietly, where the message's own actions are.
  const model = latest?.backupReplies?.[messageId];

  const items = (
    <>
      {model ? (
        <div className="px-2 py-1.5 text-body-sm text-muted-foreground">
          <Trans>Answered by {model}</Trans>
        </div>
      ) : null}
      {canEdit ? (
        <DropdownMenuItem onClick={startEdit}>
          <Pencil size={14} strokeWidth={1.7} />
          <Trans>Edit</Trans>
        </DropdownMenuItem>
      ) : null}
      {canRegenerate ? (
        <DropdownMenuItem
          disabled={regenerate.pending}
          onClick={
            earlierRegenerate ? () => setConfirming("regenerate") : () => regenerate.run(confirmed)
          }
        >
          <RotateCcw size={14} strokeWidth={1.7} />
          <Trans>Regenerate</Trans>
        </DropdownMenuItem>
      ) : null}
    </>
  );

  const confirm =
    confirming === null ? null : (
      <ConfirmDialog
        onCancel={() => setConfirming(null)}
        title={t`${plural(count, { one: "Remove # message?", other: "Remove # messages?" })}`}
        confirmLabel={<Trans>Remove</Trans>}
        onConfirm={() => {
          setConfirming(null);
          if (confirming === "regenerate") regenerate.run(confirmed);
          else if (draft?.trim()) edit.run({ text: draft.trim(), confirmed });
        }}
      />
    );

  const editor =
    draft === null ? null : (
      <Dialog
        open
        // Only Edit opens it, so a change of state here is always a close.
        onOpenChange={() => setDraft(null)}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogTitle className="sr-only">
            <Trans>Edit</Trans>
          </DialogTitle>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Textarea
              aria-label={t`Edit`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={4}
              autoFocus
            />
            {edit.error && confirming === null ? (
              <div role="alert" className="text-body-sm text-destructive">
                {errorText(edit.error)}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" disabled={edit.pending || !draft.trim()}>
                <Trans>Send</Trans>
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    );

  return {
    items,
    dialog: (
      <>
        {editor}
        {confirm}
      </>
    ),
  };
}

/** Whether the server names this message for this change, as the newest or an earlier one. */
function named(revisable: DozoRevisable, kind: "edit" | "regenerate", messageId: string) {
  return kind === "edit"
    ? revisable.editMessageId === messageId ||
        (revisable.earlierEditMessageIds?.includes(messageId) ?? false)
    : revisable.regenerateMessageId === messageId ||
        (revisable.earlierRegenerateMessageIds?.includes(messageId) ?? false);
}

function messageText(message: ThreadMessage): string {
  return message.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
}
