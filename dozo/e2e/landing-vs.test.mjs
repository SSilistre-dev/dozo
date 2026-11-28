// The "Dozo vs X" pages (dozo/landing/vs/<slug>/ and dozo/landing/tr/vs/<slug>/) are written by
// dozo/landing/vs/build.mjs from dozo/landing/vs/data.json, and the output is committed. This holds
// the committed tree to the generator, and every claim about another product to a source on that
// product's own pages that is not too old to trust.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { data, render, rowKeys } from "../landing/vs/build.mjs";

const dir = new URL("../landing/", import.meta.url);
const read = (path) => readFileSync(new URL(path, dir), "utf8");
const site = "https://dozo.bot";
const day = 24 * 60 * 60 * 1000;
const maxAgeDays = 180;
const output = render();
const page = (lang, slug) => `${lang === "en" ? "" : `${lang}/`}vs/${slug}/index.html`;

test("the committed pages, sitemap block and home links are what the generator writes", () => {
  for (const [path, html] of output)
    assert.equal(read(path), html, `${path} is out of date: run node dozo/landing/vs/build.mjs`);
  const slugs = data.products.map((product) => product.slug).sort();
  for (const root of ["vs/", "tr/vs/"]) {
    const dirs = readdirSync(new URL(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(dirs, slugs, `${root}: a page without data, or data without a page`);
  }
  // No index of the comparisons: each page is reached from the home page's links.
  assert.ok(!existsSync(new URL("vs/index.html", dir)));
  assert.ok(!existsSync(new URL("tr/vs/index.html", dir)));
});

test("each product has a slug, a name, an official address and at least four sourced rows", () => {
  const seen = new Set();
  for (const product of data.products) {
    const { slug, name, officialUrl, summary, rows, sources } = product;
    assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, slug);
    assert.ok(!seen.has(slug), `${slug} twice`);
    seen.add(slug);
    assert.ok(name.trim(), slug);
    assert.match(officialUrl, /^https:\/\//, slug);
    assert.ok(summary.en.trim() && summary.tr.trim(), `${slug}: summary in both languages`);
    // A page with fewer verified rows says too little to be fair to either side: leave it out.
    assert.ok(rows.length >= 4, `${slug}: ${rows.length} rows; fewer than 4 is not published`);
    const keys = rows.map((row) => row.key);
    assert.deepEqual(
      keys,
      rowKeys.filter((key) => keys.includes(key)),
      `${slug}: rows are known keys, each once, in the table's order`,
    );
    for (const row of rows) {
      assert.ok(row.en.trim() && row.tr.trim(), `${slug} ${row.key}: text in both languages`);
      // A row may rest on several of the product's pages; it needs at least one.
      assert.ok(Array.isArray(row.sources) && row.sources.length > 0, `${slug} ${row.key}: no source`);
      for (const source of row.sources) {
        assert.match(source, /^https:\/\//, `${slug} ${row.key}: ${source}`);
        assert.ok(sources.includes(source), `${slug} ${row.key}: ${source} not in sources`);
      }
    }
    for (const source of sources) {
      assert.ok(
        rows.some((row) => row.sources.includes(source)),
        `${slug}: ${source} backs no row`,
      );
      // A competitor's comparison page is never a source for a third product.
      if (slug !== "turnstone") assert.doesNotMatch(source, /myturnstone\.ai/, slug);
    }
  }
  for (const key of rowKeys) {
    assert.ok(data.labels[key].en && data.labels[key].tr, key);
    assert.ok(data.dozo[key].en && data.dozo[key].tr, key);
  }
});

test("a page whose facts were checked more than 180 days ago fails", () => {
  for (const { slug, checked } of data.products) {
    assert.match(checked, /^\d{4}-\d{2}-\d{2}$/, slug);
    const age = (Date.now() - Date.parse(`${checked}T00:00:00Z`)) / day;
    assert.ok(age > -1, `${slug}: checked on ${checked}, a date in the future`);
    assert.ok(
      age <= maxAgeDays,
      `${slug}: checked on ${checked}, more than ${maxAgeDays} days ago. Re-verify every row against its official pages and update "checked", or remove the page`,
    );
  }
});

test("each page links every row's source, says when it was checked and where to report a mistake", () => {
  assert.ok(
    read("privacy/index.html").includes(`mailto:${data.contact}`),
    `${data.contact} is not the contact address the legal pages publish`,
  );
  for (const product of data.products) {
    for (const lang of ["en", "tr"]) {
      const file = page(lang, product.slug);
      const html = read(file);
      assert.match(html, new RegExp(`<h1>Dozo vs ${product.name}</h1>`), file);
      const list = html.slice(html.indexOf("</table>"));
      for (const source of product.sources)
        assert.ok(
          list.includes(`<a href="${source}" rel="noopener nofollow">`),
          `${file}: ${source}`,
        );
      assert.equal(
        (html.match(/<tbody>/g) ?? []).length,
        product.rows.length,
        `${file}: one table row per sourced row`,
      );
      assert.ok(html.includes(`mailto:${data.contact}`), file);
    }
  }
});

test("the English and Turkish page of a product have the same structure", () => {
  // Which language link is the current one differs by design; the switcher is checked above.
  const shape = (html) =>
    [...html.matchAll(/<(\/?[a-z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)].map(
      ([, name, attrs]) =>
        [name, ...[...attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
          .filter(([, key]) => key !== "aria-current")
          .map(([, key, value = ""]) =>
            ["class", "rel", "scope", "colspan", "id", "type"].includes(key) ? `${key}=${value}` : key,
          )].join(" "),
    );
  for (const { slug } of data.products) {
    const en = shape(read(page("en", slug)));
    const tr = shape(read(page("tr", slug)));
    const at = en.findIndex((line, index) => line !== tr[index]);
    assert.equal(at === -1 && tr.length !== en.length ? en.length : at, -1, `${slug}: ${en[at]} / ${tr[at]}`);
  }
});

test("each page is indexable, with its canonical, its alternates and its own words", () => {
  for (const { slug } of data.products) {
    const at = { en: `${site}/vs/${slug}/`, tr: `${site}/tr/vs/${slug}/` };
    const seen = new Set();
    for (const lang of ["en", "tr"]) {
      const file = page(lang, slug);
      const html = read(file);
      assert.match(html, new RegExp(`<html lang="${lang}">`), file);
      assert.doesNotMatch(html, /name="robots"/, `${file} must be indexable`);
      assert.doesNotMatch(html, /application\/ld\+json/, `${file}: no JSON-LD`);
      assert.match(html, new RegExp(`<link rel="canonical" href="${at[lang]}">`), file);
      assert.match(html, new RegExp(`<meta property="og:url" content="${at[lang]}">`), file);
      for (const [code, href] of [...Object.entries(at), ["x-default", at.en]])
        assert.match(html, new RegExp(`<link rel="alternate" hreflang="${code}" href="${href}">`), file);
      // The switcher opens the same comparison in the other language; the English link says the choice.
      const switcher = [...html.matchAll(/<a class="link" href="([^"]*)" lang="(\w+)" hreflang="\w+" aria-label="[^"]+"( aria-current="page")?>/g)];
      assert.deepEqual(
        switcher.map(([, href, code, current]) => [code, new URL(href, at[lang]).href, Boolean(current)]),
        [
          ["en", at.en + (lang === "en" ? "" : "?lang=en"), lang === "en"],
          ["tr", at.tr, lang === "tr"],
        ],
        file,
      );
      const title = html.match(/<title>([^<]*)<\/title>/)[1];
      const desc = html.match(/<meta name="description" content="([^"]*)"/)[1];
      assert.ok(title.length <= 65, `${file}: title is ${title.length} characters`);
      assert.ok(desc.length >= 80 && desc.length <= 175, `${file}: description is ${desc.length}`);
      assert.ok(!seen.has(title) && !seen.has(desc), `${file} repeats the other language`);
      seen.add(title).add(desc);
      for (const key of ["og:title", "og:description", "og:image", "og:locale"])
        assert.match(html, new RegExp(`<meta property="${key}" content="[^"]+">`), `${file}: ${key}`);
    }
  }
});

test("no comparison page calls Dozo open source", () => {
  const claim = /open[\s-]?source|açık[\s-]?kayna|kayna(k|ğı)(\s+kodu)?\s+açık/i;
  for (const { slug } of data.products)
    for (const lang of ["en", "tr"]) assert.doesNotMatch(read(page(lang, slug)), claim, page(lang, slug));
  for (const lang of ["en", "tr"]) assert.doesNotMatch(data.dozo.source[lang], claim);
});
