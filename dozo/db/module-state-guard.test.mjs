import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { main, moduleState, REVIEWED } from "./module-state-guard.mjs";

// The gate passes the parser it mounts; run by hand, the repo's own install is used.
process.env.DOZO_TYPESCRIPT ??= join(import.meta.dirname, "../../apps/www/node_modules/typescript");

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
  "apps/api/src/dozo-a.ts\tmodule\tconst cache = new Map<string, number>();\tuser\tcounts per user";
const A = "apps/api/src/dozo-a.ts";
const hits = (files) => moduleState(tree(files)).map((hit) => hit.split("\t").slice(1).join(" | "));

describe("the module state guard", () => {
  it("fails (exit 2) on a new top-level Map, naming it", () => {
    const root = tree({ [A]: "const cache = new Map<string, number>();\n" });
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 2);
    assert.match(text, /apps\/api\/src\/dozo-a\.ts: module: const cache = new Map/);
  });

  it("passes once the row is reviewed", () => {
    const root = tree({ [A]: "const cache = new Map<string, number>();\n" }, `${ROW}\n`);
    const { code, text } = run([`--root=${root}`]);
    assert.equal(code, 0);
    assert.match(text, /ok/);
  });

  it("fails on a stale row and on a row with no valid scope", () => {
    const stale = tree({ [A]: "export const x = 1;\n" }, `${ROW}\n`);
    const a = run([`--root=${stale}`]);
    assert.equal(a.code, 2);
    assert.match(a.text, /match no line any more/);
    const bad = tree(
      { [A]: "const cache = new Map<string, number>();\n" },
      `${ROW.replace("\tuser\t", "\tbogus\t")}\n`,
    );
    assert.equal(run([`--root=${bad}`]).code, 2);
  });

  it("a reviewed local moved to module level is red: the level is part of the key", () => {
    const local = `export function f() {\n  const seen = new Set<string>();\n  return (x: string) => seen.has(x);\n}\n`;
    const row = `${A}\tfn f\tconst seen = new Set<string>();\tlocal\tper-call local\n`;
    assert.equal(run([`--root=${tree({ [A]: local }, row)}`]).code, 0);
    const moved = run([`--root=${tree({ [A]: "const seen = new Set<string>();\n" }, row)}`]);
    assert.equal(moved.code, 2);
    assert.match(
      moved.text,
      /unreviewed long-lived state:\n {2}apps\/api\/src\/dozo-a\.ts: module: const seen/,
    );
    assert.match(
      moved.text,
      /match no line any more:\n {2}apps\/api\/src\/dozo-a\.ts: fn f: const seen/,
    );
    const inClass = run([
      `--root=${tree({ [A]: "class C {\n  seen = new Set<string>();\n}\n" }, row)}`,
    ]);
    assert.equal(inClass.code, 2);
  });

  it("flags let, var, empty and nested containers, factory calls and split declarations at module level", () => {
    assert.deepEqual(
      hits({
        [A]: [
          "let a = 0;",
          "export var b;",
          "const c = {};",
          "const d: X[] = [];",
          "const e =\n  new Set();",
          "const f = new Foo();",
          "const g = { users: {} };",
          "const h = { list: [], n: 1 };",
          "const i = createCache();",
          "const j = makeLru(100);",
          "const k = new Map<\n  string,\n  number\n>();",
          "const l = await loadThings();",
          "const m = { max: 1 };\nm.max = 2;",
          "const n = [1, 2];\nn.push(3);",
          "const o = base.map((x) => x);\no.push(1);",
        ].join("\n"),
      }),
      [
        "module | let a = 0;",
        "module | export var b;",
        "module | const c = {};",
        "module | const d: X[] = [];",
        "module | const e =",
        "module | const f = new Foo();",
        "module | const g = { users: {} };",
        "module | const h = { list: [], n: 1 };",
        "module | const i = createCache();",
        "module | const j = makeLru(100);",
        "module | const k = new Map<",
        "module | const l = await loadThings();",
        "module | const m = { max: 1 };",
        "module | const n = [1, 2];",
        "module | const o = base.map((x) => x);",
      ],
    );
  });

  it("passes constants, immutable constructors, schema builders, as const, derived values and comments", () => {
    assert.deepEqual(
      hits({
        [A]: [
          "const K = 1;",
          "const R = new RegExp('x');",
          "const U = new URL('http://x');",
          "const D = new Date(0);",
          "const E = new TypeError('x');",
          "const B = new Uint8Array(4);",
          "const S = z.object({ a: z.string() });",
          "const T = UserSchema.omit({ id: true });",
          "const Y = Symbol('y');",
          "const F = Object.freeze({ a: 1 });",
          "const L = ['a', 'b'] as const;",
          "const M = { a: 1, b: 'x' };",
          "const N = LIST.map((x) => x);",
          "const P = /* @__PURE__ */ buildTable();",
          "const Q = () => { const m = new Map(); return m; };",
          "const fn = function () { let n = 0; n += 1; return n; };",
          "// let x = 1;",
          "declare let ambient: number;",
        ].join("\n"),
      }),
      [],
    );
  });

  it("reads a class: instance and static fields, constructor assignments; not methods' locals", () => {
    assert.deepEqual(
      hits({
        [A]: [
          "export class Store {",
          "  private cache = new Map<string, number>();",
          "  static byUser = new Map<string, number>();",
          "  readonly log = createLogger();",
          "  open = { users: {} };",
          "  count = 0;",
          "  name = 'x';",
          "  constructor() {",
          "    this.seen = new Set();",
          "    this.label = 'x';",
          "  }",
          "  run() {",
          "    const local = new Map();",
          "    return local;",
          "  }",
          "}",
        ].join("\n"),
      }),
      [
        "class Store | private cache = new Map<string, number>();",
        "class Store | static byUser = new Map<string, number>();",
        "class Store | readonly log = createLogger();",
        "class Store | open = { users: {} };",
        "class Store | this.seen = new Set()",
      ],
    );
  });

  it("reads a factory: only state a nested function can reach, and what a returned service holds", () => {
    assert.deepEqual(
      hits({
        [A]: [
          "export function make() {",
          "  const open = new Map<string, number>();",
          "  let n = 0;",
          "  const scratch = new Map();",
          "  let total = 0;",
          "  const ids = [1].map((id) => id + total);",
          "  const shared = createCache();",
          "  const note = createNote();",
          "  if (x) {",
          "    var late = [];",
          "    setInterval(() => late.push(1), 5);",
          "  }",
          "  scratch.set('a', 1);",
          "  return {",
          "    count: () => n + open.size + shared.size,",
          "    memo: new Map(),",
          "    note,",
          "    nothing: 1,",
          "  };",
          "}",
          "export const arrow = () => ({ get: () => 1, cache: {} });",
          "export function plain() {",
          "  const rows = new Map();",
          "  let sum = 0;",
          "  for (const r of data) sum += r;",
          "  return { rows, sum };",
          "}",
        ].join("\n"),
      }),
      [
        "fn make | const open = new Map<string, number>();",
        "fn make | let n = 0;",
        "fn make | const shared = createCache();",
        "fn make | const note = createNote();",
        "fn make | var late = [];",
        "fn make | memo: new Map()",
        "fn arrow | cache: {}",
      ],
    );
  });

  it("flags a globalThis or global slot written anywhere", () => {
    assert.deepEqual(
      hits({
        [A]: [
          "globalThis.cache = new Map();",
          "export function f() {",
          "  (globalThis as any).slots ??= {};",
          "  global['x'] = 1;",
          "  Object.assign(globalThis, { y: 1 });",
          "  Object.defineProperty(globalThis, 'z', { value: 1 });",
          "  const read = globalThis.cache;",
          "}",
        ].join("\n"),
      }),
      [
        "module | globalThis.cache = new Map()",
        "fn f | (globalThis as any).slots ??= {}",
        "fn f | global['x'] = 1",
        "fn f | Object.assign(globalThis, { y: 1 })",
        "fn f | Object.defineProperty(globalThis, 'z', { value: 1 })",
      ],
    );
  });

  it("fails (exit 2) on a Map in a factory the closure reaches, and takes a local row", () => {
    const files = {
      [A]: "export function make() {\n  const open = new Map<string, number>();\n  let n = 0;\n  return () => open.size + n;\n}\n",
    };
    const { code, text } = run([`--root=${tree(files)}`]);
    assert.equal(code, 2);
    assert.match(text, /dozo-a\.ts: fn make: const open = new Map/);
    assert.match(text, /dozo-a\.ts: fn make: let n = 0;/);
    const rows =
      `${A}\tfn make\tconst open = new Map<string, number>();\ttoken\topen count by token\n` +
      `${A}\tfn make\tlet n = 0;\tlocal\tper-call local\n`;
    assert.equal(run([`--root=${tree(files, rows)}`]).code, 0);
  });

  it("scans the relay worker's source (any file name), not its tests, and not other dozo/ code", () => {
    const decl = "const seen = new Map<string, number>();\n";
    const root = tree({
      "dozo/relay/worker/src/registry.ts": decl,
      "dozo/relay/worker/src/channel.ts":
        "export class Channel {\n  private used = new Map<string, number>();\n}\n",
      "dozo/relay/worker/test/support.ts": decl,
      "dozo/relay/worker/src/x.test.ts": decl,
      "dozo/cli/dozo.ts": decl,
    });
    assert.deepEqual(
      moduleState(root).map((hit) => hit.split("\t").slice(0, 2).join(": ")),
      [
        "dozo/relay/worker/src/channel.ts: class Channel",
        "dozo/relay/worker/src/registry.ts: module",
      ],
    );
  });

  it("reads the state an anchored brand rule adds to an upstream file, and only that", () => {
    const upstream = "const old = new Map();\nexport function f() {\n  return 1;\n}\n";
    const brand = (rules) => JSON.stringify({ anchored: rules });
    const withRules = (rules, file = "apps/api/src/upstream.ts", text = upstream) =>
      moduleState(
        tree({
          [file]: text,
          "dozo/brand/brand.json": brand(rules),
        }),
      ).map((hit) => hit.replace(/\t/g, " | "));
    // State added at module level, inside a function (a level the line alone would not show).
    assert.deepEqual(
      withRules([
        {
          file: "apps/api/src/upstream.ts",
          find: "  return 1;\n",
          replace: "  let n = 0;\n  return () => n;\n",
        },
        {
          file: "apps/api/src/upstream.ts",
          find: "export function f",
          replace: "const added = {};\nexport function f",
        },
      ]),
      [
        "apps/api/src/upstream.ts | module | const added = {};",
        "apps/api/src/upstream.ts | fn f | let n = 0;",
      ],
    );
    // A rule that adds no state, one that only moves what was there, and a client package.
    assert.deepEqual(
      withRules([{ file: "apps/api/src/upstream.ts", find: "return 1", replace: "return 2" }]),
      [],
    );
    assert.deepEqual(
      withRules([
        {
          file: "apps/api/src/upstream.ts",
          find: "const old = new Map();\n",
          replace: "// gone\nconst old = new Map();\n",
        },
      ]),
      [],
    );
    assert.deepEqual(
      withRules(
        [{ file: "packages/ui-web/src/x.ts", find: "return 1", replace: "return new Map()" }],
        "packages/ui-web/src/x.ts",
      ),
      [],
    );
    // A second copy of a line the file already had counts again; a rule that cannot match adds nothing.
    assert.deepEqual(
      withRules([
        {
          file: "apps/api/src/upstream.ts",
          find: "export function f",
          replace: "const old = new Map();\nexport function f",
        },
      ]),
      ["apps/api/src/upstream.ts | module | const old = new Map();"],
    );
    assert.deepEqual(
      withRules([
        { file: "apps/api/src/upstream.ts", find: "nowhere", replace: "const z = new Map();" },
      ]),
      [],
    );
  });

  it("ignores tests, test support, declaration files, upstream files, client and test-kit packages", () => {
    const decl = "const cache = new Map();\n";
    const root = tree({
      "apps/api/src/dozo-a.test.ts": decl,
      "apps/api/src/dozo-a.test-support.ts": decl,
      "apps/api/src/dozo-a.d.ts": decl,
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

  it("fails (exit 2) when no TypeScript parser can be found", () => {
    const saved = process.env.DOZO_TYPESCRIPT;
    process.env.DOZO_TYPESCRIPT = join(tmpdir(), "no-such-typescript");
    try {
      const { code, text } = run([`--root=${tree({})}`]);
      assert.equal(code, 2);
      assert.match(text, /no TypeScript parser found/);
    } finally {
      process.env.DOZO_TYPESCRIPT = saved;
    }
  });

  it("--write keeps notes of matching rows and marks new hits TODO, which then fail", () => {
    const root = tree(
      { [A]: "const cache = new Map<string, number>();\nlet n = 0;\n" },
      `${ROW}\n`,
    );
    assert.equal(run([`--root=${root}`, "--write"]).code, 0);
    const text = readFileSync(join(root, REVIEWED), "utf8");
    assert.match(text, /counts per user/);
    assert.match(text, /module\tlet n = 0;\tTODO\tTODO/);
    assert.equal(run([`--root=${root}`]).code, 2);
  });

  it("passes the tree as it is", () => {
    const root = join(import.meta.dirname, "../..");
    assert.equal(run([`--root=${root}`]).code, 0);
  });
});
