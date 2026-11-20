import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { useChatExport } from "../lib/dozo-chat-export";
import { useDozoChatPins } from "../lib/dozo-message-actions";
import { NativeActionButton } from "./native-action-button";

/** Group settings' Export, and Pinned while the group's chat has pinned messages. */
export function DozoGroupChatActions({ groupId, name }: { groupId: string; name: string }) {
  const { t } = useLingui();
  const router = useRouter();
  const exportChat = useChatExport();
  const { threadId, pins } = useDozoChatPins({ groupId });
  return (
    <>
      <NativeActionButton
        label={t`Export`}
        onPress={() => exportChat({ groupId }, name)}
        style={{ marginTop: 16 }}
      />
      {threadId && pins?.length ? (
        <NativeActionButton
          label={t`Pinned`}
          onPress={() =>
            router.push({ pathname: "/dozo-pins", params: { threadId, groupId, name } })
          }
          style={{ marginTop: 16 }}
        />
      ) : null}
    </>
  );
}
