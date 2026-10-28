import { defineConfig, devices } from "@playwright/test";
import path from "path";

// Pick up ERP_* + TEST_* vars from a local .env file if present.
// Keeps secrets (staff password, real SO phone) out of the repo.
try {
  // Lightweight .env loader — no dep needed for a handful of vars.
  const fs = require("fs");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
      }
    }
  }
} catch {}

const BASE_URL = process.env.ERP_BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,      // single sequential run (single case lifecycle)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,                // sequential — the case lifecycle is a single linear story
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
