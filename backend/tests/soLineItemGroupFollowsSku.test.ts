/* docs/bugs/0514 installed one rule — a line's item_group is the SKU's, not the
   caller's opinion — and by 2026-09-12 it stood at nine doors (PO create, PO
   add-item, PO convert, GRN create, GRN add-line, DO add-line, consignment x2,
   SO create) and was missing at the two doors on the document every other one
   copies from: SO add-item (POST /:docNo/items) and SO line PATCH
   (PATCH /:docNo/items/:itemId). Both wrote whatever the request carried
   (`it.itemGroup ?? 'others'` / `it.itemGroup !== undefined ? String(it.itemGroup)
   : prev.item_group`). A sofa landing on `others` is not hard-bound, so the MRP
   engine cannot see its purchase order and reports the line SHORT — the exact
   symptom of docs/bugs/0813, which fixed the PO side and not this one. The
   mobile add-item payload sends `itemGroup: l.itemGroup || "others"`, so the
   phone hits this more often than the desktop.

   The SO handlers are not exported, so this pins the SOURCE the way the other
   SO route tests do (mfgSalesOrderAuthzBeforeLease.test.ts): the two doors must
   resolve the group through skuCategoryResolver, and the two caller-wins
   spellings must be gone. The resolver's own behaviour is pinned in
   sku-category's tests; this file pins that the SO doors USE it. */
import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

const slice = (from: string, to: string) => {
  const a = routeSource.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = routeSource.indexOf(to, a + from.length);
  expect(b, `anchor not found after ${from}: ${to}`).toBeGreaterThan(a);
  return routeSource.slice(a, b);
};

describe('SO line item_group follows the SKU at the add-item and PATCH doors', () => {
  const addItem = slice("mfgSalesOrders.post('/:docNo/items', async (c) => {", "mfgSalesOrders.patch('/:docNo/items/:itemId'");
  const patchItem = slice("mfgSalesOrders.patch('/:docNo/items/:itemId', async (c) => {", "mfgSalesOrders.patch('/:docNo/items/:itemId/stock-status'");

  test('POST /:docNo/items resolves the group from the SKU master', () => {
    expect(addItem).toContain('skuCategoryResolver(');
    expect(addItem).not.toContain("item_group: it.itemGroup ?? 'others'");
  });

  test('PATCH /:docNo/items/:itemId resolves the group from the SKU master and never copies the request field through', () => {
    expect(patchItem).toContain('skuCategoryResolver(');
    expect(patchItem).not.toContain("it.itemGroup !== undefined ? String(it.itemGroup) : prev.item_group");
    expect(patchItem).not.toContain("['itemGroup', 'item_group']");
  });

  test('the slices are the real handlers, not empty ranges', () => {
    expect(addItem.length).toBeGreaterThan(2000);
    expect(patchItem.length).toBeGreaterThan(2000);
  });
});
