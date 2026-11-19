// Offline tests of canli/budgets.ts (`make olc`): the live run's budgets, verdict line, dead-link
// and cache-header checks. The file has no imports, so Node strips its types and no browser is needed.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { budgetVerdicts, cachedForGood, deadLinks, verdictLine } from "./canli/budgets.ts";

test("verdictLine: pass only with at least one scenario", () => {
  assert.equal(verdictLine(true, 12), "CANLI: PASS (12 senaryo)");
  assert.equal(verdictLine(false, 12), "CANLI: FAIL (12 senaryo)");
  assert.equal(verdictLine(true, 0), "CANLI: FAIL (0 senaryo)");
});

test("budgetVerdicts: last value wins, over budget is flagged, unknown keys have no budget", () => {
  const rows = budgetVerdicts([
    { key: "appsDialog", value: 900 },
    { key: "appsDialog", value: 120.4 },
    { key: "modelsResponses", value: 9 },
    { key: "somethingNew", value: 5 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.key, r.value, r.over]),
    [
      ["appsDialog", 120, false],
      ["modelsResponses", 9, true],
      ["somethingNew", 5, false],
    ],
  );
});

test("deadLinks: placeholder domain and repo owner, each once", () => {
  assert.deepEqual(
    deadLinks([
      "https://dozo.example/docs",
      "https://github.com/OWNER/dozo",
      "https://dozo.example/docs",
      "https://github.com/SomeOrg/dozo",
      "/app/settings",
    ]),
    ["https://dozo.example/docs", "https://github.com/OWNER/dozo"],
  );
});

test("cachedForGood: public, immutable, a year or more", () => {
  assert.equal(cachedForGood("public, max-age=31536000, immutable"), true);
  assert.equal(cachedForGood("public, max-age=3600, immutable"), false);
  assert.equal(cachedForGood("public, max-age=31536000"), false);
  assert.equal(cachedForGood("no-cache"), false);
  assert.equal(cachedForGood(undefined), false);
});
