import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { DOZO_ACCESS_TOKEN_DAYS } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIdentityConfirmation } from "../../components/confirm-identity";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../../components/settings-group";
import { revokeTitle, tokenDates } from "../../lib/dozo-access-tokens";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type NewToken = {
  name: string;
  botId?: string;
  expiresInDays: typeof DOZO_ACCESS_TOKEN_DAYS | null;
};

/**
 * The member's personal access tokens for the bot API in this Space, as the web app's Settings
 * lists them: revoke one after asking, or make one (after confirming it is them). The new token
 * is shown once and held in this screen's state only, never in the cache.
 */
export default function DozoAccessTokens() {
  const { t } = useLingui();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  useScreenHeader({ title: t`Access tokens` });
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.screen}
      >
        <ScrollView
          style={sideInsets}
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
        >
          {made ? (
            <MadeToken token={made} onDone={() => setMade(null)} />
          ) : creating ? (
            <CreateToken
              onCancel={() => setCreating(false)}
              onCreated={(token) => {
                setCreating(false);
                setMade(token);
              }}
            />
          ) : (
            <Tokens onNew={() => setCreating(true)} />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Tokens({ onNew }: { onNew: () => void }) {
  const { t } = useLingui();
  const locale = dateLocaleForUi(useUiLocale());
  const colorScheme = useResolvedAppearance();
  const read = rpcQuery("dozoAccessTokens/list");
  const tokens = useQuery({ ...read, refetchOnMount: "always" }, queryClient);
  const revoke = useSave({
    save: (id: string, send) => send("dozoAccessTokens/revoke", { id }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(t`Could not revoke token`, errorText(error, t`Try again.`)),
  });
  const ask = (id: string, name: string) =>
    Alert.alert(revokeTitle(name), undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Revoke`, style: "destructive", onPress: () => revoke.run(id) },
    ]);
  return (
    <>
      <SettingsGroup>
        {tokens.data?.map((token) => {
          const dates = tokenDates(token, locale);
          return (
            <MenuView
              key={token.id}
              title={token.name}
              actions={[{ id: "revoke", title: t`Revoke`, attributes: { destructive: true } }]}
              colorScheme={colorScheme}
              onPressAction={() => ask(token.id, token.name)}
            >
              <SettingsRow
                accessible
                accessibilityRole="button"
                accessibilityActions={[{ name: "revoke", label: t`Revoke` }]}
                onAccessibilityAction={() => ask(token.id, token.name)}
                dimmed={revoke.pending}
                title={token.name}
                detail={[`…${token.hint}`, token.botName, dates.used, dates.ends]
                  .filter(Boolean)
                  .join(", ")}
              />
            </MenuView>
          );
        })}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow accessibilityRole="button" tinted title={t`New token`} onPress={onNew} />
      </SettingsGroup>
    </>
  );
}

function CreateToken({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (token: string) => void;
}) {
  const { t } = useLingui();
  const bots = useQuery(rpcQuery("bots/list"), queryClient).data;
  const [name, setName] = useState("");
  const [botId, setBotId] = useState("");
  const [lasting, setLasting] = useState(false);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const read = rpcQuery("dozoAccessTokens/list");
  const create = useSave({
    // Making a token asks the person to confirm it is them, as revealing a secret does.
    save: (input: NewToken, send) =>
      withIdentityConfirmation(() => send("dozoAccessTokens/create", input)),
    stale: [read.queryKey],
    onSaved: (created) => onCreated(created.token),
    onFailed: (error) => Alert.alert(t`Could not create token`, errorText(error, t`Try again.`)),
  });
  const bot = bots?.find((entry) => entry.id === botId);
  const expires = lasting ? t`Never expires` : t`Expires in 90 days`;
  return (
    <>
      <SettingsGroup>
        <SettingsInputRow
          accessibilityLabel={t`Name`}
          autoCapitalize="sentences"
          editable={!create.pending}
          maxLength={60}
          onChangeText={setName}
          placeholder={t`Name`}
          value={name}
        />
        <MenuPickerMenu
          label={t`Bot`}
          choices={[
            { key: "", label: t`All bots` },
            ...(bots ?? []).map((entry) => ({ key: entry.id, label: entry.name })),
          ]}
          value={botId}
          onChange={setBotId}
          disabled={create.pending}
        >
          <SettingsRow
            accessible
            accessibilityRole="button"
            title={t`Bot`}
            value={bot?.name ?? t`All bots`}
          />
        </MenuPickerMenu>
        <MenuPickerMenu
          label={t`Expires`}
          choices={[
            { key: "90", label: t`Expires in 90 days` },
            { key: "never", label: t`Never expires` },
          ]}
          value={lasting ? "never" : "90"}
          onChange={(key) => setLasting(key === "never")}
          disabled={create.pending}
        >
          <SettingsRow accessible accessibilityRole="button" title={t`Expires`} value={expires} />
        </MenuPickerMenu>
      </SettingsGroup>
      {identityDialog}
      <NativeActionButton
        busy={create.pending}
        disabled={!name.trim()}
        label={t`Create`}
        onPress={() =>
          create.run({
            name: name.trim(),
            ...(botId ? { botId } : {}),
            expiresInDays: lasting ? null : DOZO_ACCESS_TOKEN_DAYS,
          })
        }
      />
      <NativeActionButton
        disabled={create.pending}
        label={t`Cancel`}
        prominence="secondary"
        variant="text"
        onPress={onCancel}
      />
    </>
  );
}

function MadeToken({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Text selectable style={styles.token}>
        {token}
      </Text>
      <NativeActionButton
        label={copied ? t`Copied` : t`Copy token`}
        prominence="secondary"
        onPress={() => void Clipboard.setStringAsync(token).then(() => setCopied(true))}
      />
      <Text style={styles.note}>{t`Copy it now. It won't be shown again.`}</Text>
      <NativeActionButton label={t`Done`} onPress={onDone} />
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 16, paddingBottom: 40 },
    token: {
      color: native.label,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 15,
    },
    note: { color: native.secondaryLabel, fontSize: 14 },
  });
}
