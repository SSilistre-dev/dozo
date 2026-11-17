import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect } from "@playwright/test";
import type { World } from "./fixtures";
import { APPEARANCE_KEY, authFile, rpc, test, worldFile } from "./fixtures";
import { connectModelThroughOnboarding, signUpThroughForm, throwawayUser } from "./support";

// The only sign-up of a run: every other test reuses this session, so a run spends few of the
// stack's 10 credential calls per 15 minutes (this one, one wrong password, one sign-in).
test("sign up once, connect the offline model, seed a few bots", async ({ page }) => {
  mkdirSync(dirname(authFile()), { recursive: true });
  const reuse = process.env.DOZO_E2E_REUSE_DIR; // development only: skip the sign-up with a saved session
  if (reuse && existsSync(`${reuse}/auth.json`) && existsSync(`${reuse}/world.json`)) {
    copyFileSync(`${reuse}/auth.json`, authFile());
    copyFileSync(`${reuse}/world.json`, worldFile());
    return;
  }
  const user = await signUpThroughForm(page, throwawayUser());
  await connectModelThroughOnboarding(page);
  const chiefId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) as string;
  // The stub answered the greeting, so the model works end to end through the worker.
  await expect(page.getByText("Hello from the offline Dozo test model.").first()).toBeVisible({
    timeout: 60_000,
  });
  const make = (name: string) =>
    rpc<{ id: string }>(page, "bots/create", {
      name,
      title: "",
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  const scout = await make("Scout");
  const writer = await make("Writer");
  const world: World = { user, chiefId, scoutId: scout.id, writerId: writer.id };
  writeFileSync(worldFile(), JSON.stringify(world));
  // The saved session must not carry this run's appearance: the fixture stores a project's theme
  // only when none is stored, so a saved "light" would turn the dark project light.
  await page.evaluate((key) => localStorage.removeItem(key), APPEARANCE_KEY);
  await page.context().storageState({ path: authFile() });
});
