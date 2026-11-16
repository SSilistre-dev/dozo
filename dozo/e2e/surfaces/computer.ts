import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { dismiss, ensureComputerAwake, openBot, openBotPanel } from "../ui";

/**
 * FINDING (functional, not brand): on this host the first start of a team's computer answers 500.
 * `docker logs dozo-supervisor-1`: POST /computers 500; `docker logs dozo-api-1`:
 * computer.provision_failed "computer home is not usable by uid 1000; run sudo chown -R 1000:1000
 * /data/homes/team-... or use Compose data-init". A second attempt (Retry screen) starts it.
 * `mustOccur` keeps this honest: the day the first start works, this surface fails and says so.
 */
const FIRST_START_FAILS = {
  pattern: /500 POST \/rpc\/computer\/boot/,
  reason:
    "supervisor: computer home is not usable by uid 1000 (first start of a new team computer)",
  mustOccur: true,
};

export const computer: Surface[] = [
  {
    name: "computer: first start from the bot panel (fails on this host)",
    group: "computer",
    once: true,
    expect5xx: [FIRST_START_FAILS],
    async reach({ page, world, scan, note }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await scan("asleep");
      await page.getByTestId("computer-preview-open").click();
      await expect(page.getByText("Internal server error")).toBeVisible({ timeout: 60_000 });
      await scan("failed start (visible error)");
      note(
        "first start: POST /rpc/computer/boot 500, the card shows 'Internal server error' and 'Retry screen'",
      );
    },
  },
  {
    name: "computer: screen after a retry, full window, teach a task",
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
