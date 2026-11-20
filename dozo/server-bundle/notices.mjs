#!/usr/bin/env node
// Third-party notices for the server bundle, made while it is built (build.mjs): every package the
// server's code comes from (pnpm's production list for the API, the worker and the web app, which
// covers what esbuild folds into the entrypoints as well as node_modules), each with its name,
// version, licence and the licence files it ships, and the licence files of the Node and Postgres
// downloads the app puts next to it. licenses.json decides which licences pass: a licence it does
// not name fails the build, one it lists under "review" passes and is reported, with why it needs
// a decision. Files written into the unpacked bundle (rakazo-server/):
//   THIRD-PARTY-NOTICES.txt                  the notices
//   apps/web/dist/third-party-notices.html   the same text, served by the web server for the app
//   LICENSE, NOTICE, LICENSE-DOZO, NOTICE-DOZO   the repository's own licences
// Usage (what build.mjs does): node notices.mjs <branded-tree> <rakazo-server-dir> <platform>
// Exit 0 ok, 2 failed (a licence licenses.json does not allow, a download that does not match
// runtimes.json), 64 usage.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchRuntime, readRuntimes } from "./runtimes.mjs";

const HERE = import.meta.dirname;
const LICENCE_FILE =
  /^(licen[cs]e|copying|notice|copyright)(-[a-z0-9]+)?(\.(md|txt|markdown|rst))?$/i;
/** The workspace's own packages are the repository's code, under its own licences. */
const FIRST_PARTY = /^@rakazo\//;
export const NOTICES = "THIRD-PARTY-NOTICES.txt";
export const PAGE = "third-party-notices.html";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** pnpm's production licence list of the three apps and the workspace packages they use. */
export function listPackages(tree) {
  const out = execFileSync(
    "pnpm",
    [
      "--filter",
      "@rakazo/api...",
      "--filter",
      "@rakazo/worker...",
      "--filter",
      "@rakazo/web...",
      "licenses",
      "list",
      "--prod",
      "--json",
    ],
    {
      cwd: tree,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  return fromPnpm(JSON.parse(out));
}

/**
 * One entry per package and version, sorted, with the licence files read from where it is
 * installed. A version not installed on this platform (another system's native build) is left out.
 */
export function fromPnpm(byLicence) {
  const packages = [];
  for (const [licence, entries] of Object.entries(byLicence)) {
    for (const entry of entries) {
      if (FIRST_PARTY.test(entry.name)) continue;
      entry.versions.forEach((version, index) => {
        const dir = entry.paths[index];
        if (!dir || !fs.existsSync(dir)) return;
        packages.push({ name: entry.name, version, licence, files: licenceFiles(dir) });
      });
    }
  }
  return packages.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

/** The licence files at the top of a folder, by name. */
export function licenceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8").trim() }));
}

/**
 * Checks each package's licence against the policy. `packages` in the policy corrects a licence
 * pnpm reads wrong (a package.json without the field), by name@version.
 */
export function checkLicences(packages, policy) {
  const refused = [];
  const review = [];
  for (const pkg of packages) {
    const corrected = policy.packages?.[`${pkg.name}@${pkg.version}`];
    if (corrected) pkg.licence = corrected;
    if (policy.review[pkg.licence]) {
      review.push({ package: `${pkg.name}@${pkg.version}`, licence: pkg.licence });
    } else if (!policy.allowed.includes(pkg.licence)) {
      refused.push(`${pkg.name}@${pkg.version} (${pkg.licence})`);
    }
  }
  return { refused, review };
}

/** Every file under a folder, as paths relative to it. */
function filesUnder(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return filesUnder(path.join(dir, entry.name), `${relative}/`);
    return entry.isFile() ? [relative] : [];
  });
}

/** The licence files at the top of a runtime archive and under its dependency-notices/. */
export function runtimeLicenceFiles(top) {
  const notices = path.join(top, "dependency-notices");
  return [
    ...licenceFiles(top),
    ...(fs.existsSync(notices)
      ? filesUnder(notices)
          .sort()
          .map((name) => ({
            name: `dependency-notices/${name}`,
            text: fs.readFileSync(path.join(notices, name), "utf8").trim(),
          }))
      : []),
  ];
}

/** Downloads one pinned runtime, checks it against runtimes.json and reads its licence files. */
export async function runtimeLicences(name, platform, runtimes, work) {
  const file = await fetchRuntime(name, platform, runtimes, work);
  const into = path.join(work, name);
  fs.mkdirSync(into);
  // Windows's own tar reads zip; GNU tar there reads "C:" as a remote host, hence relative names.
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  execFileSync(tar, ["-xf", path.basename(file), "-C", name], { cwd: work });
  fs.rmSync(file);
  const [top] = fs.readdirSync(into);
  const files = runtimeLicenceFiles(path.join(into, top));
  fs.rmSync(into, { recursive: true, force: true });
  if (files.length === 0) throw new Error(`${path.basename(file)} has no licence file`);
  return {
    title: `${name === "node" ? "Node.js" : "PostgreSQL"} ${runtimes[name].version}`,
    files,
  };
}

const RULE = "=".repeat(78);

/** The notices as one text. */
export function renderText({ version, platform, packages, runtimes }) {
  const lines = [
    `Third-party notices for the Dozo local server ${version} (${platform})`,
    "",
    "Dozo's own files are under the Elastic License 2.0 and the upstream project's under the",
    "Apache License 2.0: LICENSE, NOTICE, LICENSE-DOZO and NOTICE-DOZO in this folder.",
    "",
    "The server runs on Node.js and PostgreSQL, which the app downloads unchanged and keeps next",
    "to it, each with its own licence files: node/LICENSE, and postgres/COPYRIGHT,",
    "postgres/LICENSE and postgres/dependency-notices/ where present. Their texts follow the",
    "packages below.",
    "",
    `Packages (${packages.length}):`,
    ...packages.map((pkg) => `  ${pkg.name} ${pkg.version}  ${pkg.licence}`),
  ];
  const section = (title, licence, files) => {
    lines.push("", RULE, title, ...(licence ? [`License: ${licence}`] : []), RULE);
    if (files.length === 0) lines.push("", "The package ships no licence file.");
    for (const file of files) lines.push("", `--- ${file.name}`, "", file.text);
  };
  for (const pkg of packages) section(`${pkg.name} ${pkg.version}`, pkg.licence, pkg.files);
  for (const runtime of runtimes) section(runtime.title, undefined, runtime.files);
  return `${lines.join("\n")}\n`;
}

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The same text as a page the app's window can show; the browser's own dark colours. */
export function renderHtml(text) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Licenses</title>
<style>body{margin:24px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
</head>
<body><pre>${escapeHtml(text)}</pre></body>
</html>
`;
}

/** Writes the notices and the repository's licences into an unpacked server folder. */
export function writeNotices({ tree, server, text }) {
  fs.writeFileSync(path.join(server, NOTICES), text);
  fs.writeFileSync(path.join(server, "apps", "web", "dist", PAGE), renderHtml(text));
  const own = [
    ["LICENSE", "LICENSE"],
    ["NOTICE", "NOTICE"],
    ["LICENSE-DOZO", "LICENSE-DOZO"],
    [path.join("dozo", "NOTICE"), "NOTICE-DOZO"],
  ];
  for (const [from, to] of own) {
    const source = path.join(tree, from);
    if (!fs.existsSync(source)) throw new Error(`${from} is missing from the tree`);
    fs.copyFileSync(source, path.join(server, to));
  }
}

/** Everything build.mjs needs: list, check, download the runtimes' licences, write. */
export async function makeNotices({ tree, server, platform, version, say = () => {} }) {
  const policy = readJson(path.join(HERE, "licenses.json"));
  const packages = listPackages(tree);
  const { refused, review } = checkLicences(packages, policy);
  if (refused.length > 0) {
    throw new Error(
      `licences licenses.json does not allow (add them under "allowed" or "review" only after reading them): ${refused.join(", ")}`,
    );
  }
  for (const item of review) {
    say(`licence to decide: ${item.package} ${item.licence}: ${policy.review[item.licence]}`);
  }
  const runtimes = readRuntimes();
  const work = fs.mkdtempSync(path.join(tmpdir(), "dozo-notices-"));
  try {
    const licences = [];
    for (const name of ["node", "postgres"]) {
      licences.push(await runtimeLicences(name, platform, runtimes, work));
    }
    const text = renderText({ version, platform, packages, runtimes: licences });
    writeNotices({ tree, server, text });
    return { packages: packages.length, review, bytes: Buffer.byteLength(text) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [tree, server, platform] = process.argv.slice(2);
  if (!tree || !server || !platform) {
    process.stderr.write("usage: notices.mjs <branded-tree> <rakazo-server-dir> <platform>\n");
    process.exit(64);
  }
  const version = readJson(path.join(server, "manifest.json")).version;
  makeNotices({
    tree,
    server,
    platform,
    version,
    say: (line) => process.stdout.write(`[notices] ${line}\n`),
  }).then(
    (result) =>
      process.stdout.write(`[notices] ${result.packages} packages, ${result.bytes} bytes\n`),
    (error) => {
      process.stderr.write(`[notices] FAILED: ${error.message}\n`);
      process.exit(2);
    },
  );
}
