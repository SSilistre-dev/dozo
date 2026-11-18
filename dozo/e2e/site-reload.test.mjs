// `deploy.sh site` loads a changed nginx config and proves it: dozo/deploy/site-reload.sh (run on
// the host) tests then reloads the running container, and `site-assets.sh lang` checks the language
// rule on the live site. Both run here against a fake docker and a fake curl on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const deploy = (name) => fileURLToPath(new URL(`../deploy/${name}`, import.meta.url));

// run(script args, fake tool name, fake tool body, its environment): the fake logs its arguments.
function run(args, tool, body, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "site-reload-"));
  const log = join(bin, "log");
  writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "$*" >>"${log}"\n${body}\n`);
  chmodSync(join(bin, tool), 0o755);
  writeFileSync(log, "");
  const result = spawnSync("bash", args, {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n") };
}

const docker = 'case "$1 $*" in ps*) echo "$FAKE_ID" ;; exec*"nginx -t") exit "$FAKE_TEST" ;; esac';
const reload = (env) => run([deploy("site-reload.sh"), "proj"], "docker", docker, env);

test("the config is tested, then reloaded, in the container found by its compose labels", () => {
  const { result, calls } = reload({ FAKE_ID: "abc", FAKE_TEST: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "ps -q -f label=com.docker.compose.project=proj -f label=com.docker.compose.service=site",
    "exec abc nginx -t",
    "exec abc nginx -s reload",
  ]);
});

test("a config that fails nginx -t is not reloaded and fails", () => {
  const { result, calls } = reload({ FAKE_ID: "abc", FAKE_TEST: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(calls.at(-1), "exec abc nginx -t");
});

test("no running site container fails", () => {
  const { result, calls } = reload({ FAKE_ID: "", FAKE_TEST: "0" });
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 1);
});

const curl = 'case "$*" in *"Cookie: dozo_lang=tr"*) printf %s "$FAKE_HOME" ;; *) printf "%b" "$FAKE_TR" ;; esac';
const cookie = "HTTP/2 200\\r\\nset-cookie: dozo_lang=tr; Path=/\\r\\n";
const lang = (env) => run([deploy("site-assets.sh"), "lang", "https://site.example"], "curl", curl, env);

test("the live site sets the language cookie and follows it", () => {
  const { result, calls } = lang({ FAKE_TR: cookie, FAKE_HOME: "302 https://site.example/tr/" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls[0], /https:\/\/site\.example\/tr\/$/);
  assert.match(calls[1], /-H Cookie: dozo_lang=tr https:\/\/site\.example\/$/);
});

test("a site still on the old config fails", () => {
  const old = lang({ FAKE_TR: "HTTP/2 200\\r\\n", FAKE_HOME: "200 " });
  assert.equal(old.result.status, 2);
  assert.match(old.result.stderr, /does not set the dozo_lang=tr cookie/);
  const home = lang({ FAKE_TR: cookie, FAKE_HOME: "200 " });
  assert.equal(home.result.status, 2);
  assert.match(home.result.stderr, /not a 302/);
});
