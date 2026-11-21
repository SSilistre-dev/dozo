#!/usr/bin/env node
/**
 * Prepares the generated Android project (`expo prebuild`) for a store-signed release build.
 *
 *   node dozo/mobile/android/release-gradle.mjs <android/app/build.gradle> <versionName> <versionCode>
 *
 * The generated app/build.gradle signs the release variant with its debug key. This sets the
 * version and points the release variant at a signing config that reads the keystore from the
 * environment (DOZO_ANDROID_KEYSTORE, DOZO_ANDROID_KEYSTORE_PASSWORD, DOZO_ANDROID_KEY_ALIAS,
 * DOZO_ANDROID_KEY_PASSWORD) when Gradle runs, so no secret is written into the project. The file is
 * the generated one, never one in the repository. A template that no longer looks as expected is an
 * error (exit 2): a build must not fall back to the debug key unnoticed.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SIGNING = `        release {
            storeFile file(System.getenv("DOZO_ANDROID_KEYSTORE"))
            storePassword System.getenv("DOZO_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("DOZO_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("DOZO_ANDROID_KEY_PASSWORD")
        }
`;

/** The build.gradle text with the version set and the release variant signed by the release config. */
export function releaseGradle(text, versionName, versionCode) {
  if (!/^\d+\.\d+\.\d+$/.test(versionName))
    throw new Error(`versionName ${versionName} is not x.y.z`);
  if (!/^[1-9]\d{0,9}$/.test(String(versionCode)) || Number(versionCode) > 2100000000)
    throw new Error(`versionCode ${versionCode} is not an integer between 1 and 2100000000`);
  const once = (re, replace, what) => {
    if ((text.match(new RegExp(re.source, "g")) ?? []).length !== 1)
      throw new Error(`build.gradle has no single ${what}`);
    text = text.replace(re, replace);
  };
  once(/versionCode \d+/, `versionCode ${versionCode}`, "versionCode");
  once(/versionName "[^"]*"/, `versionName "${versionName}"`, "versionName");
  once(/signingConfigs \{\n/, (head) => head + SIGNING, "signingConfigs block");
  // The first signingConfig after `release {` inside buildTypes is the release variant's.
  const release = /(buildTypes \{[\s\S]*?\brelease \{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!release.test(text))
    throw new Error("build.gradle has no release buildType signed with the debug key");
  return text.replace(release, "$1signingConfig signingConfigs.release");
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [file, versionName, versionCode] = process.argv.slice(2);
  try {
    if (!file || !versionName || !versionCode)
      throw new Error("usage: release-gradle.mjs <build.gradle> <versionName> <versionCode>");
    fs.writeFileSync(file, releaseGradle(fs.readFileSync(file, "utf8"), versionName, versionCode));
    console.log(`[mobile] release signing config set, version ${versionName} (${versionCode})`);
  } catch (error) {
    console.error(`[mobile] release-gradle: ${error.message}`);
    process.exit(2);
  }
}
