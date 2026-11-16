import type { Surface } from "../fixtures";
import { expect } from "../fixtures";

export const onboarding: Surface[] = [
  {
    name: "onboarding: survey",
    group: "onboarding",
    covers: ["onboarding:survey", "route:/onboarding/:step?"],
    async reach({ page, goto, scan }) {
      await goto("/onboarding/survey");
      await expect(page.getByText("Welcome to Dozo")).toBeVisible();
      await scan("survey");
    },
  },
  {
    name: "onboarding: model step, every provider's form",
    group: "onboarding",
    once: true,
    covers: ["onboarding:model"],
    async reach({ page, goto, scan }) {
      await goto("/onboarding/model");
      const heading = page.getByRole("heading", { name: "Connect a model" });
      await expect(heading).toBeVisible();
      const provider = page.getByRole("combobox", { name: "Provider" });
      await provider.click();
      await expect(page.getByRole("option").first()).toBeVisible();
      await scan("provider list");
      const names = (await page.getByRole("option").allInnerTexts()).map((name) => name.trim()).filter(Boolean);
      expect(names.length, "providers listed").toBeGreaterThan(5);
      await page.keyboard.press("Escape");
      for (const name of names) {
        await provider.click();
        await expect(page.getByRole("option").first()).toBeVisible();
        await page.getByRole("option", { name, exact: true }).click();
        await scan(`provider ${name}`);
      }
    },
  },
  {
    name: "onboarding: first bot (an account that has a model)",
    group: "onboarding",
    covers: ["onboarding:bot"],
    async reach({ page, goto }) {
      await goto("/onboarding");
      await page.waitForURL(/\/app\/[^/]+$/, { timeout: 30_000 });
    },
  },
];
