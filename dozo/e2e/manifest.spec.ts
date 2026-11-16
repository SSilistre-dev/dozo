import { expect, test } from "@playwright/test";

test("favicon and web manifest are served and branded", async ({ page, request }) => {
  await page.goto("/sign-in");
  const icon = await page.locator('link[rel~="icon"]').first().getAttribute("href");
  expect(icon, "no favicon link in the page head").toBeTruthy();
  const iconResponse = await request.get(new URL(icon as string, page.url()).toString());
  expect(iconResponse.ok(), `favicon ${icon} status ${iconResponse.status()}`).toBe(true);
  expect(iconResponse.headers()["content-type"] ?? "").toMatch(/image/);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref, "no manifest link in the page head").toBeTruthy();
  const manifestResponse = await request.get(
    new URL(manifestHref as string, page.url()).toString(),
  );
  expect(
    manifestResponse.ok(),
    `manifest ${manifestHref} status ${manifestResponse.status()}`,
  ).toBe(true);
  const manifest = (await manifestResponse.json()) as { name?: string; short_name?: string };
  expect(manifest.name).toBe("Dozo");
  expect(JSON.stringify(manifest)).not.toMatch(/rakazo|getrakazo|elie222/i);
});
