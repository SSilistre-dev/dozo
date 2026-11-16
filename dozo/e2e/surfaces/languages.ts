import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Surface } from "../fixtures";
import { expect, outDirFile } from "../fixtures";
import { dismiss, gotoStable, openBot, openCommandPalette, openUserSettings } from "../ui";

const LOCALES_FILE = () => outDirFile("locales.json");
const LOCALE_KEY = "rakazo.uiLocale"; // a deliberately unchanged technical identifier

/**
 * Translations are where a name outlives a rename, so the key screens are scanned in every language
 * the Language setting offers. The signed-in sweep picks each language through the real dropdown
 * (which also saves it to the account), then puts English back.
 */
export const languages: Surface[] = [
  {
    name: "languages: key screens, signed in, every UI language",
    group: "languages",
    once: true,
    slow: 420_000,
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      const settings = await openUserSettings(page, "general");
      const trigger = settings.getByTestId("ui-locale-select");
      await trigger.click();
      await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
      const count = await page.getByRole("listbox").getByRole("option").count();
      await dismiss(page);
      expect(count, "languages offered").toBeGreaterThan(3);
      const codes: string[] = [];
      const pick = async (index: number) => {
        await gotoStable(page, `/app/${world.chiefId}?settings=general`);
        const select = page.getByTestId("user-settings").getByTestId("ui-locale-select");
        await select.click();
        await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
        await page.getByRole("listbox").getByRole("option").nth(index).click();
        await expect(page.getByRole("listbox")).toHaveCount(0);
        return page.evaluate((key) => localStorage.getItem(key), LOCALE_KEY);
      };
      try {
        for (let i = 0; i < count; i++) {
          const code = (await pick(i)) ?? `option-${i}`;
          codes.push(code);
          await scan(`settings in ${code}`);
          if (code === "en") continue;
          await gotoStable(page, `/app/${world.chiefId}`);
          await scan(`chat in ${code}`);
          await openCommandPalette(page);
          await scan(`command palette in ${code}`);
          await dismiss(page);
          await gotoStable(page, "/onboarding/model");
          await scan(`model step in ${code}`);
          await gotoStable(page, "/app/artifacts");
          await scan(`artifacts in ${code}`);
        }
      } finally {
        const english = codes.indexOf("en");
        if (english >= 0) await pick(english);
      }
      mkdirSync(LOCALES_FILE().replace(/\/[^/]*$/, ""), { recursive: true });
      writeFileSync(LOCALES_FILE(), JSON.stringify(codes));
    },
  },
  {
    name: "languages: sign-in, sign-up, forgot password in every UI language",
    group: "languages",
    signedOut: true,
    once: true,
    slow: 300_000,
    async reach({ page, goto, scan }) {
      expect(existsSync(LOCALES_FILE()), "the signed-in language sweep must run first (it records the language codes)").toBe(true);
      const codes = JSON.parse(readFileSync(LOCALES_FILE(), "utf8")) as string[];
      for (const code of codes.filter((c) => c !== "en" && !c.startsWith("option-"))) {
        await page.addInitScript(([key, value]) => localStorage.setItem(key as string, value as string), [LOCALE_KEY, code]);
        for (const path of ["/sign-in", "/sign-up", "/forgot-password"]) {
          await goto(path);
          await scan(`${path} in ${code}`);
        }
      }
    },
  },
];
