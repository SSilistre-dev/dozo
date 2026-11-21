import { useLingui } from "@lingui/react/macro";
import { DOZO_AVATAR_PROMPT_MAX_CHARS } from "@rakazo/contracts";
import { useState } from "react";
import { Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { errorText } from "../lib/user-error";
import { BotAvatar } from "./bot-avatar";
import { GrowingTextInput } from "./growing-text-input";
import { NativeActionButton } from "./native-action-button";

/**
 * Draws a bot's avatar from a few words, in the avatar sheet: description, Generate, then the
 * picture with Use and Try again. Nothing shows unless the server can draw one for this person; the
 * status is read when the sheet opens and again after each picture, so the day's last picture can
 * still be used but no more are offered. Use hands the picture to the sheet as its draft; the
 * screen's Save stores it like any photo. Leaving the sheet drops the answer. The request itself
 * cannot be cancelled, because a save's `send` carries no abort signal.
 */
export function DozoAvatarGenerate({ onUse }: { onUse: (image: string) => void }) {
  const status = useScreenQuery(rpcQuery("dozoAvatarGenerate/status"));
  return <Generator available={status.data?.available === true} onUse={onUse} />;
}

function Generator({ available, onUse }: { available: boolean; onUse: (image: string) => void }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const statusKey = rpcQuery("dozoAvatarGenerate/status").queryKey;
  const generate = useSave({
    save: (description: string, send) =>
      send("dozoAvatarGenerate/generate", { prompt: description }),
    stale: [statusKey],
    onSaved: (result) => setImage(result.image),
    // A refusal (the allowance is used up, no plan) changes what is on offer as much as a picture does.
    onFailed: () => void queryClient.invalidateQueries({ queryKey: statusKey }),
  });
  const description = prompt.trim();
  const run = () => {
    if (description) generate.run(description);
  };
  if (!available && !image && !generate.error) return null;
  return (
    <View style={{ gap: 12 }}>
      {available ? (
        <GrowingTextInput
          label={t`Describe the avatar`}
          value={prompt}
          maxLength={DOZO_AVATAR_PROMPT_MAX_CHARS}
          editable={!generate.pending}
          onChangeText={setPrompt}
          placeholder={t`Describe the avatar`}
          fontSize={17}
        />
      ) : null}
      {image ? (
        <View style={{ alignItems: "center", gap: 12 }}>
          <BotAvatar color={image} size={72} />
          <NativeActionButton label={t`Use`} onPress={() => onUse(image)} />
          {available ? (
            <NativeActionButton
              label={t`Try again`}
              prominence="secondary"
              busy={generate.pending}
              disabled={!description}
              onPress={run}
            />
          ) : null}
        </View>
      ) : available ? (
        <NativeActionButton
          label={t`Generate`}
          busy={generate.pending}
          disabled={!description}
          onPress={run}
        />
      ) : null}
      {generate.error ? (
        <Text style={{ color: tokens.destructive }}>{errorText(generate.error)}</Text>
      ) : null}
    </View>
  );
}
