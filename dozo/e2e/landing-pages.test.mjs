// The landing site is hand-kept HTML, one copy per language (dozo/landing/ and dozo/landing/<lang>/),
// with no build step. This holds each language to the English pages' structure: the same tags,
// attributes, link targets and text slots, differing only in the words.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../landing/", import.meta.url);
const site = "https://dozo-site.ssilistre.dev";
const read = (path) => readFileSync(new URL(path, dir), "utf8");
const languages = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z]{2}$/.test(entry.name))
  .map((entry) => entry.name);
const pathOf = (lang) => (lang === "en" ? "/" : `/${lang}/`);

// Attributes that hold words: each page must have them, filled in, but the value is its own.
const worded = new Set(["aria-label", "data-full", "data-wait", "data-done", "data-ok"]);
const wordedMeta = /^(description|og:title|og:description|og:locale|og:locale:alternate|og:url)$/;
const token = /<!--[\s\S]*?-->|<\/([a-z][\w-]*)>|<([a-z!][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/gi;

// A link resolved against its page. A page links to its own language's pages (home, privacy, terms),
// so outside the language switcher the language directory is dropped before comparing.
function address(value, file, lang, switcher) {
  const url = new URL(value, new URL(file, site + "/")).href;
  const own = site + pathOf(lang);
  return switcher || !url.startsWith(own) ? url : `${site}/${url.slice(own.length)}`;
}

function parse(file, lang) {
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
        // Which language the page is (its lang, the current switcher link) is checked further down.
        .filter(([key]) => key !== "aria-current" && !(name === "html" && key === "lang"))
        .filter(([key]) => !(meta && key === "content") && !(canonical && key === "href"))
        .map(([key, value]) => `${key}=${worded.has(key) ? (value.trim() ? "(words)" : "") : key === "href" || key === "src" ? address(value, file, lang, "hreflang" in attrs) : value}`);
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
// Every language has the same pages: the landing page and, each in its own directory, the legal pages.
const pages = ["", "privacy/", "terms/", "refunds/"];
const english = Object.fromEntries(["404.html", ...pages.map((page) => `${page}index.html`)].map((file) => [file, parse(file, "en")]));

test("there is at least one translated landing page", () => {
  assert.ok(languages.includes("tr"));
});

for (const lang of ["en", ...languages]) {
  const prefix = lang === "en" ? "" : `${lang}/`;

  test(`${lang}: same structure as the English pages`, () => {
    for (const [file, page] of Object.entries(english)) sameShape(parse(prefix + file, lang).shape, page.shape, prefix + file);
  });

  test(`${lang}: names its language and links every other one`, () => {
    assert.equal(find(parse(`${prefix}404.html`, lang), "html", () => true)[0].attrs.lang, lang);
    for (const path of pages) {
      const file = `${prefix}${path}index.html`;
      const page = parse(file, lang);
      const at = (code) => site + pathOf(code) + path;
      assert.equal(find(page, "html", () => true)[0].attrs.lang, lang, file);

      const alternates = Object.fromEntries(
        find(page, "link", (a) => a.rel === "alternate").map((tag) => [tag.attrs.hreflang, tag.attrs.href]),
      );
      const expected = Object.fromEntries(["en", ...languages].map((code) => [code, at(code)]));
      assert.deepEqual(alternates, { ...expected, "x-default": at("en") }, file);
      assert.equal(find(page, "link", (a) => a.rel === "canonical")[0].attrs.href, at(lang), file);
      if (!path) {
        assert.equal(find(page, "meta", (a) => a.property === "og:url")[0].attrs.content, at(lang));
        assert.match(find(page, "meta", (a) => a.property === "og:locale")[0].attrs.content, new RegExp(`^${lang}_`));
      }

      const switcher = find(page, "a", (a) => "hreflang" in a);
      assert.deepEqual(
        switcher.map((tag) => [tag.attrs.hreflang, tag.attrs.lang, new URL(tag.attrs.href, at(lang)).href]),
        ["en", ...languages].map((code) => [code, code, at(code)]),
        file,
      );
      assert.deepEqual(
        switcher.filter((tag) => "aria-current" in tag.attrs).map((tag) => tag.attrs.hreflang),
        [lang],
        file,
      );
    }
  });
}

// The prices are written by hand on each page; the code that charges them is the source.
test("every language shows the prices the code charges and links sign-up from each hosted plan", () => {
  const billing = readFileSync(new URL("../../packages/contracts/src/billing.ts", import.meta.url), "utf8");
  const charged = (tier) => {
    const [, month, year] = billing.match(new RegExp(`\\b${tier}: \\{[^}]*?monthlyPriceCents: (\\d+),\\s*annualPriceCents: (\\d+)`));
    return [month / 100, year / 100, year / 1200];
  };
  for (const lang of ["en", ...languages]) {
    const file = `${lang === "en" ? "" : `${lang}/`}index.html`;
    const [free, ...paid] = read(file).match(/<article class="tier">.*?<\/article>/g);
    const shown = paid.map((card) => [...card.matchAll(/<span class="status">(.*?)<\/span>/g)].flatMap(([, words]) => words.match(/\d+/g).map(Number)));
    assert.deepEqual(shown, [charged("pro"), charged("max")], file);
    for (const card of [free, ...paid]) assert.match(card, /href="https:\/\/dozo\.ssilistre\.dev\/sign-up"/, file);
  }
});
