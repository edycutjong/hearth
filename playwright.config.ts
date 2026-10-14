import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "html" : "list",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3210", trace: "on-first-retry" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Deliberately no credentials: a cold visit with nothing configured is the path every judge can take.
        command: "npx next start -p 3210",
        url: "http://localhost:3210/judge",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { NEBIUS_SERVICE_ACCOUNT_ID: "", HEARTH_SPACE_SECRET: "e2e" },
      },
});
