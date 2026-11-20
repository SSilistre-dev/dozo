import { expect, test } from "@playwright/test";
import { APP_CONTENT_SECURITY_POLICY } from "@rakazo/contracts/content-security-policy";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/dozo-chat-math.html";

// The app's own style and font rules. Its script rules are left out: the dev server's scripts
// are not what the app ships.
const stylePolicy = APP_CONTENT_SECURITY_POLICY.split("; ")
  .filter((directive) => /^(style|font|img)-src /.test(directive))
  .join("; ");

for (const theme of ["dark", "light"]) {
  test(`chat math draws formulas and leaves prices as text (${theme})`, async ({
    page,
  }, testInfo) => {
    const blocked: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused to load/i.test(message.text()))
        blocked.push(message.text());
    });
    await page.route(`**${fixture}*`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": stylePolicy },
      });
    });
    await page.goto(`${fixture}?theme=${theme}`);
    const reply = page.getByTestId("reply");
    await expect(reply.locator(".katex")).toHaveCount(8);
    await expect(reply.locator(".rk-math-display .katex-display")).toHaveCount(1);
    await expect(reply.getByText("The plan costs $5 a month or $50 a year.")).toBeVisible();
    await expect(reply.locator("[data-testid=table-card] .katex").first()).toBeVisible();
    // KaTeX's own fonts, not a fallback face.
    await expect
      .poll(() => page.evaluate(() => document.fonts.check("16px KaTeX_Main")))
      .toBe(true);
    expect(blocked).toEqual([]);
    await captureScreenshot(page, testInfo, `chat-math-${theme}`);
  });
}

test("a formula still streaming in reads as its source", async ({ page }) => {
  await page.goto(`${fixture}?stream`);
  const reply = page.getByTestId("reply");
  await expect(reply).toContainText("$$");
  await expect(reply.locator(".katex, .katex-error")).toHaveCount(0);
});
