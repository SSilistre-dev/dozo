import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { installProbes, scanPage } from "./scan";

// The crawl reports zero brand hits only if the scanner can see them. This plants one of every
// kind in a page and expects each to be found, and the documented exceptions to be let through.
// Every case that must NOT report a leak gets a page of its own: a leak elsewhere on the page would
// hide it, because only the first match per element is reported.

let next = 0;
async function scanHtml(
  context: BrowserContext,
  html: string,
  then?: (page: Page) => Promise<void>,
) {
  const page = await context.newPage();
  const url = `http://scanner-${next++}.test/`;
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url);
  await then?.(page);
  return { scan: await scanPage(page, "planted") };
}

test("the scanner finds a planted name everywhere a person can read one", async ({ context }) => {
  await installProbes(context);
  const html = `<!doctype html><title>Rakazo</title>
    <body>
      <p>visible Rakazo text</p>
      <p style="display:none">hidden getrakazo text</p>
      <img alt="Rakazo logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <button aria-label="Open Rakazo" title="by elie222">x</button>
      <input placeholder="Rakazo key" value="rakazo input">
      <a href="https://github.com/elie222/rakazo">source</a>
      <a href="https://discord.gg/RWwKa2Sn7h">chat</a>
      <a href="https://apps.apple.com/app/id6801531099">store</a>
      <meta name="description" content="Rakazo">
    </body>`;
  const { scan } = await scanHtml(context, html, async (page) => {
    await page.evaluate(() => {
      const toast = document.createElement("div");
      toast.setAttribute("role", "status");
      toast.textContent = "Rakazo toast";
      document.body.append(toast);
      toast.remove();
      void navigator.clipboard.writeText("https://app.rakazo.com/invite/abc");
      window.open("https://www.getrakazo.com/x");
    });
  });
  const found = scan.leaks.map((leak) => leak.where);
  for (const where of [
    "title",
    "body.innerText",
    "body.textContent(hidden text included)",
    "[alt]",
    "[aria-label]",
    "[title]",
    "[placeholder]",
    "input.value",
    "a[href]",
    "meta[description]",
    "transient (toast, dialog, menu, tooltip)",
    "clipboard",
    "window.open",
  ]) {
    expect(
      found,
      `a planted name in "${where}" was not found; found in: ${[...new Set(found)].join(", ")}`,
    ).toContain(where);
  }
  // One link per upstream identifier: all of them share `a[href]`, so the check is on the text.
  const linkTexts = scan.leaks.filter((leak) => leak.where === "a[href]").map((leak) => leak.text);
  for (const id of ["elie222", "RWwKa2Sn7h", "id6801531099"]) {
    expect(linkTexts.join("\n"), `a link carrying "${id}" was not reported`).toContain(id);
  }
  expect(scan.hosts).toEqual(
    expect.arrayContaining(["github.com", "discord.gg", "apps.apple.com", "www.getrakazo.com"]),
  );
});

test("the documented attribution phrases are not leaks, however often they appear", async ({
  context,
}) => {
  await installProbes(context);
  // Nothing else on the page: any report would be the attribution sentence itself.
  const { scan } = await scanHtml(
    context,
    `<!doctype html><title>Dozo</title>
     <p>a fork of Rakazo, Based on Rakazo, forked from Rakazo; a fork of Rakazo again</p>`,
  );
  expect(scan.leaks).toEqual([]);
});

test("deliberate identifiers are allowed in links and meta tags only, every occurrence", async ({
  context,
}) => {
  await installProbes(context);
  const { scan } = await scanHtml(
    context,
    `<!doctype html><title>Dozo</title>
     <meta name="x-app" content="RAKAZO_URL x-rakazo-id">
     <a href="rakazo://open?next=rakazo://again&k=@rakazo/ui @rakazo/core">x</a>
     <form action="/x?RAKAZO_URL=1 RAKAZO_KEY=2"></form>`,
  );
  // Needs the global flag: a replace that stops at the first match leaves the second occurrence.
  expect(scan.leaks).toEqual([]);
});

test("an identifier in an attribute a person reads is a leak", async ({ context }) => {
  await installProbes(context);
  const cases: [string, string][] = [
    ['<button title="Set RAKAZO_API_URL">x</button>', "[title]"],
    ['<input placeholder="Set RAKAZO_KEY">', "[placeholder]"],
    ['<button aria-label="x-rakazo-id">x</button>', "[aria-label]"],
    ['<button aria-description="@rakazo/ui">x</button>', "[aria-description]"],
    ['<input aria-placeholder="rakazo://open">', "[aria-placeholder]"],
    ['<img alt="RAKAZO_URL" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', "[alt]"],
  ];
  for (const [markup, where] of cases) {
    const { scan } = await scanHtml(context, `<!doctype html><title>Dozo</title>${markup}`);
    expect(
      scan.leaks.map((leak) => leak.where),
      `an identifier in ${where} must be a leak`,
    ).toContain(where);
  }
});

test("an identifier in text a person reads is a leak", async ({ context }) => {
  await installProbes(context);
  for (const text of ["RAKAZO_URL", "@rakazo/ui", "x-rakazo-id", "rakazo://open"]) {
    const { scan } = await scanHtml(context, `<!doctype html><title>Dozo</title><p>${text}</p>`);
    const where = scan.leaks.map((leak) => leak.where);
    expect(where, `"${text}" in visible text must be a leak`).toContain("body.innerText");
    expect(where).toContain("body.textContent(hidden text included)");
  }
  // An input's value is text a person reads too, not an attribute.
  const { scan } = await scanHtml(
    context,
    `<!doctype html><title>Dozo</title><input value="RAKAZO_URL">`,
  );
  expect(scan.leaks.map((leak) => leak.where)).toContain("input.value");
});

test("a deliberate identifier in a URL passed to window.open is allowed, a real link not", async ({
  context,
}) => {
  await installProbes(context);
  // Nothing else on the page: any report would be the exemption failing.
  const page = "<!doctype html><title>Dozo</title><p>hello there</p>";
  const allowed = await scanHtml(context, page, (opener) =>
    opener.evaluate(() => {
      window.open("rakazo://open?key=RAKAZO_URL&scope=@rakazo/ui&h=x-rakazo-id");
    }),
  );
  expect(allowed.scan.leaks).toEqual([]);
  expect(allowed.scan.urls.length, "the opened URL is still listed").toBeGreaterThan(0);
  // A link to the upstream site passed the same way is still a leak, found under "window.open".
  const real = await scanHtml(context, page, (opener) =>
    opener.evaluate(() => {
      window.open("https://app.rakazo.com/open");
    }),
  );
  expect(real.scan.leaks.map((leak) => leak.where)).toContain("window.open");
});
