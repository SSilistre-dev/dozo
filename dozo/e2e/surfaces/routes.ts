import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { gotoStable, openBot } from "../ui";

/** Admin pages need RAKAZO_ADMIN_EMAILS and a verified email, which this stack has not set. */
async function asAdmin(page: import("@playwright/test").Page) {
  const admin = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: Record<string, unknown> };
    const me = route.request().url().endsWith("/me")
      ? body.json
      : (body.json?.me as Record<string, unknown> | undefined);
    if (me) me.isAdmin = true;
    await route.fulfill({ response, json: body });
  };
  await page.route("**/rpc/me", admin);
  await page.route("**/rpc/bootstrap", admin);
}

export const routes: Surface[] = [
  {
    name: "artifacts list and a missing artifact",
    group: "routes",
    covers: ["route:/app/artifacts", "route:/app/artifacts/:artifactId"],
    expect5xx: [],
    async reach({ page, goto, scan }) {
      await goto("/app/artifacts");
      await expect(page.getByText("No artifacts yet")).toBeVisible();
      await scan("empty list");
      await goto("/app/artifacts/e2e-no-such-artifact");
      await expect(page.getByText("Resource not found")).toBeVisible();
    },
  },
  {
    name: "invite link that is not valid",
    group: "routes",
    covers: ["route:/invite/:token"],
    async reach({ page, goto }) {
      await goto("/invite/e2e-not-an-invite");
      await expect(page.getByText("This invite link is no longer valid.")).toBeVisible();
    },
  },
  {
    name: "shared-link redirect and unknown bot",
    group: "routes",
    covers: ["route:/app/x/:linkId"],
    async reach({ page, goto, scan }) {
      await goto("/app/x/e2e-no-such-link");
      await scan("after /app/x/<unknown>");
      await goto("/app/e2e-no-such-bot");
      await scan("unknown bot");
    },
  },
  {
    name: "integration setup, OAuth and Slack callbacks (no code given)",
    group: "routes",
    covers: [
      "route:/integrations/setup",
      "route:/mcp/oauth/callback",
      "route:/messaging/slack/callback",
    ],
    async reach({ page, goto, scan }) {
      await goto("/integrations/setup");
      await expect(page.getByText("Add MCP server")).toBeVisible();
      await scan("integration setup");
      await goto("/mcp/oauth/callback");
      await expect(page.getByText("OAuth connection failed")).toBeVisible();
      await scan("mcp oauth failure");
      await goto("/messaging/slack/callback");
      await expect(page.getByText("Could not connect")).toBeVisible();
    },
  },
  {
    name: "admin pages (admin flag faked in the browser)",
    group: "routes",
    covers: ["route:/admin/plugins", "route:/admin/access"],
    expect5xx: [],
    async reach({ page, goto, scan, note }) {
      await asAdmin(page);
      await goto("/admin/plugins");
      await expect(page.getByText("Plugin submissions")).toBeVisible();
      await scan("plugin submissions");
      await goto("/admin/access");
      await expect(page.getByText("Free access")).toBeVisible();
      note(
        "admin flag is faked client-side; the api answers 403, so only the page's own copy is scanned",
      );
    },
  },
  {
    name: "Dozo admin page (refused to a member, also with the admin flag faked in the browser)",
    group: "routes",
    covers: ["route:/admin/*"],
    landsOn: {
      "route:/admin/*": { path: "/admin/:section", reason: "a section's address under /admin" },
    },
    expect5xx: [],
    async reach({ page, goto, scan, note }) {
      // The crawl's account is no admin: the address answers like one that does not exist.
      await goto("/admin");
      await expect(page.getByText("Page not found")).toBeVisible();
      await goto("/admin/settings");
      await expect(page.getByText("Page not found")).toBeVisible();
      // With only the flag faked, the page asks and the real api refuses.
      await asAdmin(page);
      const refused = page.waitForResponse((response) =>
        response.url().includes("/rpc/dozoAdmin/users"),
      );
      await goto("/admin");
      expect((await refused).status()).toBe(403);
      await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
      await expect(page.getByRole("alert")).toBeVisible();
      await scan("refused by the api");
      note(
        "a member with the admin flag faked is refused by the api; the admin pages with real data are the admin scenarios in flows/admin.spec.ts",
      );
    },
  },
  {
    name: "board (after switching it on in Labs)",
    group: "routes",
    once: true,
    covers: ["route:/app/board"],
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await gotoStable(page, `/app/${world.chiefId}?settings=labs`);
      const toggle = page.getByTestId("lab-board-toggle");
      await expect(toggle).toBeVisible();
      await toggle.click();
      await page.getByRole("button", { name: "Close user settings" }).click();
      await gotoStable(page, "/app/board");
      await expect(page).toHaveURL(/\/app\/board/);
      await scan("board");
    },
  },
];
