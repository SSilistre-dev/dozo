import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { openEmailForm, PASSWORD } from "../support";

export const signedOut: Surface[] = [
  {
    name: "sign-in",
    group: "signed out",
    signedOut: true,
    covers: ["route:/sign-in", "route:/sign-in/email", "route:/"],
    async reach({ page, goto, scan }) {
      await goto("/");
      await expect(page).toHaveURL(/\/(sign-in|sign-up)/);
      await goto("/sign-in");
      await expect(page.getByRole("heading", { name: "Sign in to Dozo" })).toBeVisible();
      await scan("email chooser");
      await openEmailForm(page);
      await goto("/sign-in/email");
      await expect(page.getByPlaceholder("Password")).toBeVisible();
    },
  },
  {
    name: "sign-up",
    group: "signed out",
    signedOut: true,
    covers: ["route:/sign-up", "route:/sign-up/email"],
    async reach({ page, goto, scan }) {
      await goto("/sign-up");
      await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
      await scan("email chooser");
      await goto("/sign-up/email");
      await expect(page.getByPlaceholder("Password")).toBeVisible();
    },
  },
  {
    name: "sign-in wrong password",
    group: "signed out",
    signedOut: true,
    once: true,
    async reach({ page, goto, world: _w }) {
      await goto("/sign-in");
      await openEmailForm(page);
      await page.getByPlaceholder("Your email address").fill("nobody-e2e@example.test");
      await page.getByPlaceholder("Password").fill(`${PASSWORD}-wrong`);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page
          .getByRole("alert")
          .or(page.getByText(/invalid|incorrect|wrong|not found|try again/i))
          .first(),
      ).toBeVisible();
    },
  },
  {
    name: "forgot-password",
    group: "signed out",
    signedOut: true,
    covers: ["route:/forgot-password"],
    async reach({ page, goto, scan }) {
      await goto("/forgot-password");
      await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
      await scan("form");
      // This stack has no mail server, so the form answers at once and sends nothing.
      await page.getByLabel("Email", { exact: true }).fill("nobody-e2e@example.test");
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(
        page.getByText("Password recovery is not configured for this server"),
      ).toBeVisible();
    },
  },
  {
    name: "reset-password (no token, then token)",
    group: "signed out",
    signedOut: true,
    covers: ["route:/reset-password"],
    async reach({ page, goto, scan }) {
      await goto("/reset-password");
      await expect(page.getByText("This reset link is invalid or expired")).toBeVisible();
      await scan("invalid link");
      await goto("/reset-password?token=e2e-not-a-token");
      await expect(page.getByRole("button", { name: "Reset password" })).toBeVisible();
    },
  },
  {
    name: "shared page that does not exist",
    group: "signed out",
    signedOut: true,
    covers: ["route:/p/:slugToken"],
    async reach({ page, goto }) {
      await goto("/p/e2e-not-a-page");
      await expect(page.getByText("This page isn't available")).toBeVisible();
    },
  },
  {
    name: "integration callback",
    group: "signed out",
    signedOut: true,
    covers: ["route:/integrations/callback"],
    async reach({ page, goto }) {
      await goto("/integrations/callback");
      await expect(page.getByText("You can close this window.")).toBeVisible();
    },
  },
  {
    name: "sso callback",
    group: "signed out",
    signedOut: true,
    covers: ["route:/sso/callback"],
    async reach({ page }) {
      await page.goto("/sso/callback", { waitUntil: "domcontentloaded" });
    },
  },
  {
    name: "404",
    group: "signed out",
    signedOut: true,
    covers: ["route:*"],
    async reach({ page, goto }) {
      await goto("/this-route-does-not-exist");
      await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    },
  },
  {
    name: "signed-in routes sent to sign-in",
    group: "signed out",
    signedOut: true,
    async reach({ page, goto }) {
      for (const path of [
        "/app",
        "/onboarding",
        "/app/artifacts",
        "/invite/e2e-token",
        "/admin/access",
        "/admin/plugins",
        "/integrations/setup",
        "/mcp/oauth/callback",
        "/messaging/slack/callback",
      ]) {
        await goto(path);
        await expect(page).toHaveURL(/\/sign-in/);
      }
    },
  },
];
