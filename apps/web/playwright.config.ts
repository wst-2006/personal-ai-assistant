import { defineConfig, devices } from "@playwright/test";

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "3100";
const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? "5174";
const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: webBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }
  ],
  webServer: [
    {
      command: "pnpm --dir ../api dev",
      url: `${apiBaseUrl}/health`,
      env: { API_PORT: apiPort, FEISHU_CALLBACK_TRANSPORT: "http" },
      reuseExistingServer: true,
      timeout: 30_000
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${webPort}`,
      url: webBaseUrl,
      env: { VITE_API_BASE_URL: apiBaseUrl },
      reuseExistingServer: true,
      timeout: 30_000
    }
  ]
});
