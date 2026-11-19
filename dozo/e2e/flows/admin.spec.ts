import type { Page } from "@playwright/test";
import { adminBrowser, newAccount, reportBilling, rpcAs } from "./accounts";
import { expect, test } from "./flow";

/**
 * Every admin section with the stack's real admin (run.sh signs it up and verifies it). Each test
 * acts on accounts and values it makes itself and puts back what it changed, so a run leaves the
 * stack as it found it and the next run starts the same.
 */

async function adminAt(browser: import("@playwright/test").Browser, path: string) {
  const { page } = await adminBrowser(browser);
  await page.goto(path);
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
  return page;
}

function row(page: Page, email: string) {
  return page.getByTestId("admin-users").getByRole("listitem").filter({ hasText: email });
}

// As `make canli`'s admin mode opens them: each section keeps the admin navigation.
const SECTIONS: [path: string, label: string][] = [
  ["/admin", "Members"],
  ["/admin/plugins", "Plugins"],
  ["/admin/settings", "Site settings"],
  ["/admin/plans", "Plans"],
  ["/admin/billing", "Billing"],
  ["/admin/funnel", "Funnel"],
];

test("every section opens inside the admin page, its navigation kept", async ({
  browser,
  guard,
}) => {
  const { page } = await adminBrowser(browser);
  guard.follow(page);
  const nav = page.getByRole("navigation", { name: "Admin" });
  for (const [path, label] of SECTIONS) {
    await page.goto(path);
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("page-loading")).toHaveCount(0);
    await expect(page.getByText(/Couldn't load/i)).toHaveCount(0);
  }
  // Free access exists only on a server that bills, which this stack is not: its address
  // opens the members list, and the navigation does not offer it.
  await page.goto("/admin/access");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(nav.getByText("Free access", { exact: true })).toHaveCount(0);
});

test("members: search, filter, give a plan, take it back, suspend, delete", async ({
  browser,
  guard,
}) => {
  const member = await newAccount(browser, "member");
  const email = member.user.email;
  const page = await adminAt(browser, "/admin");
  guard.follow(page);
  // Search narrows the list to the one account.
  await page.getByPlaceholder("Search by email").fill(email);
  await expect(page.getByTestId("admin-users").getByRole("listitem")).toHaveCount(1);
  await expect(row(page, email)).toContainText("Free");
  // Give Premium until a week from now.
  await row(page, email).getByRole("button", { name: "Set plan" }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
  await dialog.getByLabel("Plan").selectOption("pro");
  const end = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("End date").fill(end);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, email)).toContainText("Premium");
  // The plan filter finds it on Premium, and not on Free.
  await page.getByLabel("Plan", { exact: true }).selectOption("pro");
  await expect(row(page, email)).toBeVisible();
  await page.getByLabel("Plan", { exact: true }).selectOption("standard");
  await expect(row(page, email)).toHaveCount(0);
  await page.getByLabel("Plan", { exact: true }).selectOption("");
  // Take the granted plan back.
  await row(page, email).getByRole("button", { name: "Set plan" }).click();
  await dialog.getByLabel("Plan").selectOption("none");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, email)).not.toContainText("Premium");
  // Suspend; the status filter shows it as suspended.
  await row(page, email).getByRole("button", { name: "Suspend", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Suspend" }).click();
  await page.getByLabel("Status").selectOption("suspended");
  await expect(row(page, email)).toBeVisible();
  await page.getByLabel("Status").selectOption("");
  // Delete the account for good.
  await row(page, email).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row(page, email)).toHaveCount(0);
  await page.getByPlaceholder("Search by email").fill("");
});

test("site settings: an announcement is saved, every member sees it, then it is cleared", async ({
  browser,
  page,
  guard,
}) => {
  const admin = await adminAt(browser, "/admin/settings");
  guard.follow(admin);
  const english = admin.getByLabel("Announcement in English");
  const text = `E2E announcement ${Math.random().toString(36).slice(2, 7)}`;
  await english.fill(text);
  await english.blur();
  await admin
    .getByRole("button", { name: "Save" })
    .click()
    .catch(() => undefined);
  // The member's app shows it in the line under the pages.
  await page.goto("/app");
  await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
  await english.fill("");
  await english.blur();
  await admin
    .getByRole("button", { name: "Save" })
    .click()
    .catch(() => undefined);
  await page.reload();
  await expect(page.getByText(text)).toHaveCount(0);
});

test("plans: a quota is changed and put back", async ({ browser, guard }) => {
  const page = await adminAt(browser, "/admin/plans");
  guard.follow(page);
  const field = page.getByLabel("Shared space in MB for Premium", { exact: true });
  // An unset quota shows the plan's terms as its placeholder.
  const before = await field.inputValue();
  const shown = before || ((await field.getAttribute("placeholder")) ?? "0");
  const changed = String(Number(shown) + 1);
  await field.fill(changed);
  await field.press("Enter");
  await field.blur();
  await expect
    .poll(async () => {
      const { plans } = await rpcAs<{
        plans: { tier: string; sharedSpaceMb: { value: number } }[];
      }>(page, "dozoAdmin/plans/list");
      return String(plans.find((plan) => plan.tier === "pro")?.sharedSpaceMb.value);
    })
    .toBe(changed);
  await page.reload();
  await expect(field).toHaveValue(changed);
  // Back to the plan's terms.
  await rpcAs(page, "dozoAdmin/plans/setQuota", { tier: "pro", sharedSpaceMb: null });
  await page.reload();
  await expect(field).toHaveValue(before);
});

test("free access: a grant is made, edited and deleted (grants faked: no billing here)", async ({
  browser,
  guard,
}) => {
  const { page } = await adminBrowser(browser);
  guard.follow(page);
  // Grants exist only on a server that bills; this stack does not, so the account reports billing
  // and the four calls are answered in the browser: the page's own create, edit and delete are
  // what is checked.
  await reportBilling(page);
  type Grant = {
    id: string;
    email: string;
    creditCents: number;
    freeMonths: number;
    createdBy: string | null;
    status: "pending" | "applied" | "revoked";
    createdAt: string;
    appliedAt: string | null;
  };
  let grants: Grant[] = [];
  const answer = (json: unknown) => ({ json: { json } });
  // Upstream's list and create, and the fork's edit and delete under dozoAdmin.
  await page.route(/\/rpc\/(dozoAdmin\/)?accessGrants\//, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = ((route.request().postDataJSON() as { json?: unknown } | null)?.json ??
      {}) as Record<string, unknown>;
    if (name === "list") return route.fulfill(answer(grants));
    if (name === "create") {
      const grant: Grant = {
        id: `g${grants.length + 1}`,
        email: String(input.email),
        creditCents: Number(input.creditCents ?? 0),
        freeMonths: Number(input.freeMonths ?? 0),
        createdBy: null,
        status: "pending",
        createdAt: new Date().toISOString(),
        appliedAt: null,
      };
      grants = [grant, ...grants];
      return route.fulfill(answer(grant));
    }
    if (name === "update") {
      const { id, grant } = input as { id: string; grant: Partial<Grant> };
      grants = grants.map((g) => (g.id === id ? { ...g, ...grant } : g));
      return route.fulfill(answer({ ok: true }));
    }
    if (name === "delete") {
      grants = grants.filter((g) => g.id !== input.id);
      return route.fulfill(answer({ ok: true }));
    }
    return route.continue();
  });
  await page.goto("/admin/access");
  // A section of the admin page, as the others: the navigation stays.
  await expect(
    page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Free access" }),
  ).toHaveAttribute("aria-current", "page");
  const email = "grant-e2e@example.test";
  await page.locator("#grant-email").fill(email);
  await page.locator("#grant-months").fill("2");
  await page.getByRole("button", { name: "Grant" }).click();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: `Actions for ${email}` }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("dialog").locator("#edit-grant-months").fill("3");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect.poll(() => grants[0]?.freeMonths).toBe(3);
  await page.getByRole("button", { name: `Actions for ${email}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(email)).toHaveCount(0);
});

test("billing summary and funnel: the counts and the periods", async ({ browser, guard }) => {
  const page = await adminAt(browser, "/admin/billing");
  guard.follow(page);
  await expect(page.getByText(/\d+ members/)).toBeVisible();
  await expect(page.getByText("Premium Plus")).toBeVisible();
  // This stack does not bill: free access, which only a billing server has, is not listed.
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav.getByText("Plans", { exact: true })).toBeVisible();
  await expect(nav.getByText("Free access", { exact: true })).toHaveCount(0);
  await nav.getByText("Funnel", { exact: true }).click();
  await expect(page.getByText("Signed up")).toBeVisible();
  // Nor the funnel's paid step: nobody can pay here.
  await expect(page.getByTestId("funnel").getByRole("listitem")).toHaveCount(4);
  for (const period of ["30 days", "90 days", "7 days"]) {
    await page.getByRole("button", { name: period }).click();
    await expect(page.getByRole("button", { name: period })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
});
