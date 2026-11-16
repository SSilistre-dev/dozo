import { defineConfig, devices } from "@playwright/test";

// The stack's public origin is 127.0.0.1:<port>; the app rejects other origins, so keep that host.
const baseURL = process.env.DOZO_E2E_BASE_URL ?? "http://127.0.0.1:5173";
const out = process.env.DOZO_E2E_OUT ?? ".out";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: `${out}/artifacts`,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: `${out}/results.json` }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
