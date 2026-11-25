import { useLingui } from "@lingui/react/macro";
import type { DozoBotChat } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import { errorText } from "../../lib/dozo-error-text";
import { useSave } from "../../lib/query/query";
import { useListKey } from "./dozo-bot-chats";

/** Renames one of a bot's extra chats; loaded when someone asks to rename (dozo-bot-chats.tsx). */
export function RenameChatDialog({ chat, onClose }: { chat: DozoBotChat; onClose: () => void }) {
  const { t } = useLingui();
  const nameId = useId();
  const listKey = useListKey();
  const [name, setName] = useState(chat.name);
  const trimmed = name.trim();
  const rename = useSave({
    save: (value: string, client) => client.dozoChats.rename({ chatId: chat.id, name: value }),
    stale: [listKey],
    onSaved: onClose,
  });
  return (
    <Dialog open onOpenChange={(next) => (next || rename.pending ? undefined : onClose())}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && trimmed !== chat.name) rename.run(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t`Rename`}</DialogTitle>
          </DialogHeader>
          <label htmlFor={nameId} className="block text-body text-foreground/75">
            {t`Name`}
            <Input
              id={nameId}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
              autoFocus
            />
          </label>
          {rename.error ? (
            <p className="text-body text-destructive">
              {errorText(rename.error, t`Something went wrong. Try again.`)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={rename.pending} onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={rename.pending || !trimmed || trimmed === chat.name}>
              {rename.pending ? t`Saving…` : t`Save`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
