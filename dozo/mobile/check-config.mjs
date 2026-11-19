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
const KEPT = ['"scheme":"rakazo"', "Rakazo.icon", '"targetName":"RakazoWidgets"'];

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
  want(config.android?.package === id, "android.package differs from ios.bundleIdentifier");
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
