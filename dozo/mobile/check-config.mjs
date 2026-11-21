#!/usr/bin/env node
/**
 * Checks the Expo config that the native iOS project is generated from.
 *
 *   node dozo/mobile/check-config.mjs <expo-config.json> [<api-url>]
 *
 * <expo-config.json> is `expo config --json` of the branded staged tree, or upstream's app.json
 * after the brand rules (`{ "expo": { ... } }`, as check-config.test.mjs passes it). Exit 0 when it
 * carries the Dozo values and nothing of upstream's accounts, 2 with one line per problem.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The old name stays only in these identifiers (dozo/brand/README.md, "Identifiers"). */
const KEPT = ['"scheme":["rakazo","dozo"]', "Rakazo.icon", '"targetName":"RakazoWidgets"'];

/** The application id and iOS bundle id (the `com.rakazo.app` literal rule in brand.json). */
const DOZO_ID = "dev.ssilistre.dozo";

/** Purpose strings the app's own features need, each naming the app (the plugins add the rest). */
const PURPOSE_STRINGS = [
  "NSCameraUsageDescription",
  "NSPhotoLibraryUsageDescription",
  "NSPhotoLibraryAddUsageDescription",
  "NSLocalNetworkUsageDescription",
];

/** Required-reason API reasons: UserDefaults, file timestamps, boot time, disk space. */
const PRIVACY_REASONS = ["CA92.1", "C617.1", "35F9.1", "E174.1"];

/** Upstream's Expo account, EAS project, update channel, bundle ids, domain and GitHub owner. */
const FOREIGN = [
  /inbox-?zero/i,
  /elie222/i,
  /u\.expo\.dev/i,
  /07f7eb04/i,
  /com\.rakazo/i,
  /rakazo\.(?:com|ai|app)/i,
  /apps\.apple\.com/i,
];

/** The problems of one config object; `apiUrl` is the server a build was made for, when known. */
export function problems(input, apiUrl) {
  const config = input.expo ?? input;
  const out = [];
  const want = (ok, text) => ok || out.push(text);
  const id = config.ios?.bundleIdentifier ?? "";
  want(config.name === "Dozo", `name is ${JSON.stringify(config.name)}, not "Dozo"`);
  want(config.slug === "dozo", `slug is ${JSON.stringify(config.slug)}, not "dozo"`);
  want(
    config.owner === undefined,
    `owner is set (${config.owner}): the build belongs to an Expo account`,
  );
  want(
    config.extra?.eas?.projectId === undefined,
    "extra.eas.projectId is set: push tokens and updates use that EAS project",
  );
  want(config.updates?.url === undefined, `updates.url is set (${config.updates?.url})`);
  want(config.updates?.enabled === false, "updates.enabled is not false");
  want(/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(id), `ios.bundleIdentifier is ${JSON.stringify(id)}`);
  want(
    [config.scheme].flat().includes("dozo"),
    `scheme is ${JSON.stringify(config.scheme)}: pairing links (dozo://pair) would not open the app`,
  );
  want(config.android?.package === id, "android.package differs from ios.bundleIdentifier");
  // The id family is the literal in dozo/brand/brand.json; a store app can never change it.
  want(id === DOZO_ID, `ios.bundleIdentifier ${JSON.stringify(id)} is not the Dozo id ${DOZO_ID}`);
  want(
    config.android?.package === DOZO_ID,
    `android.package ${JSON.stringify(config.android?.package)} is not the Dozo id ${DOZO_ID}`,
  );
  // The release build takes the version name from here and sets its own versionCode (README, Release).
  want(
    /^\d+\.\d+\.\d+$/.test(config.version ?? ""),
    `version is ${JSON.stringify(config.version)}`,
  );
  const code = config.android?.versionCode;
  want(Number.isInteger(code) && code > 0, `android.versionCode is ${JSON.stringify(code)}`);
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  want(extensions.length > 0, "no app extensions listed");
  for (const extension of extensions) {
    want(
      extension.bundleIdentifier?.startsWith(`${id}.`),
      `extension ${extension.targetName} has id ${extension.bundleIdentifier}, outside ${id}.*`,
    );
    for (const group of extension.entitlements?.["com.apple.security.application-groups"] ?? []) {
      want(
        group === `group.${id}`,
        `extension ${extension.targetName} uses app group ${group}, not group.${id}`,
      );
    }
  }
  // App Review reads these from the built app; build.sh checks the generated files as well.
  const plist = config.ios?.infoPlist ?? {};
  for (const key of PURPOSE_STRINGS)
    want(/^Dozo /.test(plist[key] ?? ""), `ios.infoPlist.${key} is ${JSON.stringify(plist[key])}`);
  want(
    plist.UIViewControllerBasedStatusBarAppearance === false,
    "ios.infoPlist.UIViewControllerBasedStatusBarAppearance is not false: the status bar ignores the app's theme",
  );
  const secureStore = (config.plugins ?? []).find(
    (plugin) => [plugin].flat()[0] === "expo-secure-store",
  );
  want(
    Array.isArray(secureStore) && secureStore[1]?.faceIDPermission === false,
    "expo-secure-store would add a Face ID purpose string the app never uses",
  );
  const reasons = (config.ios?.privacyManifests?.NSPrivacyAccessedAPITypes ?? []).flatMap(
    (entry) => entry.NSPrivacyAccessedAPITypeReasons ?? [],
  );
  for (const reason of PRIVACY_REASONS)
    want(reasons.includes(reason), `ios.privacyManifests does not declare reason ${reason}`);
  if (apiUrl) {
    const host = new URL(apiUrl).hostname;
    for (const domain of config.ios?.associatedDomains ?? []) {
      want(
        domain.split(":")[1]?.split("?")[0] === host,
        `associated domain ${domain} is not the server ${host}`,
      );
    }
  }
  let text = JSON.stringify(config);
  for (const re of FOREIGN) want(!re.test(text), `the config holds ${re.source}`);
  for (const kept of KEPT) text = text.split(kept).join("");
  const left = text.match(/.{0,30}rakazo.{0,30}/gi) ?? [];
  for (const hit of left) out.push(`the old name outside the kept identifiers: ${hit}`);
  return out;
}

// Run as a script, whatever the path looks like (a symlinked checkout, a space in a directory name):
// a guard that misses would make the check pass without looking.
const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [file, apiUrl] = process.argv.slice(2);
  if (!file) {
    console.error("usage: check-config.mjs <expo-config.json> [<api-url>]");
    process.exit(2);
  }
  let found;
  try {
    found = problems(JSON.parse(fs.readFileSync(file, "utf8")), apiUrl);
  } catch (error) {
    found = [`cannot read ${file}: ${error.message}`];
  }
  for (const line of found) console.error(`[mobile] config: ${line}`);
  if (found.length) process.exit(2);
  console.log(
    "[mobile] config: Dozo values, no upstream account, project, update channel or domain",
  );
}
