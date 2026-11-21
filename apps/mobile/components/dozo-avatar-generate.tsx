import { useLingui } from "@lingui/react/macro";
import { DOZO_AVATAR_GENERATE_ERRORS, DOZO_AVATAR_PROMPT_MAX_CHARS } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { BotAvatar } from "./bot-avatar";
import { GrowingTextInput } from "./growing-text-input";
import { NativeActionButton } from "./native-action-button";

/**
 * Draws a bot's avatar from a few words, in the avatar sheet: description, Generate, then the
 * picture with Use and Try again. Nothing shows unless the server can draw one for this person.
 * Use hands the picture to the sheet as its draft; the screen's Save stores it like any photo.
 * Leaving the sheet drops the answer. The request itself cannot be cancelled, because a save's
 * `send` carries no abort signal.
 */
export function DozoAvatarGenerate({ onUse }: { onUse: (image: string) => void }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const status = useQuery(
    { ...rpcQuery("dozoAvatarGenerate/status"), refetchOnMount: "always" },
    queryClient,
  );
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const generate = useSave({
    save: (description: string, send) =>
      send("dozoAvatarGenerate/generate", { prompt: description }),
    onSaved: (result) => setImage(result.image),
  });
  if (status.data?.available !== true) return null;
  const description = prompt.trim();
  // Another picture is already being drawn for this person: this one goes back to waiting.
  const failure =
    generate.error &&
    (generate.error as { code?: unknown }).code !== DOZO_AVATAR_GENERATE_ERRORS.busy
      ? generate.error
      : null;
  const run = () => {
    if (description) generate.run(description);
  };
  return (
    <View style={{ gap: 12 }}>
      <GrowingTextInput
        label={t`Describe the avatar`}
        value={prompt}
        maxLength={DOZO_AVATAR_PROMPT_MAX_CHARS}
        editable={!generate.pending}
        onChangeText={setPrompt}
        placeholder={t`Describe the avatar`}
        fontSize={17}
      />
      {image ? (
        <View style={{ alignItems: "center", gap: 12 }}>
          <BotAvatar color={image} size={72} />
          <NativeActionButton label={t`Use`} onPress={() => onUse(image)} />
          <NativeActionButton
            label={t`Try again`}
            prominence="secondary"
            busy={generate.pending}
            disabled={!description}
            onPress={run}
          />
        </View>
      ) : (
        <NativeActionButton
          label={t`Generate`}
          busy={generate.pending}
          disabled={!description}
          onPress={run}
        />
      )}
      {failure ? <Text style={{ color: tokens.destructive }}>{errorText(failure)}</Text> : null}
    </View>
  );
}
