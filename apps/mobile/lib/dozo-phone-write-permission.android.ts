import { PermissionsAndroid } from "react-native";
import type { ReadPermission } from "./dozo-phone-read-permission";

const { READ_CALENDAR, WRITE_CALENDAR } = PermissionsAndroid.PERMISSIONS;

// Adding an event: asked for only by its own switch. The calendar module writes only with reading
// allowed as well, so both are asked for together; the read switch still asks for reading alone.
export const writePermission: ReadPermission | null = {
  check: async () =>
    (await PermissionsAndroid.check(READ_CALENDAR)) &&
    (await PermissionsAndroid.check(WRITE_CALENDAR)),
  request: async () => {
    const answers = await PermissionsAndroid.requestMultiple([READ_CALENDAR, WRITE_CALENDAR]);
    return [READ_CALENDAR, WRITE_CALENDAR].every(
      (name) => answers[name] === PermissionsAndroid.RESULTS.GRANTED,
    );
  },
};
