#!/usr/bin/env node
// Adds the fork's own dependencies (dozo/deps/mobile.json) to a staged tree: the importer's
// package.json gets them and pnpm writes the staged lockfile, so every frozen install that follows
// (the unit gate, the images, the iOS build) installs them. The working tree is never touched.
// The new lockfile must hold every upstream entry unchanged; the only additions allowed are the
// listed packages in the importer and new package entries, each listed with the integrity pnpm
// resolved. A result is cached per input, so a later stage of the same input needs no network.
// Usage: node apply.mjs --root <staged tree> --cache <dir> [--list <file>]
// Exit 0 ok (or nothing listed), 2 failed, 64 usage.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "mobile.json");

/** "name@version" to its parts; the name may be scoped. */
export function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) throw new Error(`not name@version: ${spec}`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** Reads and checks the list's shape. Throws with the reason. */
export function readList(text) {
  const list = JSON.parse(text);
  if (typeof list.importer !== "string" || !list.importer || list.importer.includes(".."))
    throw new Error("importer must be a workspace directory such as apps/mobile");
  if (!Array.isArray(list.add)) throw new Error("add must be an array of name@version");
  if (!list.integrity || typeof list.integrity !== "object")
    throw new Error("integrity must be an object");
  for (const spec of list.add) {
    const { version } = splitSpec(spec);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${spec}: give an exact version`);
  }
  for (const [spec, sum] of Object.entries(list.integrity)) {
    splitSpec(spec);
    if (typeof sum !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(sum))
      throw new Error(`${spec}: integrity must be a sha512 value`);
  }
  return list;
}

/** The importer's package.json with the listed dependencies added. Throws when upstream already
 * pins one of them to another version: the fork never changes what upstream locked. */
export function editManifest(text, add) {
  const manifest = JSON.parse(text);
  manifest.dependencies ??= {};
  for (const spec of add) {
    const { name, version } = splitSpec(spec);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const have = manifest[field]?.[name];
      if (have !== undefined && have !== version)
        throw new Error(`upstream already has ${name}@${have} in ${field}`);
    }
    manifest.dependencies[name] = version;
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const unquote = (key) => key.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
/** A packages or snapshots key ("'@a/b@1.2.3(peer@4)'") to "@a/b@1.2.3". */
export const packageId = (key) => unquote(key).replace(/\(.*$/, "");

/**
 * A pnpm lockfile as blocks: every top-level key of every YAML document, and inside importers,
 * packages and snapshots every entry, keyed "doc|top|entry". Blank lines are not part of a block.
 */
export function lockBlocks(text) {
  const blocks = new Map();
  let doc = 0;
  let top = null;
  let key = null;
  for (const line of text.split("\n")) {
    if (line === "---") {
      doc++;
      top = key = null;
      continue;
    }
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      top = line.replace(/:.*$/, "");
      key = `${doc}|${top}|`;
    } else if (/^ {2}\S/.test(line) && ["importers", "packages", "snapshots"].includes(top)) {
      key = `${doc}|${top}|${unquote(/^ {2}('[^']*'|"[^"]*"|[^:]+):/.exec(line)?.[1] ?? line.trim())}`;
    }
    if (key === null) throw new Error(`lockfile line outside any key: ${line}`);
    blocks.set(key, `${blocks.get(key) ?? ""}${line}\n`);
  }
  return blocks;
}

const parts = (key) => {
  const [doc, top, ...rest] = key.split("|");
  return { doc, top, entry: rest.join("|") };
};

/** An importer block as "group/name" -> "specifier -> version", the version without its peer context. */
export function importerDeps(text) {
  const deps = new Map();
  let group = null;
  let name = null;
  for (const line of (text ?? "").split("\n")) {
    const indent = /^ */.exec(line)[0].length;
    const field = /^ *('[^']*'|"[^"]*"|[^:]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    if (indent === 4) group = field[1];
    else if (indent === 6) name = `${group}/${unquote(field[1])}`;
    else if (indent === 8 && name) {
      const value = field[2].replace(/\(.*$/, "");
      const have = deps.get(name) ?? { specifier: "", version: "" };
      deps.set(name, { ...have, [field[1]]: value });
    }
  }
  return new Map(
    [...deps].map(([key, { specifier, version }]) => [key, `${specifier} -> ${version}`]),
  );
}

const integrityOf = (text) => /integrity: ([^,}\s]+)/.exec(text)?.[1] ?? null;

/**
 * Everything wrong with `after` as the lockfile of `before` plus the list. Empty means fine.
 * What must not change is what gets installed: every top-level setting, every importer's locked
 * versions, and every upstream package with its integrity. pnpm may recompute an entry's peer
 * context or registry metadata (such as a deprecation note) when it rewrites the file; that changes
 * no version and no tarball, so it is allowed. New packages must be listed, with their integrity.
 */
export function lockProblems(before, after, list) {
  const problems = [];
  const old = lockBlocks(before);
  const now = lockBlocks(after);
  const added = new Map(list.add.map((spec) => [splitSpec(spec).name, splitSpec(spec).version]));
  const ids = (blocks, top) =>
    new Map(
      [...blocks]
        .filter(([key]) => parts(key).top === top)
        .map(([key, text]) => [packageId(parts(key).entry), text]),
    );
  for (const [key, text] of old) {
    const { top, entry } = parts(key);
    if (["importers", "packages", "snapshots"].includes(top) && entry) continue;
    if (now.get(key) !== text) problems.push(`upstream lockfile setting changed: ${top}`);
  }
  for (const [key] of now) {
    const { top, entry } = parts(key);
    if (!old.has(key) && !(["importers", "packages", "snapshots"].includes(top) && entry))
      problems.push(`new lockfile setting: ${top}`);
  }
  const importers = (blocks) =>
    new Map(
      [...blocks]
        .filter(([key]) => parts(key).top === "importers" && parts(key).entry)
        .map(([key, text]) => [parts(key).entry, importerDeps(text)]),
    );
  const oldImporters = importers(old);
  const nowImporters = importers(now);
  if (!oldImporters.has(list.importer))
    problems.push(`the lockfile has no importer ${list.importer}`);
  for (const importer of nowImporters.keys())
    if (!oldImporters.has(importer)) problems.push(`new importer: ${importer}`);
  for (const [importer, deps] of oldImporters) {
    const current = nowImporters.get(importer) ?? new Map();
    for (const [dep, locked] of deps)
      if (current.get(dep) !== locked)
        problems.push(`${importer}: ${dep} was ${locked}, now ${current.get(dep) ?? "gone"}`);
    for (const [dep, locked] of current) {
      if (deps.has(dep)) continue;
      const name = dep.slice(dep.indexOf("/") + 1);
      const want = `${added.get(name)} -> ${added.get(name)}`;
      if (importer !== list.importer || !dep.startsWith("dependencies/") || locked !== want)
        problems.push(`${importer}: new ${dep} ${locked} is not in the list`);
    }
  }
  for (const [name, version] of added) {
    if (nowImporters.get(list.importer)?.get(`dependencies/${name}`) !== `${version} -> ${version}`)
      problems.push(`${list.importer} does not lock ${name}@${version}`);
  }
  const oldPackages = ids(old, "packages");
  const nowPackages = ids(now, "packages");
  for (const [id, text] of oldPackages) {
    if (!nowPackages.has(id)) problems.push(`upstream package removed: ${id}`);
    else if (integrityOf(nowPackages.get(id)) !== integrityOf(text))
      problems.push(`upstream package integrity changed: ${id}`);
  }
  for (const id of nowPackages.keys())
    if (!oldPackages.has(id) && !(id in list.integrity))
      problems.push(`new package not in the list: ${id}`);
  const oldSnapshots = ids(old, "snapshots");
  const nowSnapshots = ids(now, "snapshots");
  for (const id of oldSnapshots.keys())
    if (!nowSnapshots.has(id)) problems.push(`upstream package no longer installed: ${id}`);
  for (const id of nowSnapshots.keys())
    if (!oldSnapshots.has(id) && !(id in list.integrity))
      problems.push(`new package not in the list: ${id}`);
  for (const [id, sum] of Object.entries(list.integrity)) {
    if (!nowPackages.has(id)) problems.push(`listed but not in the lockfile: ${id}`);
    else if (integrityOf(nowPackages.get(id)) !== sum)
      problems.push(
        `integrity mismatch for ${id}: the lockfile has ${integrityOf(nowPackages.get(id))}`,
      );
  }
  return [...new Set(problems)];
}

function writeAtomic(file, text) {
  const tmp = `${file}.dozo-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const tail = (text, n) => text.trimEnd().split("\n").slice(-n).join("\n");

/** pnpm resolves the new manifest into the lockfile, with every download and cache under `cache`. */
function resolve(root, cache) {
  const env = {
    ...process.env,
    HOME: path.join(cache, "home"),
    COREPACK_HOME: path.join(cache, "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    XDG_CACHE_HOME: path.join(cache, "xdg"),
    npm_config_store_dir: path.join(cache, "store"),
    CI: "1",
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  return spawnSync(
    "corepack",
    ["pnpm", "install", "--lockfile-only", "--ignore-scripts", "--loglevel=warn"],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 600_000,
    },
  );
}

export function run(argv, log = console.log, err = console.error) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = arg("--root");
  const cache = arg("--cache");
  const listFile = arg("--list") ?? DEFAULT_LIST;
  if (!root || !cache) {
    err("usage: apply.mjs --root <staged tree> --cache <dir> [--list <file>]");
    return 64;
  }
  const fail = (reason) => {
    err(`[deps] FAILED: ${reason}`);
    return 2;
  };
  let list;
  let listText;
  try {
    listText = fs.readFileSync(listFile, "utf8");
    list = readList(listText);
  } catch (error) {
    return fail(`${path.basename(listFile)}: ${error.message}`);
  }
  if (list.add.length === 0) {
    log("[deps] none listed: the staged lockfile is upstream's");
    return 0;
  }
  const lockFile = path.join(root, "pnpm-lock.yaml");
  const manifestFile = path.join(root, list.importer, "package.json");
  const before = fs.readFileSync(lockFile, "utf8");
  const manifestBefore = fs.readFileSync(manifestFile, "utf8");
  const restore = (reason) => {
    writeAtomic(lockFile, before);
    writeAtomic(manifestFile, manifestBefore);
    return fail(reason);
  };
  let manifest;
  try {
    manifest = editManifest(manifestBefore, list.add);
  } catch (error) {
    return fail(error.message);
  }
  const key = createHash("sha256")
    .update(before)
    .update("\0")
    .update(manifestBefore)
    .update("\0")
    .update(listText)
    .digest("hex");
  const cached = path.join(cache, "locks", `${key}.yaml`);
  writeAtomic(manifestFile, manifest);
  let after;
  let source = "cached";
  if (fs.existsSync(cached)) {
    after = fs.readFileSync(cached, "utf8");
  } else {
    const result = resolve(root, cache);
    if (result.status !== 0) {
      const output = tail(
        `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
        15,
      );
      return restore(
        `pnpm could not resolve ${path.basename(listFile)}. This input has no cached result, so this step needs the npm registry once (network); later stages of the same input are offline.\n${output}`,
      );
    }
    after = fs.readFileSync(lockFile, "utf8");
    source = "resolved";
  }
  const problems = lockProblems(before, after, list);
  if (problems.length > 0)
    return restore(
      `the lockfile does not match ${path.basename(listFile)}:\n  ${problems.join("\n  ")}`,
    );
  writeAtomic(lockFile, after);
  if (source === "resolved") {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    writeAtomic(cached, after);
  }
  log(
    `[deps] ok: ${list.add.join(", ")} added to ${list.importer} (${source}); upstream's locked versions and integrity unchanged, new packages match the list`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
