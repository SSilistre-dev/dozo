import { useLingui } from "@lingui/react/macro";
import type { DozoLearningMode } from "@rakazo/contracts";
import { Alert } from "react-native";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { errorText } from "../lib/api/user-error";
import { MenuPicker } from "./ui/menu-picker";
import { SettingsGroup } from "./settings/settings-group";

/**
 * Under the bot's memory, for its owner only: how it learns from their chat, the same three modes
 * as the web, in a native menu. Offered only while nobody else is in the Space; nothing when the
 * server has no such setting or it cannot be read.
 */
export function DozoLearningSetting({
  botId,
  ownerId,
}: {
  botId: string;
  ownerId?: string | null;
}) {
  const { t } = useLingui();
  const me = useScreenQuery(rpcQuery("me")).data;
  const owner = Boolean(ownerId) && me?.userId === ownerId;
  const read = rpcQuery("dozoLearning/get", { botId });
  const learning = useScreenQuery(read, { enabled: owner }).data;
  const mode = useSave({
    save: (next: DozoLearningMode, send) => send("dozoLearning/setMode", { botId, mode: next }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  if (!owner || !learning?.available) return null;
  return (
    <SettingsGroup>
      <MenuPicker
        label={t`Learn from chats`}
        choices={[
          { key: "off", label: t`Off` },
          // The catalog's existing string, under its explicit id.
          { key: "ask", label: t({ id: "Ask first", message: "Ask first" }) },
          { key: "auto", label: t`Auto` },
        ]}
        value={mode.pending && mode.input ? mode.input : learning.mode}
        disabled={mode.pending}
        onChange={(key) => mode.run(key as DozoLearningMode)}
      />
    </SettingsGroup>
  );
}
