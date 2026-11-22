import type { DozoOrganizationMark } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { native, useThemedStyles } from "./native";
import { queryClient, rpcQuery } from "./query";
import { useRosterSignals } from "./roster-signals";
import { useScreenQuery } from "./screen-query";

export const organizationMarkRead = () => rpcQuery("dozoOrganizationLogo/mark");

/**
 * The logo of the organization the selected Space belongs to, when it has one: the home screen's
 * read, again on focus and on each return to the app, and on the roster signal a change sends. Mobile only shows it: the logo
 * is uploaded on the web or desktop app.
 */
export function useDozoOrganizationMark(enabled: boolean): DozoOrganizationMark | undefined {
  const read = organizationMarkRead();
  const mark = useScreenQuery(read, { enabled }).data;
  useRosterSignals(() => queryClient.invalidateQueries({ queryKey: read.queryKey }), enabled);
  return mark?.logo ? mark : undefined;
}

/** The home header's title: the logo before the organization menu, or either alone. */
export function dozoHomeTitle(
  mark: DozoOrganizationMark | undefined,
  menu: (() => ReactNode) | undefined,
): (() => ReactNode) | undefined {
  const logo = mark?.logo;
  if (!mark || !logo) return menu;
  return () => <OrganizationTitle name={mark.name} logo={logo} menu={menu} />;
}

function OrganizationTitle({
  name,
  logo,
  menu,
}: {
  name: string;
  logo: string;
  menu: (() => ReactNode) | undefined;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.title} testID="organization-mark">
      <Image source={{ uri: logo }} accessible accessibilityLabel={name} style={styles.logo} />
      {menu?.()}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    title: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
    logo: {
      width: 24,
      height: 24,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.separator,
    },
  });
}
