import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const LOCALES = file("../../../../packages/i18n/locales");
const script = readFileSync(file("../../public/dozo-boot.js"), "utf8");

describe("boot shell text", () => {
  it("is the app's own catalog text for an unreachable server, in every language", () => {
    const table = script.match(/const TEXT = (\{[\s\S]*?\n {2}\});/)?.[1];
    const text = new Function(`return ${table}`)() as Record<string, [string, string]>;
    const locales = readdirSync(LOCALES);
    expect(Object.keys(text).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      const po = readFileSync(`${LOCALES}/${locale}/messages.po`, "utf8");
      const msgstr = (id: string) =>
        po.match(new RegExp(`msgid "${id.replace(/[.']/g, "\\$&")}"\\nmsgstr "(.*)"`))?.[1];
      expect(text[locale], locale).toEqual([
        msgstr("Can't reach the server."),
        msgstr("Retry now"),
      ]);
    }
  });
});
