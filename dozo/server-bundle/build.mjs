#!/usr/bin/env node
// Builds the local server bundle for this machine's platform from a branded staged tree.
// Usage: node dozo/server-bundle/build.mjs <branded-tree> <out-dir>
// Runs in the tree: pnpm install, db:generate, the web build, then upstream's
// scripts/build-server-bundle.mjs (wrapped, never edited). Then it drops the packages TRIM names
// (never loaded by a local server), adds the relay host agent and the local commands as one file
// each (rakazo-server/dozo-relay-agent.mjs, entrypoint "relay"; COMMANDS below), writes the
// third-party notices and the repository's licences into it (notices.mjs), repacks, and writes to
// <out-dir>:
//   dozo-server-<platform>-<arch>.tar.xz   one folder, rakazo-server/ (upstream's layout)
//   dozo-server-<platform>-<arch>.json     { platform, version, file, sha256, size, ... }
// manifest.mjs joins those fragments with runtimes.json into the manifest the desktop app reads.
// Needs Node 24 and corepack on PATH, git and tar with xz. Exit 0 ok, 2 failed, 64 usage.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeNotices } from "./notices.mjs";

// Store folders (node_modules/.pnpm/<name>@<version>...) left out of the bundle, with why a local
// server never loads them. smoke.sh proves the server still migrates, starts and answers without
// them. Not here although big: Prisma Studio and Prisma's dev server, which the Prisma CLI (needed
// for the migrations) requires as it loads, and esbuild, which builds pages at runtime.
const TRIM = [
  ["typescript", "type checker, loaded by the Prisma CLI only for a TypeScript config"],
  ["prettier", "formatter; nothing formats code at runtime"],
  [
    "@kubernetes+client-node",
    "cluster computer provider; a local server runs SANDBOX_PROVIDER=none",
  ],
];

// The bundle's version is upstream's with this revision after it: a change to what the fork adds
// (the agent, the trim) makes a new version, so the desktop app installs it as a new folder.
// Raise it with every such change; the release tag is server-v<version>.
const REVISION = 5;
const AGENT = "dozo-relay-agent.mjs";
// Windows only: the links of the bundle, which an archive made there cannot carry (pnpm makes
// junctions), as { "<link>": "<target, relative to the link's folder>" }, forward slashes. The
// desktop app makes each one again where it installs the bundle. Written by upstream's script
// through an anchored rule (dozo/brand/brand.json).
const LINKS = "dozo-links.json";
// The local server's own commands (README.md: "Backup and restore", "Account repairs",
// "Diagnostics"): entrypoint name, the file it becomes, and its source.
const COMMANDS = [
  ["backup", "dozo-local-backup.mjs", "packages/adapters/src/dozo-local-backup.ts"],
  ["account", "dozo-local-account.mjs", "packages/adapters/src/dozo-local-account.ts"],
  ["diagnostics", "dozo-diagnostics.mjs", "packages/adapters/src/dozo-local-diagnostics.ts"],
];

const fail = (message, code = 2) => {
  process.stderr.write(`[server-bundle] FAILED: ${message}\n`);
  process.exit(code);
};

const [treeArg, outArg] = process.argv.slice(2);
if (!treeArg || !outArg) fail("usage: build.mjs <branded-tree> <out-dir>", 64);
const tree = path.resolve(treeArg);
const outDir = path.resolve(outArg);
const platform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const win = process.platform === "win32";
const say = (line) => process.stdout.write(`[server-bundle] ${line}\n`);
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(0)}s`;

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: tree,
    stdio: "inherit",
    shell: win,
    env: { ...process.env, CI: "1", ...env },
  });
}

/** Every entry under a folder; symlinks are listed, never followed. */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    yield [at, entry];
    if (entry.isDirectory()) yield* walk(at);
  }
}

/** Total bytes and files under a folder, and its longest path inside (Windows' limit is 260). */
function measure(dir) {
  let bytes = 0;
  let files = 0;
  let longest = 0;
  for (const [at, entry] of walk(dir)) {
    longest = Math.max(longest, path.relative(dir, at).length);
    if (!entry.isFile()) continue;
    bytes += fs.statSync(at).size;
    files += 1;
  }
  return { bytes, files, longest };
}

/**
 * Removes the TRIM store folders and every link left pointing at nothing: symlinks, and on
 * Windows the entries of LINKS whose folder or target went with them.
 */
function trim(root) {
  const store = path.join(root, "node_modules", ".pnpm");
  const removed = [];
  for (const entry of fs.readdirSync(store)) {
    if (TRIM.some(([name]) => entry.startsWith(`${name}@`))) {
      fs.rmSync(path.join(store, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  const dangling = [...walk(root)].filter(
    ([at, entry]) => entry.isSymbolicLink() && !fs.existsSync(at),
  );
  for (const [at] of dangling) fs.rmSync(at);
  let listed = 0;
  let unlisted = 0;
  const list = path.join(root, LINKS);
  if (fs.existsSync(list)) {
    const links = Object.entries(JSON.parse(fs.readFileSync(list, "utf8")));
    const kept = links.filter(([at, target]) => {
      const folder = path.join(root, path.dirname(at));
      return fs.existsSync(folder) && fs.existsSync(path.join(folder, target));
    });
    fs.writeFileSync(list, `${JSON.stringify(Object.fromEntries(kept), null, 1)}\n`);
    listed = kept.length;
    unlisted = links.length - kept.length;
  }
  return { removed, dangling: dangling.length + unlisted, listed };
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const started = Date.now();
const timings = {};
const step = (name, work) => {
  const t = Date.now();
  say(`${name}...`);
  try {
    work();
  } catch (error) {
    fail(`${name}: ${error.message}`);
  }
  timings[name] = Math.round((Date.now() - t) / 1000);
};

if (!fs.existsSync(path.join(tree, "scripts", "build-server-bundle.mjs"))) {
  fail(`${tree} has no scripts/build-server-bundle.mjs; pass the branded staged tree`);
}
// Upstream's script lists workspace files with git ls-files; a staged tree has no .git.
if (!fs.existsSync(path.join(tree, ".git"))) {
  step("git", () => {
    run("git", ["init", "-q"]);
    run("git", ["add", "-A"]);
    run("git", [
      "-c",
      "user.email=build@example.invalid",
      "-c",
      "user.name=build",
      "commit",
      "-qm",
      "stage",
    ]);
  });
}
step("install", () => run("pnpm", ["install", "--frozen-lockfile"]));
// db:generate only renders the client; the URL is never dialled.
step("db:generate", () =>
  run("pnpm", ["db:generate"], { DATABASE_URL: "postgres://build:build@127.0.0.1:5432/build" }),
);
step("web", () =>
  run("pnpm", ["--filter", "@rakazo/web", "build"], {
    RAKAZO_ALLOW_DEV_SECRETS: "1",
    NODE_OPTIONS: "--max-old-space-size=4096",
  }),
);

const work = fs.mkdtempSync(path.join(tmpdir(), "dozo-server-bundle-"));
/**
 * One fork command as one file: plain Node runs it, no tsx. Through esbuild's own API, not its
 * command line, which on Windows goes through a shell that splits arguments at their spaces.
 */
const bundleCommand = (entry, outfile, options = {}) =>
  createRequire(path.join(tree, "package.json"))("esbuild").buildSync({
    absWorkingDir: tree,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    logLevel: "warning",
    ...options,
  });

// The relay host agent (dozo/relay/agent/README.md). ws's optional native helpers stay out; ws
// runs without them.
step("relay agent", () => {
  bundleCommand("packages/adapters/src/dozo-relay-agent.ts", path.join(work, AGENT), {
    external: ["bufferutil", "utf-8-validate"],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  // It loads and answers: a fresh state folder has no channels. By its real path, as the app
  // runs it: the agent runs its command only when Node's path for it is the file it loaded
  // (macOS's temporary folder is behind a link).
  const listed = execFileSync(
    "node",
    [fs.realpathSync(path.join(work, AGENT)), "list", "--state", path.join(work, "agent-state")],
    {
      encoding: "utf8",
    },
  );
  if (listed.trim() !== '{"channels":[]}') throw new Error(`agent list printed ${listed}`);
  fs.rmSync(path.join(work, "agent-state"), { recursive: true, force: true });
});
// The local commands, the same way. Without arguments each loads and answers with its usage line
// and exit 64.
step("commands", () => {
  for (const [, file, source] of COMMANDS) {
    bundleCommand(source, path.join(work, file), {
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    const usage = spawnSync("node", [fs.realpathSync(path.join(work, file))], {
      encoding: "utf8",
      input: "",
    });
    if (usage.status !== 64 || !usage.stdout.includes('"reason":"usage"')) {
      throw new Error(
        `${file} without arguments exited ${usage.status}: ${usage.stdout}${usage.stderr}`,
      );
    }
  }
});
let upstream;
step("bundle", () => {
  run("node", ["scripts/build-server-bundle.mjs", path.join(work, "upstream")]);
  upstream = JSON.parse(fs.readFileSync(path.join(work, "upstream", "server-bundle.json"), "utf8"));
});

const unpacked = path.join(work, "unpacked");
const name = `dozo-server-${platform}`;
const archive = path.join(outDir, `${name}.tar.xz`);
let before;
let after;
let trimmed;
step("trim", () => {
  const upstreamArchive = fs
    .readdirSync(path.join(work, "upstream"))
    .find((file) => file.endsWith(".tar.xz"));
  fs.mkdirSync(unpacked);
  // Archive names relative to cwd: GNU tar on Windows reads "C:" in -f as a remote host.
  execFileSync("tar", ["-xJf", path.join("upstream", upstreamArchive), "-C", unpacked], {
    cwd: work,
  });
  before = measure(unpacked);
  trimmed = trim(path.join(unpacked, "rakazo-server"));
  const server = path.join(unpacked, "rakazo-server");
  fs.copyFileSync(path.join(work, AGENT), path.join(server, AGENT));
  for (const [, file] of COMMANDS) fs.copyFileSync(path.join(work, file), path.join(server, file));
  const manifest = JSON.parse(fs.readFileSync(path.join(server, "manifest.json"), "utf8"));
  manifest.entrypoints = {
    ...manifest.entrypoints,
    relay: AGENT,
    ...Object.fromEntries(COMMANDS.map(([name, file]) => [name, file])),
  };
  fs.writeFileSync(path.join(server, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [prefix] of TRIM) {
    if (!trimmed.removed.some((entry) => entry.startsWith(`${prefix}@`))) {
      say(`trim: ${prefix} is no longer in the bundle; drop it from TRIM`);
    }
  }
});
let notices;
{
  const t = Date.now();
  say("notices...");
  try {
    notices = await makeNotices({
      tree,
      server: path.join(unpacked, "rakazo-server"),
      platform,
      version: `${upstream.version}-${REVISION}`,
      say,
    });
  } catch (error) {
    fail(`notices: ${error.message}`);
  }
  timings.notices = Math.round((Date.now() - t) / 1000);
}
step("pack", () => {
  after = measure(unpacked);
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(archive, { force: true });
  // Threads with large blocks: about as small as upstream's single-threaded xz, three times faster.
  execFileSync("tar", ["-cJf", path.basename(archive), "-C", unpacked, "rakazo-server"], {
    cwd: outDir,
    env: { ...process.env, XZ_OPT: "-6 -T0 --block-size=256MiB" },
  });
});
fs.rmSync(work, { recursive: true, force: true });

const fragment = {
  platform,
  version: `${upstream.version}-${REVISION}`,
  file: path.basename(archive),
  sha256: sha256(archive),
  size: fs.statSync(archive).size,
  unpackedSize: after.bytes,
  files: after.files,
  untrimmed: { size: upstream.size, unpackedSize: before.bytes, files: before.files },
  trimmed: trimmed.removed,
  notices: { packages: notices.packages, bytes: notices.bytes, review: notices.review },
  buildSeconds: timings,
};
fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(fragment, null, 2)}\n`);
say(
  `trim: ${trimmed.removed.length} store folders, ${trimmed.dangling} dangling links${win ? `, ${trimmed.listed} listed links` : ""}; unpacked ${mb(before.bytes)} -> ${mb(after.bytes)}, files ${before.files} -> ${after.files}, longest path ${after.longest}`,
);
say(
  `${fragment.file}: ${mb(fragment.size)} (untrimmed ${mb(upstream.size)}), sha256 ${fragment.sha256}, total ${seconds(started)}`,
);
