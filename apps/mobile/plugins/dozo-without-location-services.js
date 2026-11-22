// The location module's library manifest declares two services that start location updates in the
// background. The app reads one location while it is in use and never starts them, so the app's
// manifest removes both from the merged one: no build carries a location service.
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const SERVICES = [
  "expo.modules.location.services.LocationTaskService",
  "expo.modules.location.next.locationForegroundService.LocationForegroundService",
];

function withoutLocationServices(manifest) {
  const app = manifest.manifest.application?.[0];
  if (!app) throw new Error("dozo-without-location-services: the manifest has no <application>.");
  AndroidConfig.Manifest.ensureToolsAvailable(manifest);
  const kept = (app.service ?? []).filter((entry) => !SERVICES.includes(entry.$["android:name"]));
  app.service = [
    ...kept,
    ...SERVICES.map((name) => ({ $: { "android:name": name, "tools:node": "remove" } })),
  ];
  return manifest;
}

module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    cfg.modResults = withoutLocationServices(cfg.modResults);
    return cfg;
  });
module.exports.withoutLocationServices = withoutLocationServices;
