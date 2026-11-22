import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  count,
  exclude,
  include,
  supportExports,
} from "./ratchets/dozo-no-test-support-imports.mjs";

const lines = (text, known = new Set()) =>
  count(text, "apps/api/src/x.ts", known).map((hit) => hit.line);

test("counts every way product code can load a test-support module", () => {
  const text = `import { fake } from "./fake.test-support.js";
import type { Shape } from "../shape.test-support";
export { helper } from "./helper.test-support.ts";
import "./side-effect.test-support.js";
const lazy = await import("./lazy.test-support.js");
const old = require('./old.test-support.cjs');
import { deferred } from "@rakazo/core/test-async";`;
  assert.deepEqual(lines(text, new Set(["@rakazo/core/test-async"])), [1, 2, 3, 4, 5, 6, 7]);
});

test("ignores regular modules, names that only look alike, and prose", () => {
  const text = `import { retry } from "@rakazo/core";
import { box } from "./sandbox-test-support.js";
import { support } from "./test-support-ui.js";
// Tests swap this for \`novita.test-support.ts\`, never import "./x.test-support.js" here.
/* see import("./y.test-support.js") */
 * from "./z.test-support.js"
const route = "/api/auth/*"; const next = await import("./real.js");`;
  assert.deepEqual(lines(text, new Set(["@rakazo/core/test-async"])), []);
});

test("finds package exports that point at a test-support file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-support-imports-"));
  after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, "packages/core"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/core/package.json"),
    JSON.stringify({
      name: "@x/core",
      exports: {
        ".": "./src/index.ts",
        "./test-async": {
          types: "./src/async.test-support.ts",
          default: "./src/async.test-support.ts",
        },
      },
    }),
  );
  assert.deepEqual([...supportExports(root)], ["@x/core/test-async"]);
});

test("applies to product code in apps, packages and infra, not to tests", () => {
  assert.ok(include.some((glob) => glob.startsWith("{apps,packages,infra}/")));
  for (const glob of ["**/*.{test,spec}.*", "**/*.test-support.*"])
    assert.ok(exclude.includes(glob));
});
