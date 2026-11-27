import type { AppIcon } from "@rakazo/contracts";
import { DEFAULT_APP_ICON } from "@rakazo/contracts";
import { Redirect } from "expo-router";

/**
 * The alternate app icons are all the Dozo icon until accessory drawings exist, so the picker
 * would show identical choices. This read says the device cannot switch icons, which keeps the
 * settings row away, and the route sends a direct link back to General.
 */
export const appIconRead = {
  queryKey: ["device", "app-icon"] as const,
  queryFn: async (): Promise<{ supported: boolean; icon: AppIcon }> => ({
    supported: false,
    icon: DEFAULT_APP_ICON,
  }),
};

export function AppIconRoute() {
  return <Redirect href="/general" />;
}
