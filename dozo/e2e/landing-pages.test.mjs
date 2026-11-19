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
const token =
  /<!--[\s\S]*?-->|<\/([a-z][\w-]*)>|<([a-z!][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/gi;

// A link resolved against its page. A page links to its own language's pages (home, privacy, terms),
// so outside the language switcher the language directory is dropped before comparing.
// The language a link to the app or the English switcher link carries (`lang=`) is this page's own,
// so it is dropped here and checked below. No other link may carry one.
function address(value, file, lang, switcher) {
  const href = new URL(value, new URL(file, site + "/")).href;
  let url = switcher && href.endsWith("?lang=en") ? href.slice(0, -"?lang=en".length) : href;
  if (!switcher && href.startsWith("https://dozo.ssilistre.dev/")) {
    const app = new URL(href);
    if (app.searchParams.get("lang") === lang) app.searchParams.delete("lang");
    url = app.href;
  }
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
        [...rawAttrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, key, value = ""]) => [
          key,
          value,
        ]),
      );
      tags.push({ name, attrs });
      const meta = wordedMeta.test(attrs.name ?? attrs.property ?? "");
      const canonical = attrs.rel === "canonical";
      const kept = Object.entries(attrs)
        // Which language the page is (its lang, the current switcher link) is checked further down.
        .filter(([key]) => key !== "aria-current" && !(name === "html" && key === "lang"))
        .filter(([key]) => !(meta && key === "content") && !(canonical && key === "href"))
        .map(
          ([key, value]) =>
            `${key}=${worded.has(key) ? (value.trim() ? "(words)" : "") : key === "href" || key === "src" ? address(value, file, lang, "hreflang" in attrs) : value}`,
        );
      shape.push([name, ...kept].join(" "));
    } else if (text.trim() && !text.startsWith("<!--")) shape.push("#text");
  }
  assert.equal(
    seen,
    html.length,
    `${file}: markup the test cannot read (use double-quoted attributes)`,
  );
  return { tags, shape };
}

// Reports the first line that differs, not two whole pages.
function sameShape(actual, expected, file) {
  const at = expected.findIndex((line, index) => line !== actual[index]);
  const where = at === -1 && actual.length > expected.length ? expected.length : at;
  assert.equal(
    where,
    -1,
    `${file} differs from the English page at:\n  ${actual[where]}\nEnglish has:\n  ${expected[where]}`,
  );
}

const find = (page, name, where) =>
  page.tags.filter((tag) => tag.name === name && where(tag.attrs));
// Every language has the same pages: the landing page and, each in its own directory, the legal pages.
const pages = ["", "privacy/", "terms/", "refunds/"];
const english = Object.fromEntries(
  ["404.html", ...pages.map((page) => `${page}index.html`)].map((file) => [
    file,
    parse(file, "en"),
  ]),
);

test("there is at least one translated landing page", () => {
  assert.ok(languages.includes("tr"));
});

for (const lang of ["en", ...languages]) {
  const prefix = lang === "en" ? "" : `${lang}/`;

  test(`${lang}: same structure as the English pages`, () => {
    for (const [file, page] of Object.entries(english))
      sameShape(parse(prefix + file, lang).shape, page.shape, prefix + file);
  });

  test(`${lang}: names its language and links every other one`, () => {
    assert.equal(find(parse(`${prefix}404.html`, lang), "html", () => true)[0].attrs.lang, lang);
    for (const path of pages) {
      const file = `${prefix}${path}index.html`;
      const page = parse(file, lang);
      const at = (code) => site + pathOf(code) + path;
      assert.equal(find(page, "html", () => true)[0].attrs.lang, lang, file);

      const alternates = Object.fromEntries(
        find(page, "link", (a) => a.rel === "alternate").map((tag) => [
          tag.attrs.hreflang,
          tag.attrs.href,
        ]),
      );
      const expected = Object.fromEntries(["en", ...languages].map((code) => [code, at(code)]));
      assert.deepEqual(alternates, { ...expected, "x-default": at("en") }, file);
      assert.equal(find(page, "link", (a) => a.rel === "canonical")[0].attrs.href, at(lang), file);
      if (!path) {
        assert.equal(find(page, "meta", (a) => a.property === "og:url")[0].attrs.content, at(lang));
        assert.match(
          find(page, "meta", (a) => a.property === "og:locale")[0].attrs.content,
          new RegExp(`^${lang}_`),
        );
      }

      const switcher = find(page, "a", (a) => "hreflang" in a);
      assert.deepEqual(
        switcher.map((tag) => [
          tag.attrs.hreflang,
          tag.attrs.lang,
          new URL(tag.attrs.href, at(lang)).href,
        ]),
        // The English link says the choice, so the server stops sending this visitor to their language.
        ["en", ...languages].map((code) => [
          code,
          code,
          at(code) + (code === "en" && lang !== "en" ? "?lang=en" : ""),
        ]),
        file,
      );
      // The app opens in the language of the page that linked it; a paid plan's card also names
      // the plan and the period the page shows first.
      for (const link of find(page, "a", (a) =>
        a.href?.startsWith("https://dozo.ssilistre.dev/"),
      )) {
        assert.match(
          link.attrs.href,
          new RegExp(
            `^https://dozo\\.ssilistre\\.dev/sign-(in|up)\\?lang=${lang}(&plan=(premium|premium_plus)&period=year)?$`,
          ),
          file,
        );
      }
      assert.deepEqual(
        switcher.filter((tag) => "aria-current" in tag.attrs).map((tag) => tag.attrs.hreflang),
        [lang],
        file,
      );
    }
  });
}

// The plan cards are written by hand on each page; the code that charges and limits them is the source.
test("every language shows the plans the code sells and links sign-up from each one", () => {
  const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const billing = source("packages/contracts/src/billing.ts");
  const plans = source("packages/contracts/src/dozo-plans.ts");
  const sizes = source("dozo/deploy/compose.deploy.yml").match(
    /RAKAZO_COMPUTER_SIZES:-([^}]*)\}/,
  )[1];
  const hourly = Number(
    billing.match(/SANDBOX_HOURLY_COST_MICROS = ([\d_]+);/)[1].replaceAll("_", ""),
  );
  const tier = (id) => billing.match(new RegExp(`\\b${id}: \\{([^}]*)\\}`))[1];
  const number = (terms, key) => Number(terms.match(new RegExp(`${key}: (\\d+)`))[1]);
  const space = (name) => {
    const [, size, unit] = plans.match(
      new RegExp(`const ${name} = \\{[^}]*?sharedSpaceBytes: (\\d+) \\* (1024 \\* )?MB`),
    );
    return unit ? `${size} GB` : `${size} MB`;
  };
  const paid = (id, plan) => {
    const terms = tier(id);
    const [month, year] = [
      number(terms, "monthlyPriceCents") / 100,
      number(terms, "annualPriceCents") / 100,
    ];
    const [, cpus, memory] = sizes.match(
      new RegExp(`\\b${terms.match(/computerSize: "(\w+)"/)[1]}=(\\d+):(\\d+)`),
    );
    const hours = (number(terms, "computerAllowanceCents") * 10_000) / hourly;
    return {
      prices: [month, year / 12, year],
      facts: [`${cpus} vCPU`, `${memory} GB RAM`, String(hours), space(plan)],
    };
  };
  const expected = [paid("pro", "premium"), paid("max", "premiumPlus")];
  // The yearly saving the switch names: the smaller of the two, rounded down.
  const saving = Math.min(
    ...expected.map(({ prices: [month, , year] }) => Math.floor((1 - year / (month * 12)) * 100)),
  );
  for (const lang of ["en", ...languages]) {
    const file = `${lang === "en" ? "" : `${lang}/`}index.html`;
    const html = read(file);
    assert.match(
      html.match(/<span class="save">(.*?)<\/span>/)[1],
      new RegExp(`\\b${saving}\\b`),
      file,
    );
    const [free, ...cards] = html.match(/<article class="tier[^"]*">.*?<\/article>/g);
    assert.match(
      free,
      new RegExp(`href="https://dozo\\.ssilistre\\.dev/sign-up\\?lang=${lang}"`),
      file,
    );
    assert.ok(free.includes(space("free")), file);
    cards.forEach((card, index) => {
      const prices = card
        .match(/<p class="price">.*?<p class="bill">.*?<\/p>/)[0]
        .match(/\d+/g)
        .map(Number);
      assert.deepEqual(prices, expected[index].prices, file);
      for (const fact of expected[index].facts) assert.ok(card.includes(fact), `${file}: ${fact}`);
      assert.match(
        card,
        new RegExp(
          `href="https://dozo\\.ssilistre\\.dev/sign-up\\?lang=${lang}&plan=${["premium", "premium_plus"][index]}&period=year"`,
        ),
        file,
      );
    });
  }
});

// The server remembers a language with one cookie. It may only ever write or act on a language
// that has pages here, and may only send a visitor to that language's own directory.
test("the server remembers only the languages the site has", () => {
  const conf = readFileSync(new URL("../deploy/site.nginx.conf", import.meta.url), "utf8");
  const cookies = [...conf.matchAll(/"dozo_lang=([^;"]*);([^"]*)"/g)];
  assert.deepEqual(cookies.map(([, code]) => code).sort(), ["en", ...languages].sort());
  for (const [, , flags] of cookies)
    assert.equal(flags, " Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax");
  const home = conf.match(/map "\$cookie_dozo_lang \$arg_lang" \$dozo_lang_home \{([^}]*)\}/)[1];
  assert.deepEqual(
    [...home.matchAll(/^\s*"(\S*) " "([^"]*)";$/gm)].map(([, code, target]) => [code, target]),
    languages.map((code) => [code, pathOf(code)]),
  );
  assert.match(conf, /if \(\$dozo_lang_home\) \{ return 302 \$dozo_lang_home; \}/);
  assert.equal([...conf.matchAll(/return 30\d/g)].length, 1);
  for (const lang of ["en", ...languages]) {
    assert.match(
      read(`${lang === "en" ? "" : `${lang}/`}privacy/index.html`),
      /sets one cookie|tek bir çerez/,
    );
  }
});
