// Offline test of canli/fence.ts (`make olc`): the live run's fence must classify every procedure
// of the namespaces it guards, read from the contracts themselves, so a procedure added there fails
// here until it is listed as a read or a write. Unknown procedures are refused at run time.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FENCED_NAMESPACES, fenceVerdict, isNetworkFlap, READS, WRITES } from "./canli/fence.ts";

const SRC = new URL("../../packages/contracts/src/", import.meta.url);
const files = readdirSync(SRC)
  .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
  .map((name) => readFileSync(new URL(name, SRC), "utf8"));

/** The lines of the object literal that opens at `start` (a line ending in `{`), without it. */
function block(lines, start) {
  const indent = lines[start].match(/^ */)[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp(`^ {${indent}}[}\\]]`).test(lines[i])) return out;
    out.push(lines[i]);
  }
  throw new Error(`unclosed block at line ${start}`);
}

/** Every procedure of an object literal, as `prefix/key[/key]`: `oc` values, nested literals and named contracts. */
function procedures(lines, prefix) {
  const indent = Math.min(
    ...lines.filter((l) => /^\s+\w+:/.test(l)).map((l) => l.match(/^ */)[0].length),
  );
  const found = [];
  lines.forEach((line, i) => {
    const key = line.match(new RegExp(`^ {${indent}}(\\w+):\\s*(.*)$`));
    if (!key) return;
    const [, name, value] = key;
    const path = `${prefix}/${name}`;
    if (/^oc\b/.test(value)) found.push(path);
    else if (value === "{") found.push(...procedures(block(lines, i), path));
    else if (/^\w+Contract,?$/.test(value)) found.push(...named(value.replace(/,$/, ""), path));
    else throw new Error(`cannot read ${path}: ${value}`);
  });
  return found;
}

/** The procedures of `export const <id> = {` in any contract file. */
function named(id, prefix) {
  for (const text of files) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`export const ${id} = {`));
    if (start !== -1) return procedures(block(lines, start), prefix);
  }
  throw new Error(`${id} not found in packages/contracts/src`);
}

/** A namespace written inline in rpc.ts (`  accessGrants: {`). */
function inline(namespace) {
  const lines = readFileSync(new URL("rpc.ts", SRC), "utf8").split("\n");
  const start = lines.findIndex((line) => line === `  ${namespace}: {`);
  assert.notEqual(start, -1, `rpc.ts has no ${namespace} namespace`);
  return procedures(block(lines, start), namespace);
}

// How each fenced namespace reaches the router: the fork's own contracts by name (mounted by brand
// rules in rpc.ts), upstream's inline in rpc.ts.
const contract = {
  dozoAdmin: () => named("dozoAdminContract", "dozoAdmin"),
  dozoSiteSettings: () => named("dozoSiteSettingsContract", "dozoSiteSettings"),
  accessGrants: () => inline("accessGrants"),
  marketplace: () => inline("marketplace"),
};

test("every procedure of the fenced namespaces is classified, and nothing else is", () => {
  assert.deepEqual(Object.keys(contract).sort(), [...FENCED_NAMESPACES].sort());
  const all = Object.values(contract).flatMap((read) => read());
  assert.ok(all.length > 20, `only ${all.length} procedures read from the contracts`);
  const unclassified = all.filter((p) => !READS.has(p) && !WRITES.has(p));
  assert.deepEqual(unclassified, [], "classify these in dozo/e2e/canli/fence.ts");
  const both = all.filter((p) => READS.has(p) && WRITES.has(p));
  assert.deepEqual(both, []);
  const stale = [...READS, ...WRITES].filter((p) => !all.includes(p));
  assert.deepEqual(stale, [], "listed in fence.ts but gone from the contracts");
});

test("the reads the admin pages make pass; writes and unknown procedures are refused", () => {
  for (const read of [
    "dozoAdmin/bans",
    "dozoAdmin/users",
    "dozoAdmin/billing/summary",
    "accessGrants/list",
  ])
    assert.equal(fenceVerdict(`/rpc/${read}`).pass, true, read);
  for (const write of [
    "dozoAdmin/ban",
    "dozoAdmin/unban",
    "dozoAdmin/setPlan",
    "dozoAdmin/plans/setQuota",
    "billing/portal",
  ])
    assert.equal(fenceVerdict(`/rpc/${write}`).pass, false, write);
  const unknown = fenceVerdict("/rpc/dozoAdmin/somethingNew");
  assert.equal(unknown.pass, false);
  assert.match(
    unknown.reason,
    /unknown procedure dozoAdmin\/somethingNew: if it only reads, add it to READS/,
  );
  // Outside the fence the probe's own account works as any member's.
  assert.equal(fenceVerdict("/rpc/billing/checkout").pass, true);
  assert.equal(fenceVerdict("/rpc/threads/send").pass, true);
  assert.equal(fenceVerdict("/api/auth/sign-in/email").pass, true);
});

test("isNetworkFlap: only the machine's own network changes", () => {
  assert.equal(isNetworkFlap("page.goto: net::ERR_NETWORK_CHANGED at https://x/"), true);
  assert.equal(isNetworkFlap("net::ERR_INTERNET_DISCONNECTED"), true);
  assert.equal(isNetworkFlap("net::ERR_CONNECTION_REFUSED"), false);
  assert.equal(isNetworkFlap("Timeout 45000ms exceeded"), false);
});
