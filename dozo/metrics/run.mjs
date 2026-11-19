// Process and file helpers shared by the measuring steps (static.mjs, dynamic.mjs).
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

export const SRC = "/cache/src"; // the repository's files as committed (unbranded), with dependencies
export const STAGE = "/cache/w"; // the branded staged tree, with dependencies
export const TOOLS = "/opt/tools/node_modules"; // pinned tools (tools/package-lock.json)

/** Workers for the test runners: the container's CPU quota (`docker run --cpus`, cgroup v2). */
function cpuQuota() {
  const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(" ");
  return quota === "max"
    ? availableParallelism()
    : Math.max(1, Math.floor(Number(quota) / Number(period)));
}
export const WORKERS = cpuQuota();

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// The directories biome.jsonc leaves out (files.includes), apps/www (the marketing site) among them.
const NOT_CODE =
  /(^|\/)(node_modules|dist|build|coverage|generated|design|data|\.expo)\/|^apps\/www\//;
const TEST = /\.(test|spec|test-support)\.[a-z]+$/;

/** Runs a command; resolves with its exit code and output. Rejects only when it cannot start. */
export function run(cmd, args, { cwd = SRC, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }),
    );
  });
}

/** Like run, but an exit code outside `ok` is a failed measurement. */
export async function must(cmd, args, options = {}, ok = [0]) {
  const result = await run(cmd, args, options);
  if (!ok.includes(result.code)) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-30).join("\n");
    throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} exited ${result.code}\n${tail}`);
  }
  return result;
}

/** Every file of the repository (what git lists, unpacked into /cache/in), repository-relative. */
export function listFiles(root = "/cache/in") {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

export const isCode = (file) => CODE.test(file) && !NOT_CODE.test(file);
export const isTest = (file) => TEST.test(file);

/** Adds `n` to `map[key]`. */
export function bump(map, key, n = 1) {
  map[key] = (map[key] ?? 0) + n;
}

/** The counts of a node --test TAP summary (`# pass N`, `# fail N`, ...). */
export function tapSummary(text) {
  const count = (name) => Number(text.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? 0);
  return {
    passed: count("pass"),
    failed: count("fail") + count("cancelled"),
    skipped: count("skipped") + count("todo"),
  };
}

/** Runs `work` over `items`, at most `limit` at a time. */
export async function eachLimited(items, limit, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await work(queue.shift());
    }),
  );
}
