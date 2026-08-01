import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const requestedPort = Number.parseInt(process.env.HMS_E2E_PORT ?? "5173", 10);
const port = Number.isSafeInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65_535
  ? requestedPort
  : 5173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["solo-baseline.e2e.ts", "*.regression.e2e.ts"],
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
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `VITE_TELEMETRY_ENABLED=false VITE_DUEL_EXPERIMENT=true node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.HMS_E2E_REUSE_SERVER === "true",
    timeout: 120_000,
  },
});
