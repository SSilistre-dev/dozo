import type { Page } from "@playwright/test";
import { readWorld } from "../fixtures";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * Sign-in by emailed code, end to end with a real code: the setup's account asks for a code, the
 * stack's email emulator captures the mail (start the stack with DOZO_EMAIL_EMULATOR=1, see
 * dozo/docker/README.md), and the code read back from it signs in. A wrong code first gets the one
 * line of error. A stack that sends no mail skips this, and its sign-in page is upstream's form.
 */
test.use({ storageState: SIGNED_OUT });

type Mail = { to?: string | string[]; subject?: string; text?: string; html?: string };

async function mailsTo(page: Page, address: string): Promise<Mail[]> {
  const response = await page.request.get("/api/dev/emails");
  if (!response.ok()) return [];
  const all = (await response.json()) as Mail[];
  return all.filter((mail) => [mail.to].flat().includes(address));
}

const codeIn = (mail: Mail | undefined) =>
  /\b(\d{6})\b/.exec(`${mail?.text ?? ""} ${mail?.html ?? ""}`)?.[1];

test("an emailed code signs in; a wrong one is said in one line", async ({ page, guard }) => {
  const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
  test.skip(
    !capabilities.emailCode,
    "the stack sends no mail: start it with DOZO_EMAIL_EMULATOR=1",
  );
  guard.allow(/400 POST [^ ]*\/api\/auth\/sign-in\/email-otp/, "the wrong code is the point");
  const { user } = readWorld();
  const before = (await mailsTo(page, user.email)).length;

  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Use a password instead" })).toBeVisible();
  await page.getByPlaceholder("Your email address").fill(user.email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resend code/ })).toBeDisabled();

  let code: string | undefined;
  await expect
    .poll(async () => {
      const mails = await mailsTo(page, user.email);
      code = mails.length > before ? codeIn(mails.at(-1)) : undefined;
      return code;
    })
    .toMatch(/^\d{6}$/);

  const box = page.getByLabel("Code", { exact: true });
  await box.fill(code === "000000" ? "111111" : "000000");
  await expect(page.getByRole("alert")).toHaveText("Invalid code");
  await expect(page).toHaveURL(/\/sign-in/);

  await box.fill(code as string);
  await page.waitForURL(/\/(app|onboarding)/);
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
});
