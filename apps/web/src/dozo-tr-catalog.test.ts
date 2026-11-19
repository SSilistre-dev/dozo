import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { extractFromFileWithBabel } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

// Runs on the branded tree: the Turkish catalog there carries the fork's block. Every string a
// fork file of the web app, the mobile app or the shared i18n package shows must have a Turkish translation, so
// a Turkish screen never falls back to English for the fork's own copy.

const ROOT = join(import.meta.dirname, "../../..");
const SOURCES = [
  "apps/web/src",
  "apps/mobile/app",
  "apps/mobile/components",
  "apps/mobile/lib",
  "packages/i18n/src",
];

async function forkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^dozo-.*\.tsx?$/.test(entry.name) &&
        !/\.(test|test-support)\.tsx?$/.test(entry.name),
    )
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

it("translates every fork string of the web and mobile apps into Turkish", async () => {
  const linguiConfig = getConfig({ cwd: ROOT, skipValidation: true });
  const files = (await Promise.all(SOURCES.map(forkFiles))).flat().sort();
  expect(files.length).toBeGreaterThan(10);

  const used = new Map<string, { message: string; file: string }>();
  for (const file of files) {
    const code = await readFile(join(ROOT, file), "utf8");
    await extractFromFileWithBabel(
      file,
      code,
      (extracted) => {
        used.set(extracted.id, { message: extracted.message ?? extracted.id, file });
      },
      { linguiConfig },
      { plugins: ["typescript", "jsx"] },
    );
  }
  expect(used.size).toBeGreaterThan(10);

  const po = await readFile(join(ROOT, "packages/i18n/locales/tr/messages.po"), "utf8");
  const catalog = await formatter({ lineNumbers: false }).parse(po, {
    locale: "tr",
    sourceLocale: "en",
    filename: "messages.po",
  });
  const missing = [...used]
    .filter(([id]) => !catalog?.[id]?.translation)
    .map(([, { message, file }]) => `${file}: ${message}`);
  expect(missing).toEqual([]);
});
