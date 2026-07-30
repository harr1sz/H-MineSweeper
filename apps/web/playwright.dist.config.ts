import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:5175";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "public-alpha.e2e.ts",
  outputDir: join(tmpdir(), "h-minesweeper-playwright-dist-results"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "VITE_TELEMETRY_ENABLED=true VITE_DUEL_EXPERIMENT=false VITE_APP_VERSION=0.2.0-alpha.1 VITE_BUILD_SHA=0123456789012345678901234567890123456789 VITE_BUILD_REGION=test pnpm build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5175 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
