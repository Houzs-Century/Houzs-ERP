import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// HC-0127 return-to-source click-through. Runs the REAL frontend in a browser
// against a stubbed API (no database, no login, nothing touches a live system).
// Start: cd frontend && npx playwright test -c return-e2e/playwright.config.ts
// Set CHROME_PATH to use an already-installed Chromium instead of the bundled one.
const PORT = 5199;
export default defineConfig({
  testDir: ".",
  testMatch: /return-to-source\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "on",
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  webServer: {
    command: `npx vite --port ${PORT} --host 127.0.0.1`,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { VITE_API_URL: `http://127.0.0.1:${PORT}` },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
