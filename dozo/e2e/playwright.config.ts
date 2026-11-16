import { defineConfig, devices } from "@playwright/test";

// The stack's public origin is 127.0.0.1:<port>; the app rejects other origins, so keep that host.
const baseURL = process.env.DOZO_E2E_BASE_URL ?? "http://127.0.0.1:5173";
const out = process.env.DOZO_E2E_OUT ?? ".out";
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

export default defineConfig<{ theme: "light" | "dark" }>({
  testDir: ".",
  outputDir: `${out}/artifacts`,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: `${out}/results.json` }], ["./coverage-reporter.ts"]],
  use: { baseURL, actionTimeout: 15_000, navigationTimeout: 30_000, trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
  projects: [
    // Signs up once and connects the offline model; every signed-in project reuses that session.
    { name: "setup", testMatch: "auth.setup.ts", use: desktop, teardown: "roundtrip" },
    // Last, whatever happened before: it signs in and out, which ends the saved session.
    { name: "roundtrip", testMatch: "roundtrip.spec.ts", use: desktop },
    { name: "inventory", testMatch: "inventory.spec.ts" },
    { name: "scanner", testMatch: "scanner.spec.ts", use: desktop },
    { name: "crawl-light", testMatch: ["crawl.spec.ts", "local-models.spec.ts"], dependencies: ["setup"], use: { ...desktop, theme: "light", storageState: `${out}/auth.json` } },
    { name: "crawl-dark", testMatch: ["crawl.spec.ts", "local-models.spec.ts"], dependencies: ["setup"], use: { ...desktop, theme: "dark", storageState: `${out}/auth.json` } },
    { name: "web-manifest", testMatch: "manifest.spec.ts", use: desktop },
  ],
});
