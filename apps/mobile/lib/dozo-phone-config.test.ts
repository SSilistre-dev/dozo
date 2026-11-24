import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

// Runs on the branded tree: what the store builds of the phone tools would ask the system for,
// read from Expo's own introspection of the config (the plugins applied, nothing generated).

type Introspected = {
  ios: { infoPlist: Record<string, unknown> };
  android: { permissions?: string[] };
  _internal: {
    modResults: {
      android: {
        manifest: {
          manifest: {
            $?: Record<string, string | undefined>;
            "uses-permission"?: Array<{ $: Record<string, string | undefined> }>;
            application?: Array<{ service?: Array<{ $: Record<string, string | undefined> }> }>;
          };
        };
      };
    };
  };
};

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("expo/package.json")), "bin/cli");

function introspect(): Introspected {
  const out = execFileSync(process.execPath, [cli, "config", "--type", "introspect", "--json"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, CI: "1", EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Introspected;
}

it("asks for the calendar, reminders, contacts and the location while in use only, with the app's own words", () => {
  const config = introspect();
  const plist = config.ios.infoPlist;
  for (const key of ["NSCalendarsFullAccessUsageDescription", "NSCalendarsUsageDescription"]) {
    expect(plist[key], key).toBe(
      "Bots you allow can read your calendar and add events when you ask them.",
    );
  }
  for (const key of ["NSRemindersFullAccessUsageDescription", "NSRemindersUsageDescription"]) {
    expect(plist[key], key).toBe("Bots you allow can read and add reminders when you ask them.");
  }
  expect(plist.NSContactsUsageDescription).toBe(
    "Bots you allow can look up a contact when you ask them.",
  );
  expect(plist.NSLocationWhenInUseUsageDescription).toBe(
    "Bots you allow can see where you are when you ask them.",
  );
  for (const key of [
    "NSCalendarsWriteOnlyAccessUsageDescription",
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "NSLocationAlwaysUsageDescription",
    "NSLocationUsageDescription",
    "NSLocationTemporaryUsageDescriptionDictionary",
    "NSMotionUsageDescription",
  ]) {
    expect(plist, key).not.toHaveProperty(key);
  }
  expect(plist.UIBackgroundModes).not.toContain("location");

  const uses = (config._internal.modResults.android.manifest.manifest["uses-permission"] ?? []).map(
    (entry) => [entry.$["android:name"], entry.$["tools:node"] ?? "use"],
  );
  const used = uses.filter(([, node]) => node === "use").map(([name]) => name);
  const removed = uses.filter(([, node]) => node === "remove").map(([name]) => name);
  expect(used).toEqual(
    expect.arrayContaining([
      "android.permission.READ_CALENDAR",
      "android.permission.WRITE_CALENDAR",
      "android.permission.READ_CONTACTS",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
    ]),
  );
  for (const name of [
    "android.permission.WRITE_CONTACTS",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
    "android.permission.FOREGROUND_SERVICE_LOCATION",
  ]) {
    expect(used).not.toContain(name);
    expect(removed).toContain(name);
  }
  expect(used).not.toContain("android.permission.FOREGROUND_SERVICE");

  // The location module's library manifest declares two location services the app never starts;
  // the app's manifest removes them from the merged one, so no build carries a location service.
  const manifest = config._internal.modResults.android.manifest.manifest;
  expect(manifest.$?.["xmlns:tools"]).toBe("http://schemas.android.com/tools");
  const services = (manifest.application?.[0]?.service ?? []).map((entry) => [
    entry.$["android:name"],
    entry.$["tools:node"],
  ]);
  expect(services).toEqual(
    expect.arrayContaining([
      ["expo.modules.location.services.LocationTaskService", "remove"],
      ["expo.modules.location.next.locationForegroundService.LocationForegroundService", "remove"],
    ]),
  );
}, 60_000);

it("the plugin replaces the location services with removals and keeps every other service", () => {
  const { withoutLocationServices } = require("../plugins/dozo-without-location-services.js") as {
    withoutLocationServices(manifest: unknown): {
      manifest: { $: Record<string, string>; application: Array<{ service: unknown[] }> };
    };
  };
  const task = "expo.modules.location.services.LocationTaskService";
  const out = withoutLocationServices({
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [
        { service: [{ $: { "android:name": task } }, { $: { "android:name": "app.Other" } }] },
      ],
    },
  });
  expect(out.manifest.$["xmlns:tools"]).toBe("http://schemas.android.com/tools");
  expect(out.manifest.application[0]!.service).toEqual([
    { $: { "android:name": "app.Other" } },
    { $: { "android:name": task, "tools:node": "remove" } },
    {
      $: {
        "android:name":
          "expo.modules.location.next.locationForegroundService.LocationForegroundService",
        "tools:node": "remove",
      },
    },
  ]);
  expect(() => withoutLocationServices({ manifest: { $: {} } })).toThrow("no <application>");
});
