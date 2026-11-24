import { useLingui } from "@lingui/react/macro";
import { isAppearancePreference } from "@rakazo/ui-tokens";
import { DOZO_THEMES, dozoTheme } from "@rakazo/ui-tokens/dozo-themes";
import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { getCachedAppearancePreference, setAppearancePreference } from "../lib/appearance";
import type { DozoBubble } from "../lib/dozo-theme";
import { getDozoBubble, getDozoTheme, subscribeDozoTheme } from "../lib/dozo-theme";
import { setDozoBubble, setDozoTheme } from "../lib/dozo-theme-store";
import { useThemedStyles } from "../lib/native";
import { createSettingsPageStyles } from "../lib/settings-page-styles";
import { MenuPicker } from "./menu-picker";
import { NativeSegmentedControl } from "./native-segmented-control";
import { SettingsGroup, SettingsLabel } from "./settings-group";

/**
 * General settings' Appearance as the web has it: System, Light, Dark and the six named themes in
 * one native menu, and under it Message color. Both are kept on this device. A named theme shows
 * as chosen only beside its own tone; any other stored name reads as the plain choice.
 */
export function DozoAppearanceSetting() {
  const { t } = useLingui();
  const styles = useThemedStyles(createSettingsPageStyles);
  // Every pick below ends by marking the theme, which is what tells this row to read again.
  const preference = useSyncExternalStore(subscribeDozoTheme, getCachedAppearancePreference);
  const theme = useSyncExternalStore(subscribeDozoTheme, getDozoTheme);
  const bubble = useSyncExternalStore(subscribeDozoTheme, getDozoBubble);
  const current = theme && theme.tone === preference ? theme.id : preference;

  function pick(key: string) {
    const named = dozoTheme(key);
    if (named) {
      void setAppearancePreference(named.tone);
      setDozoTheme(named.id);
    } else if (isAppearancePreference(key)) {
      void setAppearancePreference(key);
      setDozoTheme(null);
    }
  }

  return (
    <>
      <View accessibilityLabel={t`Appearance`} style={styles.section}>
        <SettingsLabel>{t`Appearance`}</SettingsLabel>
        <SettingsGroup>
          <MenuPicker
            choices={[
              { key: "system", label: t`System` },
              { key: "light", label: t`Light` },
              { key: "dark", label: t`Dark` },
              ...DOZO_THEMES.map(({ id, label }) => ({ key: id, label })),
            ]}
            label={t`Appearance`}
            onChange={pick}
            showLabel={false}
            value={current}
          />
        </SettingsGroup>
      </View>
      <View accessibilityLabel={t`Message color`} style={styles.section}>
        <SettingsLabel>{t`Message color`}</SettingsLabel>
        <NativeSegmentedControl
          accessibilityLabel={t`Message color`}
          onChange={(next: DozoBubble) => setDozoBubble(next)}
          options={[
            { value: "bot", label: t`Bot color` },
            { value: "neutral", label: t`Neutral` },
          ]}
          value={bubble}
        />
      </View>
    </>
  );
}
