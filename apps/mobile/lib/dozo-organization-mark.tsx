import type { DozoOrganizationMark } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { native, useThemedStyles } from "./native";
import { queryClient, rpcQuery } from "./query";
import { useRosterSignals } from "./roster-signals";

export const organizationMarkRead = () => rpcQuery("dozoOrganizationLogo/mark");

/**
 * The logo of the organization the selected Space belongs to, when it has one. Read again on the
 * roster signal a logo change sends and on each return to the app. Mobile only shows it: the logo
 * is uploaded on the web or desktop app.
 */
export function useDozoOrganizationMark(enabled: boolean): DozoOrganizationMark | undefined {
  const read = organizationMarkRead();
  const mark = useQuery({ ...read, enabled, staleTime: Infinity }, queryClient).data;
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
