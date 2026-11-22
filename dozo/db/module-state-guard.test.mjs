import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { main, moduleState, REVIEWED } from "./module-state-guard.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(files, reviewed = "") {
  const root = mkdtempSync(join(tmpdir(), "module-state-"));
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

const ROW =
  "apps/api/src/dozo-a.ts\tconst cache = new Map<string, number>();\tuser\tcounts per user";

describe("the module state guard", () => {
  it("fails (exit 2) on a new top-level Map, naming it", () => {
    const root = tree({ "apps/api/src/dozo-a.ts": "const cache = new Map<string, number>();\n" });
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 2);
    assert.match(text, /apps\/api\/src\/dozo-a\.ts: const cache = new Map/);
  });

  it("passes once the row is reviewed", () => {
    const root = tree(
      { "apps/api/src/dozo-a.ts": "const cache = new Map<string, number>();\n" },
      `${ROW}\n`,
    );
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 0);
    assert.match(text, /ok/);
  });

  it("fails on a stale row and on a row with no valid scope", () => {
    const stale = tree({ "apps/api/src/dozo-a.ts": "export const x = 1;\n" }, `${ROW}\n`);
    const a = run([`--root=${stale}`]);
    assert.equal(a.code, 2);
    assert.match(a.text, /match no line any more/);
    const bad = tree(
      { "apps/api/src/dozo-a.ts": "const cache = new Map<string, number>();\n" },
      "apps/api/src/dozo-a.ts\tconst cache = new Map<string, number>();\tbogus\tx\n",
    );
    assert.equal(run([`--root=${bad}`]).code, 2);
  });

  it("flags let, var, empty containers and a split declaration", () => {
    const root = tree({
      "packages/core/src/dozo-b.ts":
        "let a = 0;\nexport var b;\nconst c = {};\nconst d: X[] = [];\nconst e =\n  new Set();\nconst f = new Foo();\n",
    });
    assert.equal(moduleState(root).length, 6);
  });

  it("fails (exit 2) on a Map in the direct body of a factory, and takes a local row", () => {
    const files = {
      "apps/api/src/dozo-f.ts":
        "export function make() {\n  const open = new Map<string, number>();\n  let n = 0;\n  return () => open;\n}\n",
    };
    const root = tree(files);
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 2);
    assert.match(text, /dozo-f\.ts: const open = new Map/);
    assert.match(text, /dozo-f\.ts: let n = 0;/);
    const rows =
      "apps/api/src/dozo-f.ts\tconst open = new Map<string, number>();\ttoken\topen count by token\n" +
      "apps/api/src/dozo-f.ts\tlet n = 0;\tlocal\tper-call local\n";
    assert.equal(run([`--root=${tree(files, rows)}`]).code, 0);
  });

  it("ignores deeper nesting, other constructors in a body, constants, immutable constructors and comments", () => {
    const root = tree({
      "apps/api/src/dozo-c.ts":
        "export function f() {\n  if (x) {\n    const m = new Map();\n    let n = 0;\n  }\n  const t = new Foo();\n  const u = 1;\n}\nconst K = 1;\nconst R = new RegExp('x');\nconst U = new URL('http://x');\n// let x = 1;\nconst o = { a: 1 };\n",
    });
    assert.deepEqual(moduleState(root), []);
  });

  it("ignores tests, test support, upstream files, client and test-kit packages", () => {
    const decl = "const cache = new Map();\n";
    const root = tree({
      "apps/api/src/dozo-a.test.ts": decl,
      "apps/api/src/dozo-a.test-support.ts": decl,
      "apps/api/src/upstream.ts": decl,
      "packages/ui-web/src/dozo-x.ts": decl,
      "packages/chat-ui/src/dozo-x.tsx": decl,
      "packages/testkit/src/dozo-x.ts": decl,
      "apps/web/src/dozo-x.ts": decl,
      "packages/core/node_modules/p/dozo-x.ts": decl,
    });
    assert.deepEqual(moduleState(root), []);
  });

  it("fails when the reviewed list is missing, and answers 64 to an unknown argument", () => {
    const root = tree({});
    rmSync(join(root, REVIEWED));
    assert.equal(run([`--root=${root}`]).code, 2);
    assert.equal(run(["--bogus"]).code, 64);
  });

  it("--write keeps notes of matching rows and marks new hits TODO, which then fail", () => {
    const root = tree(
      { "apps/api/src/dozo-a.ts": "const cache = new Map<string, number>();\nlet n = 0;\n" },
      `${ROW}\n`,
    );
    assert.equal(run([`--root=${root}`, "--write"]).code, 0);
    const text = readFileSync(join(root, REVIEWED), "utf8");
    assert.match(text, /counts per user/);
    assert.match(text, /let n = 0;\tTODO\tTODO/);
    assert.equal(run([`--root=${root}`]).code, 2);
  });

  it("passes the tree as it is", () => {
    const root = join(import.meta.dirname, "../..");
    assert.equal(run([`--root=${root}`]).code, 0);
  });
});
