import { expect, test } from "@playwright/test";
import { installProbes, scanPage } from "./scan";

// The crawl reports zero brand hits only if the scanner can see them. This plants one of every
// kind in a page and expects each to be found, and the documented exceptions to be let through.
test("the scanner finds a planted name everywhere a person can read one", async ({ context }) => {
  await installProbes(context);
  const page = await context.newPage();
  const html = `<!doctype html><title>Rakazo</title>
    <body>
      <p>visible Rakazo text</p>
      <p style="display:none">hidden getrakazo text</p>
      <img alt="Rakazo logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <button aria-label="Open Rakazo" title="by elie222">x</button>
      <input placeholder="Rakazo key" value="rakazo input">
      <a href="https://github.com/elie222/rakazo">source</a>
      <a href="https://discord.gg/RWwKa2Sn7h">chat</a>
      <meta name="description" content="Rakazo">
      <p id="allowed">a fork of Rakazo, Based on Rakazo, forked from Rakazo</p>
      <a href="rakazo://open" aria-label="@rakazo/ui RAKAZO_URL x-rakazo-id">identifiers</a>
    </body>`;
  await page.route("http://scanner.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://scanner.test/");
  await page.evaluate(() => {
    const toast = document.createElement("div");
    toast.setAttribute("role", "status");
    toast.textContent = "Rakazo toast";
    document.body.append(toast);
    toast.remove();
    void navigator.clipboard.writeText("https://app.rakazo.com/invite/abc");
    window.open("https://www.getrakazo.com/x");
  });
  const scan = await scanPage(page, "planted");
  const found = scan.leaks.map((leak) => leak.where);
  for (const where of [
    "title", "body.innerText", "body.textContent(hidden text included)", "[alt]", "[aria-label]", "[title]",
    "[placeholder]", "input.value", "a[href]", "meta[description]", "transient (toast, dialog, menu, tooltip)", "clipboard", "window.open",
  ]) {
    expect(found, `a planted name in "${where}" was not found; found in: ${[...new Set(found)].join(", ")}`).toContain(where);
  }
  const texts = scan.leaks.map((leak) => leak.text).join("\n");
  expect(texts).not.toMatch(/fork of Rakazo|Based on Rakazo|forked from Rakazo/);
  expect(texts, "deliberate identifiers are not leaks").not.toMatch(/@rakazo\/ui|RAKAZO_URL|x-rakazo-id|rakazo:\/\/open/);
  expect(scan.hosts).toEqual(expect.arrayContaining(["github.com", "discord.gg", "www.getrakazo.com"]));
});
