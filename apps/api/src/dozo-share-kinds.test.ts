import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DOZO_SHARE_KINDS } from "./dozo-share-kinds.js";

/**
 * The isolation matrix makes one create case per kind in `SHARE_KIND_TARGETS` (a package cannot
 * import the server's map, so the two are compared here). A kind with no entry there is never tried
 * against another member's target, and an entry with no kind tries nothing.
 */
it("has a matrix case for every registered share link kind, and no other", () => {
  const source = readFileSync(
    new URL("../../../packages/testkit/src/dozo-isolation-inputs.test-support.ts", import.meta.url),
    "utf8",
  );
  const block = /export const SHARE_KIND_TARGETS[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  const matrixKinds = [...block.matchAll(/^\s*([a-z][a-z0-9-]*):/gm)].map((match) => match[1]);
  expect(matrixKinds.sort()).toEqual(Object.keys(DOZO_SHARE_KINDS).sort());
});
