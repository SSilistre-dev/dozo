// Dozo's own files are under the Elastic License 2.0 (dozo/NOTICE), so Dozo is "source available",
// not "open source". This holds the pages a visitor reads first to that wording.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const claim = /open[\s-]?source|açık[\s-]?kayna/i;

// The sentences (split at tags and sentence ends) that make the claim. One that names upstream and
// not Dozo is attribution, not a claim about Dozo.
export const openSourceClaims = (text) =>
  text
    .split(/[<>.!?\n]/)
    .filter((part) => claim.test(part) && !(/rakazo/i.test(part) && !/dozo/i.test(part)))
    .map((part) => part.trim());

test("the check finds the claim in both languages and lets upstream's attribution through", () => {
  assert.deepEqual(openSourceClaims("<h2>Open source.</h2><p>Run it.</p>"), ["Open source"]);
  assert.deepEqual(openSourceClaims("Dozo is open-source software"), [
    "Dozo is open-source software",
  ]);
  assert.deepEqual(openSourceClaims("<p>Açık kaynak, Apache-2.0</p>"), ["Açık kaynak, Apache-2"]);
  assert.deepEqual(openSourceClaims("Dozo açık kaynaklıdır."), ["Dozo açık kaynaklıdır"]);
  assert.deepEqual(
    openSourceClaims("A fork of Rakazo, an open source project. Dozo is open source."),
    ["Dozo is open source"],
  );
  assert.deepEqual(openSourceClaims("Dozo is open source, like Rakazo."), [
    "Dozo is open source, like Rakazo",
  ]);
  assert.deepEqual(
    openSourceClaims("Source available. Kaynağı açık. The source code is here."),
    [],
  );
});

test("the landing pages and the repository front page do not call Dozo open source", () => {
  const landing = readdirSync(new URL("dozo/landing/", root), { recursive: true })
    .filter((file) => file.endsWith(".html"))
    .map((file) => `dozo/landing/${file}`);
  assert.ok(landing.length >= 2, "landing pages not found");
  for (const file of [...landing, ".github/README.md"]) {
    assert.deepEqual(openSourceClaims(readFileSync(new URL(file, root), "utf8")), [], file);
  }
});
