import { defineConfig, devices } from "@playwright/test";
import path from "path";

// Local credential override: pick up STAGING_* vars from frontend/e2e/.env if
// present, so a real staging password never has to be committed. Mirrors the
// lightweight loader in the repo's other Playwright suite (top-level e2e/) — no
// dotenv dependency for a handful of vars. CI passes the same vars via the job
// env block instead.
try {
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
} catch {
  // A missing/unreadable .env is expected in CI — the config falls back to the
  // baked-in staging URLs and the job env vars.
}

// The staging frontend. Overridable so the same suite can be pointed at a
// preview deployment. `||` (not `??`) is deliberate: an empty-string env var
// from an unset CI variable must fall back to the default, not be treated as a
// real value.
const BASE_URL = process.env.STAGING_BASE_URL || "https://houzs-erp-staging.pages.dev";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  // Staging round-trips (Cloudflare Pages + Worker + Supabase pooler) are
  // slower and colder than a local dev server; give each test room.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Sequential: the specs share one staging tenant and the company-isolation
  // spec mutates the active-company localStorage key. One worker avoids races.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry in CI rides out a cold Hyperdrive pool / Pages edge miss; zero
  // locally so a real failure is obvious the first time.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Desktop viewport (non-touch) so the app renders its desktop shell:
    // TopNavbar + DataTable, not the mobile layer.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
