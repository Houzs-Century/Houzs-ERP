import { expect, test } from "@playwright/test";
import { expectBounded, nextFrames } from "./geometry.helpers";

test("DataTable keeps 10k desktop rows windowed at its real internal scroll limit", async ({ page }) => {
  // The frozen-header work (owner 2026-07-24) made the desktop DataTable its
  // own vertical scroll container — rows scroll INSIDE the capped wrapper and
  // the window's scroll range ends at the frozen composition, so the old
  // "scroll the WINDOW to its clamped end" contract no longer reaches row
  // 10000 by design. The windowing guarantee under a real scroll limit is now
  // the same one the DataGridCompat test below exercises: drive the INNER scroller
  // to its true end and the tail must be live while the DOM stays bounded.
  await page.goto("/?scenario=data-table-desktop");
  const rows = page.locator("tr[data-vrow]");
  const scroller = page.locator('[data-scenario="data-table-desktop"] table').locator("..");
  await expect(rows.first()).toContainText("Order 00001");
  await expectBounded(rows, 60);
  await expect(page.getByText("Order 10000", { exact: true })).toHaveCount(0);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await nextFrames(page, 3);

  await expect(page.getByText("Order 10000", { exact: true })).toBeVisible();
  await expect(page.getByText("Order 00001", { exact: true })).toHaveCount(0);
  await expectBounded(rows, 60);
});

// The SCM DataGrid's props, now rendered by DataTable (one-table plan, 2026-09-26).
test("DataGridCompat keeps 10k rows windowed at its real internal scroll limit", async ({ page }) => {
  await page.goto("/?scenario=data-grid");
  const rows = page.locator("tr[data-vrow]");
  const scroller = page.locator('[data-scenario="data-grid"] table').locator("..");
  await expect(rows.first()).toContainText("Order 00001");
  await expectBounded(rows, 60);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await nextFrames(page, 3);

  const geometry = await scroller.evaluate((element) => ({
    actual: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
  }));
  expect(Math.abs(geometry.actual - geometry.maximum)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Order 10000", { exact: true })).toBeVisible();
  await expect(page.getByText("Order 00001", { exact: true })).toHaveCount(0);
  await expectBounded(rows, 60);
});

test("controlled DataTable hides settled A rows while A1 is pending", async ({ page }) => {
  await page.goto("/?scenario=search");
  const host = page.locator('[data-scenario="search"]');
  const search = page.getByRole("textbox");
  await expect(search).toHaveValue("A");
  await expect(page.getByText("A only result", { exact: true })).toBeVisible();

  await search.fill("A1");
  await expect(search).toHaveValue("A1");
  await expect(host).toHaveAttribute("data-query", "A1");
  await expect(host).toHaveAttribute("data-result-query", "A");
  await expect(host).toHaveAttribute("data-searching", "true");
  await expect(page.getByRole("status")).toContainText("Searching");
  await expect(page.getByText("A only result", { exact: true })).toHaveCount(0);
  await expect(page.getByText("A1 exact result", { exact: true })).toHaveCount(0);

  await page.locator("[data-settle-search]").click();
  await nextFrames(page, 1);

  await expect(host).toHaveAttribute("data-result-query", "A1");
  await expect(host).toHaveAttribute("data-searching", "false");
  await expect(page.getByText("A1 exact result", { exact: true })).toBeVisible();
  await expect(page.getByText("A only result", { exact: true })).toHaveCount(0);
});
