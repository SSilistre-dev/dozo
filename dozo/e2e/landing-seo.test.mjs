// What search and answer engines read from the landing site: robots.txt, sitemap.xml, llms.txt,
// the head of the home pages and their JSON-LD. Offline, against the files in dozo/landing/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../landing/", import.meta.url);
const read = (path) => readFileSync(new URL(path, dir), "utf8");
const nginx = readFileSync(new URL("../deploy/site.nginx.conf", import.meta.url), "utf8");
const pages = { en: "index.html", tr: "tr/index.html" };
const home = { en: "https://dozo.bot/", tr: "https://dozo.bot/tr/" };
const support = { en: "https://dozo.bot/support/", tr: "https://dozo.bot/tr/support/" };

const jsonLd = (file) => {
  const blocks = [...read(file).matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)];
  assert.equal(blocks.length, 1, `${file}: exactly one JSON-LD block`);
  return JSON.parse(blocks[0][1]);
};

test("robots.txt opens the site, names the AI crawlers and points to the sitemap", () => {
  const robots = read("robots.txt");
  assert.doesNotMatch(robots, /^\s*Disallow:\s*\/\s*$/m);
  assert.match(robots, /^Sitemap: https:\/\/dozo\.bot\/sitemap\.xml$/m);
  for (const agent of [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-SearchBot",
    "Claude-User",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "Applebot-Extended",
  ])
    assert.match(robots, new RegExp(`^User-agent: ${agent}$`, "m"), agent);
});

test("the server does not send noindex, and redirects www to the bare domain", () => {
  assert.doesNotMatch(nginx, /X-Robots-Tag/);
  assert.match(nginx, /if \(\$host = www\.dozo\.bot\) \{ return 301 https:\/\/dozo\.bot\$request_uri; \}/);
  assert.match(nginx, /script-src 'self';/);
});

test("the sitemap lists the indexable pages with their alternates, and nothing else", () => {
  const xml = read("sitemap.xml");
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  // The comparison pages (vs/data.json), each in both languages; landing-vs.test.mjs holds the rest.
  const vs = JSON.parse(read("vs/data.json")).products.flatMap(({ slug }) => [
    `https://dozo.bot/vs/${slug}/`,
    `https://dozo.bot/tr/vs/${slug}/`,
  ]);
  assert.ok(vs.length > 0);
  assert.deepEqual(locs, [home.en, home.tr, support.en, support.tr, ...vs]);
  const alternates = (xml.match(/hreflang="[^"]+" href="[^"]+"/g) ?? []).length;
  assert.equal(alternates, 3 * locs.length);
  for (const [lang, file] of Object.entries(pages)) {
    const html = read(file);
    assert.match(html, new RegExp(`<link rel="canonical" href="${home[lang]}">`));
    assert.doesNotMatch(html, /name="robots"/, `${file} must be indexable`);
  }
  for (const [lang, file] of [
    ["en", "support/index.html"],
    ["tr", "tr/support/index.html"],
  ]) {
    const html = read(file);
    assert.match(html, new RegExp(`<link rel="canonical" href="${support[lang]}">`));
    assert.doesNotMatch(html, /name="robots"/, `${file} must be indexable`);
  }
});

test("legal and 404 pages stay out of the index and out of the sitemap", () => {
  const xml = read("sitemap.xml");
  for (const file of [
    "privacy/index.html",
    "terms/index.html",
    "refunds/index.html",
    "tr/privacy/index.html",
    "tr/terms/index.html",
    "tr/refunds/index.html",
    "404.html",
    "tr/404.html",
  ]) {
    assert.match(read(file), /<meta name="robots" content="noindex">/, file);
    assert.ok(!xml.includes(file.replace("index.html", "")), file);
  }
});

test("each home page has its own title and description, and states what Dozo is", () => {
  const seen = new Set();
  for (const [lang, file] of Object.entries(pages)) {
    const html = read(file);
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    const desc = html.match(/<meta name="description" content="([^"]*)"/)[1];
    assert.ok(title.length <= 65, `${file}: title is ${title.length} characters`);
    assert.ok(desc.length >= 80 && desc.length <= 175, `${file}: description is ${desc.length}`);
    assert.ok(!seen.has(title) && !seen.has(desc), `${lang} repeats another language's text`);
    seen.add(title).add(desc);
    assert.match(html, /<p class="lede">Dozo(,| is) /, `${file}: the lede names the product`);
    assert.doesNotMatch(title + desc, /open[- ]source/i);
  }
});

test("JSON-LD: Organization, WebSite and SoftwareApplication, with the page's own prices", () => {
  for (const [lang, file] of Object.entries(pages)) {
    const data = jsonLd(file);
    assert.equal(data["@context"], "https://schema.org");
    const byType = Object.fromEntries(data["@graph"].map((node) => [node["@type"], node]));
    assert.deepEqual(Object.keys(byType).sort(), ["Organization", "SoftwareApplication", "WebSite"]);
    assert.equal(byType.WebSite.inLanguage, lang);
    assert.equal(byType.SoftwareApplication.url, home[lang]);
    assert.equal(
      byType.SoftwareApplication.description,
      read(file).match(/<meta name="description" content="([^"]*)"/)[1],
    );
    // Nothing the page does not show: no ratings, reviews or FAQ.
    assert.doesNotMatch(JSON.stringify(data), /aggregateRating|"review"|FAQPage/);
    const tiers = [...read(file).matchAll(/<article class="tier[^"]*"><h3>([^<]*)<\/h3>.*?<b>(?:\$(\d+)|(\d+) \$)<\/b>/g)];
    assert.equal(tiers.length, 2);
    const offers = byType.SoftwareApplication.offers;
    assert.deepEqual(
      offers.map((o) => [o.name, o.price, o.priceCurrency]),
      tiers.map(([, name, usd, tr]) => [name, usd ?? tr, "USD"]),
    );
    // Free is open to all; a plan whose card says it is coming soon is a pre-order, and no link
    // names a plan.
    const cards = read(file).match(/<article class="tier[^"]*">.*?<\/article>/g);
    offers.forEach((offer, index) => {
      const soon = cards[index].includes('class="pill sm soon"');
      assert.equal(offer.availability, soon ? "https://schema.org/PreOrder" : undefined, offer.name);
      assert.equal(offer.url, "https://app.dozo.bot/sign-up", offer.name);
    });
  }
});

test("llms.txt states the plans the page shows and calls Dozo source available", () => {
  const llms = read("llms.txt");
  assert.match(llms, /^# Dozo$/m);
  assert.match(llms, /source available/i);
  assert.doesNotMatch(llms.replace(/It is not open source\./, ""), /open[- ]source/i);
  const html = read("index.html");
  const prices = (s) => [...s.matchAll(/\$\d+/g)].map((m) => m[0]);
  const plans = llms.slice(llms.indexOf("## Plans"), llms.indexOf("## Links"));
  const shown = new Set(prices(html.slice(html.indexOf('id="plans"'))));
  for (const price of new Set(prices(plans))) assert.ok(shown.has(price), `${price} is not on the page`);
  // The computers each paid plan allows, as the code sets them.
  const code = readFileSync(new URL("../../packages/contracts/src/dozo-plans.ts", import.meta.url), "utf8");
  const computers = (name) => Number(code.match(new RegExp(`const ${name} = \\{[^}]*?computers: (\\d+)`))[1]);
  const line = (plan) => plans.split("\n").find((l) => l.startsWith(`- ${plan}:`));
  assert.equal(computers("free"), 0);
  assert.doesNotMatch(line("Free"), /vCPU/);
  assert.equal(computers("premium"), 1);
  assert.match(line("Premium"), /One shared computer/);
  // Not on sale, as the page's card says; Premium Plus is not offered at all.
  assert.match(line("Premium"), /coming soon/);
  assert.equal(line("Premium Plus"), undefined);
  for (const url of llms.match(/https:\/\/[^\s)]+/g)) assert.doesNotMatch(url, /[.,]$/);
});
