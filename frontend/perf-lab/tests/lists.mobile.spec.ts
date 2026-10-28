import { expect, test } from "@playwright/test";
import { expectBounded, scrollWindowToRealEnd } from "./geometry.helpers";

test("MobileVirtualList reaches a variable-height 10k tail with bounded DOM", async ({ page }) => {
  await page.goto("/?scenario=mobile-virtual-list");
  const cards = page.locator("[data-vcard]");
  await expect(cards.first()).toContainText("Order 00001");
  await expectBounded(cards, 100);

  const sampledHeights = await cards.evaluateAll((elements) =>
    [...new Set(elements.slice(0, 4).map((element) => element.getBoundingClientRect().height))],
  );
  expect(sampledHeights.length).toBeGreaterThan(1);

  await scrollWindowToRealEnd(page);

  await expect(page.getByText("Order 10000", { exact: true })).toBeVisible();
  await expect(page.getByText("Order 00001", { exact: true })).toHaveCount(0);
  await expectBounded(cards, 100);
});

test("DataTable mobile cards use the same real 10k windowing contract", async ({ page }) => {
  await page.goto("/?scenario=data-table-mobile");
  const cards = page.locator("[data-mobile-card]");
  const virtualCards = page.locator("[data-vcard]");
  await expect(cards.first()).toContainText("Order 00001");
  await expectBounded(cards, 100);
  await expectBounded(virtualCards, 100);

  await scrollWindowToRealEnd(page);

  await expect(page.getByText("Order 10000", { exact: true })).toBeVisible();
  await expect(page.getByText("Order 00001", { exact: true })).toHaveCount(0);
  await expectBounded(cards, 100);
  await expectBounded(virtualCards, 100);
});
