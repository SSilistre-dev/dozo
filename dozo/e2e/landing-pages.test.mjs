// The landing page is one hand-kept HTML file per language (dozo/landing/index.html and
// dozo/landing/<lang>/index.html), with no build step. This holds them to one structure: the same
// tags, attributes, link targets and text slots, differing only in the words.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../landing/", import.meta.url);
const site = "https://dozo-site.ssilistre.dev";
const read = (path) => readFileSync(new URL(path, dir), "utf8");
const languages = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const pathOf = (lang) => (lang === "en" ? "/" : `/${lang}/`);

// Attributes that hold words, plus the two that say which language the page itself is.
const worded = new Set(["aria-label", "data-full", "data-wait", "data-done", "data-ok", "aria-current"]);
const wordedMeta = /^(description|og:title|og:description|og:locale|og:locale:alternate|og:url)$/;
const token = /<!--[\s\S]*?-->|<\/([a-z][\w-]*)>|<([a-z!][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/gi;

function parse(file, base) {
  const html = read(file);
  const tags = [];
  const shape = [];
  let seen = 0;
  for (const match of html.matchAll(token)) {
    seen += match[0].length;
    const [text, closing, name, rawAttrs] = match;
    if (closing) shape.push(`/${closing}`);
    else if (name) {
      const attrs = Object.fromEntries(
        [...rawAttrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, key, value = ""]) => [key, value]),
      );
      tags.push({ name, attrs });
      const meta = wordedMeta.test(attrs.name ?? attrs.property ?? "");
      const canonical = attrs.rel === "canonical";
      const kept = Object.entries(attrs)
        .filter(([key]) => !worded.has(key) && !(name === "html" && key === "lang"))
        .filter(([key]) => !(meta && key === "content") && !(canonical && key === "href"))
        // Addresses are compared resolved; a link into the page itself (#main) counts as the same target.
        .map(([key, value]) => `${key}=${key === "href" || key === "src" ? new URL(value, site + base).href.replace(`${base}#`, "/#") : value}`);
      shape.push([name, ...kept].join(" "));
    } else if (text.trim() && !text.startsWith("<!--")) shape.push("#text");
  }
  assert.equal(seen, html.length, `${file}: markup the test cannot read (use double-quoted attributes)`);
  return { tags, shape };
}

// Reports the first line that differs, not two whole pages.
function sameShape(actual, expected, file) {
  const at = expected.findIndex((line, index) => line !== actual[index]);
  const where = at === -1 && actual.length > expected.length ? expected.length : at;
  assert.equal(where, -1, `${file} differs from the English page at:\n  ${actual[where]}\nEnglish has:\n  ${expected[where]}`);
}

const find = (page, name, where) => page.tags.filter((tag) => tag.name === name && where(tag.attrs));
const english = { index: parse("index.html", "/"), missing: parse("404.html", "/") };

test("there is at least one translated landing page", () => {
  assert.ok(languages.includes("tr"));
});

for (const lang of ["en", ...languages]) {
  const base = pathOf(lang);
  const prefix = lang === "en" ? "" : `${lang}/`;

  test(`${lang}: same structure as the English page`, () => {
    sameShape(parse(`${prefix}index.html`, base).shape, english.index.shape, `${prefix}index.html`);
    // The 404 page links to its own language's home page, so that one target is put back first.
    const missing = parse(`${prefix}404.html`, base).shape.map((line) => line.replace(site + base, `${site}/`));
    sameShape(missing, english.missing.shape, `${prefix}404.html`);
  });

  test(`${lang}: names its language and links every other one`, () => {
    const page = parse(`${prefix}index.html`, base);
    assert.equal(find(page, "html", () => true)[0].attrs.lang, lang);
    assert.equal(find(parse(`${prefix}404.html`, base), "html", () => true)[0].attrs.lang, lang);

    const alternates = Object.fromEntries(
      find(page, "link", (a) => a.rel === "alternate").map((tag) => [tag.attrs.hreflang, tag.attrs.href]),
    );
    const expected = Object.fromEntries(["en", ...languages].map((code) => [code, site + pathOf(code)]));
    assert.deepEqual(alternates, { ...expected, "x-default": `${site}/` });
    assert.equal(find(page, "link", (a) => a.rel === "canonical")[0].attrs.href, site + base);
    assert.equal(find(page, "meta", (a) => a.property === "og:url")[0].attrs.content, site + base);
    assert.match(find(page, "meta", (a) => a.property === "og:locale")[0].attrs.content, new RegExp(`^${lang}_`));

    const switcher = find(page, "a", (a) => "hreflang" in a);
    assert.deepEqual(
      switcher.map((tag) => [tag.attrs.hreflang, tag.attrs.lang, new URL(tag.attrs.href, site + base).href]),
      ["en", ...languages].map((code) => [code, code, site + pathOf(code)]),
    );
    assert.deepEqual(
      switcher.filter((tag) => "aria-current" in tag.attrs).map((tag) => tag.attrs.hreflang),
      [lang],
    );
  });
}
