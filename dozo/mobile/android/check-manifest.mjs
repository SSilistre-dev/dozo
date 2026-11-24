#!/usr/bin/env node
/**
 * Checks the manifest of a built APK for what the app must never carry.
 *
 *   aapt2 dump xmltree --file AndroidManifest.xml <app.apk> > manifest.txt
 *   node dozo/mobile/android/check-manifest.mjs manifest.txt
 *
 * The input is that dump (a plain AndroidManifest.xml reads the same). The app reads the phone's
 * contacts, calendar and location once while it is open, and adds calendar events the user approves
 * (WRITE_CALENDAR, asked for only when that switch is turned on), so its merged manifest must hold
 * neither of the location module's background services (removed by
 * apps/mobile/plugins/dozo-without-location-services.js) nor a permission to write contacts or to
 * read the location in the background. Exit 0 when it holds none, 2 with one line per problem.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The services the plugin removes, as expo-location's library manifest declares them. */
export const LOCATION_SERVICES = [
  "expo.modules.location.services.LocationTaskService",
  "expo.modules.location.next.locationForegroundService.LocationForegroundService",
];
export const FORBIDDEN_PERMISSIONS = [
  "android.permission.WRITE_CONTACTS",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.FOREGROUND_SERVICE_LOCATION",
];

/** Every android:name in the dump (`…android:name(0x01010003)="x"`) or in plain XML. */
function names(text) {
  return [...text.matchAll(/(?:android:name\(0x01010003\)=|android:name=)"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/** What the manifest holds that it must not; throws when the text is no manifest at all. */
export function problems(text) {
  const found = names(text);
  if (!/\bmanifest\b/.test(text) || !found.length)
    throw new Error("the input is not an Android manifest");
  const services = LOCATION_SERVICES.map((name) => name.slice(name.lastIndexOf(".")));
  return [
    ...new Set(
      found.flatMap((name) =>
        FORBIDDEN_PERMISSIONS.includes(name)
          ? [`permission ${name}`]
          : services.some((suffix) => name.endsWith(suffix))
            ? [`service ${name}`]
            : [],
      ),
    ),
  ];
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  try {
    const [file] = process.argv.slice(2);
    if (!file) throw new Error("usage: check-manifest.mjs <manifest dump>");
    const found = problems(fs.readFileSync(file, "utf8"));
    for (const problem of found) console.error(`[mobile] the APK's manifest holds ${problem}`);
    if (found.length) process.exit(2);
    console.log("[mobile] the APK's manifest holds no location service or forbidden permission");
  } catch (error) {
    console.error(`[mobile] check-manifest: ${error.message}`);
    process.exit(2);
  }
}
