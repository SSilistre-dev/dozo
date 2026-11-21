import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { main, REVIEWED, threadBotReads, unreviewed } from "./thread-bot-guard.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(files, reviewed = "") {
  const root = mkdtempSync(join(tmpdir(), "thread-bot-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(join(root, "dozo/db"), { recursive: true });
  writeFileSync(join(root, REVIEWED), reviewed);
  return root;
}

function run(argv) {
  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  return { code: main(argv, out), text: lines.join("\n") };
}

describe("the thread bot guard", () => {
  const files = {
    "apps/api/src/turn.ts": "if (!thread.botId) return;\nconst x = thread?.botId;\n",
    "packages/db/src/q.ts": 'SELECT 1 FROM bots b WHERE b.id = t."botId"\n',
    "packages/db/src/other.ts": "const bot = run.botId;\n",
    "apps/api/src/dozo-own.ts": "thread.botId\n",
    "apps/api/src/turn.test.ts": "thread.botId\n",
    "packages/testkit/src/x.ts": "thread.botId\n",
  };

  it("finds upstream source lines that read a chat's bot, and only those", () => {
    assert.deepEqual(threadBotReads(tree(files)), [
      "apps/api/src/turn.ts\tif (!thread.botId) return;",
      "apps/api/src/turn.ts\tconst x = thread?.botId;",
      'packages/db/src/q.ts\tSELECT 1 FROM bots b WHERE b.id = t."botId"',
    ]);
  });

  it("fails (exit 2) on a line not reviewed, a repeat included, naming it", () => {
    const root = tree(
      { ...files, "apps/api/src/new.ts": "if (thread.botId) x();\nif (thread.botId) x();\n" },
      "apps/api/src/new.ts\tif (thread.botId) x();\n",
    );
    assert.deepEqual(unreviewed(root, readFileSync(join(root, REVIEWED), "utf8")).length, 4);
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 2);
    assert.match(text, /apps\/api\/src\/new\.ts: if \(thread\.botId\) x\(\);/);
    assert.match(text, /--write/);
  });

  it("passes once every line is reviewed, and --write records them", () => {
    const root = tree(files);
    assert.equal(run([`--root=${root}`, "--write"]).code, 0);
    assert.match(readFileSync(join(root, REVIEWED), "utf8"), /^# /);
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 0);
    assert.match(text, /ok/);
  });

  it("answers 64 to an unknown argument", () => {
    assert.equal(run(["--bogus"]).code, 64);
  });

  it("passes the tree as it is", () => {
    const root = join(import.meta.dirname, "../..");
    assert.deepEqual(unreviewed(root, readFileSync(join(root, REVIEWED), "utf8")), []);
  });
});
