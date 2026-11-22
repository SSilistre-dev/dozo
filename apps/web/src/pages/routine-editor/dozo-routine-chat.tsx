import { Trans, useLingui } from "@lingui/react/macro";
import { NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query";

/**
 * Which of the bot's chats a saved routine posts in. Shown only once the bot has an open extra
 * chat (or the routine already posts in one); otherwise every routine posts in the main chat and
 * there is nothing to pick. A change is saved at once, as it is no part of the routine's draft.
 */
export function DozoRoutineChat({
  bot,
  routineId,
  fieldId,
}: {
  bot: { id: string; name: string };
  routineId: string;
  fieldId: string;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const chats = useQuery(queries.dozoChats.list.queryOptions({ input: { botId: bot.id } }));
  const target = useQuery(queries.dozoChats.routineChat.queryOptions({ input: { routineId } }));
  const save = useSave<string | null>({
    save: (chatId, rpc) => rpc.dozoChats.setRoutineChat({ routineId, chatId }),
    stale: [queries.dozoChats.routineChat.key({ input: { routineId } })],
    onFailed: (error) => toastError(t`Something went wrong. Try again.`, error),
  });
  const open = (chats.data?.chats ?? []).filter((chat) => chat.archivedAt === null);
  if (!target.data?.editable || (open.length === 0 && target.data.chatId === null)) return null;
  const chatId = save.pending ? (save.input ?? null) : target.data.chatId;
  return (
    <label htmlFor={`${fieldId}-chat`} className="mt-5 block text-body text-muted-foreground">
      <Trans>Chat</Trans>
      <NativeSelect
        id={`${fieldId}-chat`}
        className="mt-2 w-full"
        value={chatId ?? ""}
        disabled={save.pending}
        onChange={(event) => save.run(event.target.value || null)}
      >
        <NativeSelectOption value="">{bot.name}</NativeSelectOption>
        {open.map((chat) => (
          <NativeSelectOption key={chat.id} value={chat.id}>
            {chat.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
}
