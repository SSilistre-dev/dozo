import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emailCopyReader } from "./email-copy/deployment-copy.js";
import { EMAIL_COPY_KEYS, EMAIL_LOCALES } from "./email-copy/email-keys.js";
import { readCopyFile } from "./email-copy/validate.js";

// The image's EMAIL_COPY_DIR (/app/email-copy): the brand copies Dozo's wording there.
const dir = new URL("../../../email-copy/", import.meta.url);

describe("Dozo's email copy", () => {
  it.each(["welcome", "referral"] as const)("sends the %s mail, in every app language", (id) => {
    const read = readCopyFile(
      EMAIL_COPY_KEYS,
      EMAIL_LOCALES,
      id,
      JSON.parse(readFileSync(new URL(`${id}.json`, dir), "utf8")),
    );
    expect(read.complete).toBe(true);
    expect(read.unused).toEqual([]);
    // Every language carries every key the email reads, so none falls back to English.
    expect(read.problems).toEqual([]);
    expect(emailCopyReader(dir.pathname, () => undefined).available(id)).toBe(true);
  });
});
