import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
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
import { useSave, useSpaceQueries } from "../../lib/query";

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
  const regenerate = useSave({
    save: (_input, rpc) => rpc.dozoMessages.regenerate({ threadId, messageId: message.id }),
    stale,
    onFailed: (error) => toastError(errorText(error)),
  });
  const edit = useSave({
    save: (text: string, rpc) => rpc.dozoMessages.edit({ threadId, messageId: message.id, text }),
    stale,
    onSaved: () => setDraft(null),
  });
  const named = revisable.data;
  const earlierEdit = named?.earlierEditMessageIds?.includes(message.id) ?? false;
  const earlierRegenerate = named?.earlierRegenerateMessageIds?.includes(message.id) ?? false;
  const canEdit = named?.editMessageId === message.id || earlierEdit;
  const canRegenerate = named?.regenerateMessageId === message.id || earlierRegenerate;
  const count = named?.removedCounts?.[message.id] ?? 0;
  const startEdit = () => setDraft(messageText(message));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.trim()) return;
    if (earlierEdit) setConfirming("edit");
    else edit.run(draft.trim());
  };

  const items = (
    <>
      {canEdit ? (
        <DropdownMenuItem onClick={startEdit}>
          <Pencil size={14} strokeWidth={1.7} />
          <Trans>Edit</Trans>
        </DropdownMenuItem>
      ) : null}
      {canRegenerate ? (
        <DropdownMenuItem
          disabled={regenerate.pending}
          onClick={earlierRegenerate ? () => setConfirming("regenerate") : () => regenerate.run()}
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
          if (confirming === "regenerate") regenerate.run();
          else if (draft?.trim()) edit.run(draft.trim());
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
            {edit.error ? (
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

function messageText(message: ThreadMessage): string {
  return message.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
}
