import { test, expect } from "@playwright/test";
import {
  apiLogin,
  seedAuth,
  credsConfigured,
  isSkippableStagingError,
  missingCredentialsMaySkip,
  stagingProofRequired,
} from "./fixtures";

// The Sales Orders list request (vendor authed-fetch -> `${API_URL}/mfg-sales-orders`,
// API_URL ends in /api/scm). Matches the LIST call (`/mfg-sales-orders` or
// `?...`) but not a `/mfg-sales-orders/:docNo` detail.
const SO_LIST_URL = /\/mfg-sales-orders(\?|$)/;

test.describe("SO list", () => {
  test.beforeEach(() => {
    test.skip(
      missingCredentialsMaySkip(credsConfigured, stagingProofRequired),
      "Staging credentials not configured — set STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD.",
    );
  });

  test("renders rows or an explicit empty state, with no uncaught errors", async ({
    page,
    context,
    request,
  }) => {
    // Fail the test if the app throws an uncaught error or logs an "Uncaught …"
    // console error while the list loads. `pageerror` is exactly an uncaught
    // exception; the console filter catches anything surfaced as text.
    const uncaught: string[] = [];
    page.on("pageerror", (err) => uncaught.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error" && /uncaught/i.test(msg.text())) {
        uncaught.push(`console.error: ${msg.text()}`);
      }
    });

    let token: string;
    try {
      token = await apiLogin(request);
    } catch (e) {
      if (isSkippableStagingError(e)) {
        test.skip(true, e.message);
        return;
      }
      throw e;
    }
    await seedAuth(context, token);

    const listResponse = page.waitForResponse(
      (r) => SO_LIST_URL.test(r.url()) && r.request().method() === "GET",
      { timeout: 45_000 },
    );
    await page.goto("/scm/sales-orders");

    // The page shell rendered — never a white screen or an error-boundary
    // fallback. The list heading is present regardless of row count.
    await expect(page.getByRole("heading", { name: "Sales Orders" })).toBeVisible();

    // The list request actually completed.
    await listResponse;

    // The grid never shows its "Failed to load" error cell...
    await expect(page.getByText("Failed to load")).toHaveCount(0);

    // ...and it shows EITHER at least one data row (the mono doc-no cell) OR the
    // explicit empty-state label ("No sales orders yet." / "No sales orders
    // match ..."). One of the two must be visible.
    const anyDocCell = page.locator("table tbody td span.font-mono").first();
    const emptyState = page.getByText(/no sales orders/i).first();
    await expect(anyDocCell.or(emptyState)).toBeVisible();

    expect(uncaught, `uncaught errors during SO list load: ${uncaught.join(" | ")}`).toHaveLength(
      0,
    );
  });
});
