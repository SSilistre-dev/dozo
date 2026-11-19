import { defineConfig, devices } from "@playwright/test";

// The live smoke run (`make canli`): only CANLI_URL decides where it goes, and it has no default,
// so it never runs against production by accident. canli.sh refuses to start without it.
const baseURL = process.env.CANLI_URL;
if (!baseURL) throw new Error("CANLI_URL is not set; run: CANLI_URL=https://... make canli");
const out = process.env.DOZO_E2E_OUT ?? ".out-canli";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: `${out}/artifacts`,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // The finally step: deletes the run's account if a scenario could not (canli/cleanup.ts).
  globalTeardown: "./cleanup.ts",
  reporter: [["list"], ["json", { outputFile: `${out}/results.json` }], ["./report.ts"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    baseURL,
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
