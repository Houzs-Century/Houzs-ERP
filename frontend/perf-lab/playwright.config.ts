import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const localChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL as
  | "chrome"
  | "msedge"
  | undefined;

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: process.env.CI
    ? [["list"], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "report" }]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-desktop",
      testMatch: /.*\.desktop\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        channel: localChannel,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "chromium-mobile",
      testMatch: /.*\.mobile\.spec\.ts$/,
      use: { ...devices["Pixel 7"], channel: localChannel },
    },
  ],
  webServer: {
    command: "npm run dev:perf-lab",
    cwd: frontendRoot,
    url: "http://127.0.0.1:4174/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
