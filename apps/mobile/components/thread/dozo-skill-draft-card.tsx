import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { TEACH_SKILL_GONE } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { errorText } from "../../lib/api/user-error";
import { NativeActionButton } from "../native/native-action-button";

type SkillDraft = Extract<MessageBlock, { kind: "skill_draft" }>;

const codeOf = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

/**
 * A skill draft in the chat (taught, or suggested by learning): its name, when it is used and its
 * steps, with Save and Delete. Steps are edited on the web. A draft whose typed values are still
 * to be decided offers only Delete: Save would keep them unseen, and the values are decided where
 * the draft can be edited. A saved one says so; a deleted one is gone.
 */
export function DozoSkillDraftCard({ block }: { block: SkillDraft }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [deleted, setDeleted] = useState(false);
  const draft = block.status === "draft";
  const read = rpcQuery("dozoTeach/review", { skillId: block.skillId });
  // Read once as the card mounts: it is part of a chat, not a screen of its own, and the thread's
  // live update redraws it once the draft is saved.
  const review = useQuery({ ...read, enabled: draft && !deleted }, queryClient);
  const save = useSave<void>({
    save: (_input, send) =>
      send("dozoTeach/save", {
        skillId: block.skillId,
        name: block.name,
        playbook: block.playbook,
      }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  const remove = useSave<void>({
    save: (_input, send) => send("skills/remove", { skillId: block.skillId }),
    onSaved: () => setDeleted(true),
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  if (deleted || codeOf(review.error) === TEACH_SKILL_GONE) return null;
  const decided = review.data && !review.data.values.length && !review.data.targets.length;
  const busy = save.pending || remove.pending;
  const name = block.name;
  return (
    <View style={[styles.card, { backgroundColor: tokens.card }]}>
      <Text style={[styles.name, { color: tokens.foreground }]}>{name}</Text>
      {block.playbook.whenToUse ? (
        <Text style={[styles.line, { color: tokens.mutedForeground }]}>
          {block.playbook.whenToUse}
        </Text>
      ) : null}
      {block.playbook.steps.map((step, index) => (
        <Text key={`${index}:${step}`} style={[styles.line, { color: tokens.foreground }]}>
          {`${index + 1}. ${step}`}
        </Text>
      ))}
      {draft ? (
        <View style={styles.actions}>
          {decided ? (
            <NativeActionButton
              label={t`Save`}
              size="compact"
              busy={save.pending}
              disabled={busy}
              onPress={() => save.run()}
            />
          ) : null}
          <NativeActionButton
            label={t`Delete`}
            prominence="secondary"
            size="compact"
            busy={remove.pending}
            disabled={busy}
            onPress={() =>
              Alert.alert(t`Delete "${name}"?`, t`This can't be undone.`, [
                { text: t`Cancel`, style: "cancel" },
                { text: t`Delete`, style: "destructive", onPress: () => remove.run() },
              ])
            }
          />
        </View>
      ) : (
        <Text style={[styles.line, { color: tokens.mutedForeground }]}>{t`Saved`}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: "90%", borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  name: { ...typeScale.cardTitle },
  line: { ...typeScale.body },
  actions: { flexDirection: "row", gap: 8, marginTop: 6 },
});
