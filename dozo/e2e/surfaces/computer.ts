import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { dismiss, ensureComputerAwake, openBot, openBotPanel } from "../ui";

/**
 * Upstream's first start of a new team computer can answer 500 on macOS Docker Desktop or Colima
 * bind mounts ("computer home is not usable by uid 1000"; dozo/README.md, Status and known limits);
 * a retry starts it. On Linux it does not happen, so it is allowed, not required.
 */
const FIRST_START_ON_MACOS = {
  pattern: /500 POST \/rpc\/computer\/boot/,
  reason: "upstream's first start on macOS bind mounts (computer home not usable by uid 1000)",
};

export const computer: Surface[] = [
  {
    name: "computer: first start from the bot panel",
    group: "computer",
    once: true,
    slow: 240_000,
    expect5xx: [FIRST_START_ON_MACOS],
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await scan("asleep");
      // Waking opens the computer's own window; once its screen is up the panel says Awake.
      await page.getByTestId("computer-preview-open").click();
      await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
        timeout: 180_000,
      });
      await page.keyboard.press("Escape");
      await expect(page.getByText("Awake", { exact: true })).toBeVisible();
      await scan("awake");
    },
  },
  {
    name: "computer: full window, teach a task",
    group: "computer",
    once: true,
    slow: 240_000,
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await ensureComputerAwake(page);
      await scan("awake in the panel");
      await page.getByTestId("computer-preview-open").click();
      await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
        timeout: 60_000,
      });
      await scan("full window");
      await page.getByRole("button", { name: "Teach a task" }).click();
      await scan("teach a task");
      await dismiss(page);
    },
  },
];
