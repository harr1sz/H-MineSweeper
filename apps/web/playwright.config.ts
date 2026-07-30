import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "solo-baseline.e2e.ts",
  outputDir: join(tmpdir(), "h-minesweeper-playwright-results"),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "VITE_TELEMETRY_ENABLED=false node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
