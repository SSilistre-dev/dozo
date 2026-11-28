// Writes the "Dozo vs X" pages from data.json: vs/<slug>/index.html and tr/vs/<slug>/index.html, the
// block of them in sitemap.xml and the links in the home pages' "Compare." section (each between its
// marker comments). The output is committed; dozo/e2e/landing-vs.test.mjs fails when it is stale.
// Run: docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/r" -w /r node:24.22-slim node dozo/landing/vs/build.mjs
import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, dir), "utf8");
const site = "https://dozo.bot";
const repo = "https://github.com/SSilistre-dev/dozo";

export const data = JSON.parse(read("vs/data.json"));
export const rowKeys = ["where", "computer", "asks", "source", "selfHost", "price"];

const text = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attr = (value) => text(value).replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const months = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  tr: ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
};
// The Turkish locative after a year follows how the year is read aloud: 2026'da, 2027'de, 2030'da.
const locative = (year) => {
  const ones = ["", "de", "de", "te", "te", "te", "da", "de", "de", "da"][year % 10];
  const tens = ["de", "da", "de", "da", "ta", "de", "da", "de", "de", "da"][Math.floor(year / 10) % 10];
  return ones || (year % 100 ? tens : "de");
};
const date = (iso, lang) => {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${months[lang][month - 1]} ${year}`;
};

const words = {
  en: {
    locale: "en_US",
    other: "tr_TR",
    title: (name) => `Dozo vs ${name}`,
    description: (name) =>
      `Dozo and ${name} side by side. Everything said about ${name} here comes from its own official pages, with the date it was checked.`,
    checked: (iso) => `Checked on ${date(iso, "en")}`,
    sources: "Sources",
    wrong: "Something wrong?",
    trademark: (name) => `${name} is a trademark of its owner.`,
    compare: "Compare.",
    skip: "Skip to content",
    menu: "Main",
    theme: "Switch theme",
    signIn: "Sign in",
    download: "Download",
    selfHost: "Self-host for free",
    top: "Dozo, back to top",
    footer: "Footer",
    links: ["Self-host", "GitHub", "Licence", "Privacy", "Terms", "Refunds"],
    credit: "Source available. Elastic License 2.0 and Apache-2.0",
  },
  tr: {
    locale: "tr_TR",
    other: "en_US",
    title: (name) => `Dozo vs ${name} karşılaştırması`,
    description: (name) =>
      `Dozo ile ${name} yan yana. Burada ${name} hakkında yazılan her şey kendi resmi sayfalarından alınmıştır ve kontrol tarihiyle verilir.`,
    checked: (iso) => `${date(iso, "tr")}'${locative(Number(iso.slice(0, 4)))} kontrol edildi`,
    sources: "Kaynaklar",
    wrong: "Yanlış bir bilgi mi var?",
    trademark: (name) => `${name}, sahibinin ticari markasıdır.`,
    compare: "Karşılaştır.",
    skip: "İçeriğe geç",
    menu: "Ana menü",
    theme: "Temayı değiştir",
    signIn: "Giriş yap",
    download: "İndirin",
    selfHost: "Kendi sunucunuza ücretsiz kurun",
    top: "Dozo, başa dön",
    footer: "Alt bilgi",
    links: ["Kendiniz barındırın", "GitHub", "Lisans", "Gizlilik", "Koşullar", "İade"],
    credit: "Kaynak kodu erişilebilir. Elastic License 2.0 ve Apache-2.0",
  },
};

// The logo is drawn once in the legal pages' markup (header, then footer); the comparison pages reuse it.
const [logo, footLogo] = read("privacy/index.html").match(/<svg class="dlogo"[\s\S]*?<\/svg>/g);
const moon =
  '<svg class="moon" viewBox="0 0 16 16"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"/></svg>';
const sun =
  '<svg class="sun" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>';

const url = (lang, slug) => `${site}${lang === "en" ? "" : `/${lang}`}/vs/${slug}/`;
const shown = (href) => href.replace(/^https:\/\//, "").replace(/\/$/, "");

function page(product, lang) {
  const w = words[lang];
  const { slug, name } = product;
  const root = lang === "en" ? "../../" : "../../../"; // the site's root, where the shared files are
  const home = "../../"; // this language's home page
  const switcher =
    lang === "en"
      ? `<a class="link" href="./" lang="en" hreflang="en" aria-label="English" aria-current="page">EN</a><a class="link" href="../../tr/vs/${slug}/" lang="tr" hreflang="tr" aria-label="Türkçe">TR</a>`
      : `<a class="link" href="../../../vs/${slug}/?lang=en" lang="en" hreflang="en" aria-label="English">EN</a><a class="link" href="./" lang="tr" hreflang="tr" aria-label="Türkçe" aria-current="page">TR</a>`;
  const title = w.title(name);
  const description = w.description(name);
  const rows = product.rows
    .map(
      (row) =>
        `<tbody><tr><th colspan="2" scope="rowgroup">${text(data.labels[row.key][lang])}</th></tr><tr><td>${text(data.dozo[row.key][lang])}</td><td>${text(row[lang])}</td></tr></tbody>`,
    )
    .join("\n");
  const sources = product.sources
    .map((href) => `<li><a href="${attr(href)}" rel="noopener nofollow">${text(shown(href))}</a></li>`)
    .join("");
  const [selfHost, github, licence, privacy, terms, refunds] = w.links;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${text(title)}</title>
<meta name="description" content="${attr(description)}">
<meta name="color-scheme" content="dark light">
<meta property="og:type" content="website">
<meta property="og:locale" content="${w.locale}">
<meta property="og:locale:alternate" content="${w.other}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="${url(lang, slug)}">
<meta property="og:image" content="${site}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${url(lang, slug)}">
<link rel="alternate" hreflang="en" href="${url("en", slug)}">
<link rel="alternate" hreflang="tr" href="${url("tr", slug)}">
<link rel="alternate" hreflang="x-default" href="${url("en", slug)}">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${root}landing.css">
<script src="${root}theme.js"></script>
</head>
<body>
<a class="skip" href="#main">${w.skip}</a>

<header><div class="wrap top">
  <a class="lock" href="${home}" aria-label="Dozo">${logo}</a>
  <nav class="nav" aria-label="${w.menu}">
    <button class="tgl" id="theme" type="button" aria-label="${w.theme}">${moon}${sun}</button>
    <span class="langs">${switcher}</span>
    <a class="pill" href="${repo}" rel="noopener">GitHub</a>
    <a class="pill" href="https://app.dozo.bot/sign-in?lang=${lang}">${w.signIn}</a>
  </nav>
</div></header>

<main id="main" class="wrap"><article class="legal vs">
<h1>Dozo vs ${text(name)}</h1>
<p>${text(product.summary[lang])}</p>
<table>
<thead><tr><th scope="col">Dozo</th><th scope="col">${text(name)}</th></tr></thead>
${rows}
</table>
<p>${w.checked(product.checked)}</p>
<h2>${w.sources}</h2>
<ul>${sources}</ul>
<p>${w.wrong} <a href="mailto:${data.contact}">${data.contact}</a></p>
<p>${text(w.trademark(name))}</p>
<div class="cta"><a class="pill w lg" href="${home}#get">${w.download}</a><a class="pill lg" href="${repo}/tree/main/dozo#readme" rel="noopener">${w.selfHost}</a></div>
</article></main>

<footer><div class="wrap">
  <div class="fin">
    <span class="foot"><a class="lock" href="#main" aria-label="${w.top}">${footLogo}</a><span class="kana" lang="ja" aria-hidden="true">どうぞ</span></span>
    <nav aria-label="${w.footer}"><a class="link" href="${repo}/tree/main/dozo#readme" rel="noopener">${selfHost}</a><a class="link" href="${repo}" rel="noopener">${github}</a><a class="link" href="${repo}/blob/main/dozo/NOTICE" rel="noopener">${licence}</a><a class="link" href="${home}privacy/">${privacy}</a><a class="link" href="${home}terms/">${terms}</a><a class="link" href="${home}refunds/">${refunds}</a></nav>
  </div>
  <p class="credit">${w.credit}</p>
</div></footer>
</body>
</html>
`;
}

// Replaces what lies between a start and an end marker line of a hand-kept file.
function between(file, start, end, body) {
  const source = read(file);
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from === -1 || to < from) throw new Error(`${file}: markers "${start}" and "${end}" not found`);
  return source.slice(0, from + start.length) + body + source.slice(to);
}

function home(lang) {
  const links = data.products
    .map((product) => `<a class="pill sm" href="vs/${product.slug}/">${text(product.name)}</a>`)
    .join("");
  return `
<section class="compare wrap" aria-labelledby="vh">
  <h2 class="ih" id="vh">${words[lang].compare}</h2>
  <div class="row">${links}</div>
</section>
`;
}

function sitemap() {
  const entry = (lang, slug) => `  <url>
    <loc>${url(lang, slug)}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${url("en", slug)}"/>
    <xhtml:link rel="alternate" hreflang="tr" href="${url("tr", slug)}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${url("en", slug)}"/>
  </url>
`;
  return `\n${data.products.map(({ slug }) => entry("en", slug) + entry("tr", slug)).join("")}  `;
}

// Every file this script owns, by its path under dozo/landing/, with the content it should have.
export function render() {
  const out = new Map();
  for (const product of data.products) {
    out.set(`vs/${product.slug}/index.html`, page(product, "en"));
    out.set(`tr/vs/${product.slug}/index.html`, page(product, "tr"));
  }
  for (const [lang, file] of [["en", "index.html"], ["tr", "tr/index.html"]])
    out.set(file, between(file, "<!-- compare: written by vs/build.mjs -->", "<!-- /compare -->", home(lang)));
  out.set("sitemap.xml", between("sitemap.xml", "<!-- vs: written by vs/build.mjs -->", "<!-- /vs -->", sitemap()));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const slugs = new Set(data.products.map((product) => product.slug));
  for (const root of ["vs/", "tr/vs/"]) {
    mkdirSync(new URL(root, dir), { recursive: true });
    for (const entry of readdirSync(new URL(root, dir), { withFileTypes: true }))
      if (entry.isDirectory() && !slugs.has(entry.name))
        rmSync(new URL(`${root}${entry.name}/`, dir), { recursive: true });
  }
  for (const [path, html] of render()) {
    mkdirSync(new URL(".", new URL(path, dir)), { recursive: true });
    writeFileSync(new URL(path, dir), html);
  }
}
