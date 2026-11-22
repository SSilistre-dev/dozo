import { PermissionsAndroid } from "react-native";
import type { ReadPermission } from "./dozo-phone-read-permission";

// The calendar module asks for writing as well, which the app never declares, so it would never
// be granted: reading is asked for on its own.
export const readPermission: ReadPermission | null = {
  check: () => PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CALENDAR),
  request: async () =>
    (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_CALENDAR)) ===
    PermissionsAndroid.RESULTS.GRANTED,
};
