/* SO create: the deposit rows come after the order's lines (ported from Conts-ERP #1137, D5).

   Symptom: a new order with a deposit whose line insert failed was deleted, but the deposit row's journal (booked by
   bookSoPaymentBestEffort as the row was written) stayed in the ledger; and a deposit row that failed to write was
   only logged while the order read as saved.
   Cause: createSalesOrderCore wrote the deposit rows, and booked them, before minting SKUs and inserting the lines.
   Fix: the deposit block runs after the line insert, and a failed row is returned as paymentErrors, which the create
   hook and the phone scan show.

   WHY A SOURCE TEST: the create handler needs D1, R2 and the admin client, and runs on Supabase, which this suite does
   not bind (same technique as soLocationGateWiring.test.ts). Fails on the code before the fix. */
import { describe, expect, test } from 'vitest';
import { soRouterSource } from './lib/so-router-source';

const src = soRouterSource();

describe('SO create: deposit after lines, and a failed deposit is said', () => {
  const linesInsert = src.indexOf("from('mfg_sales_order_items').insert(stampCo(rowsWithDoc))");
  const splitDeposit = src.indexOf("'POS split payment (auto-recorded at SO create)'");
  const singleDeposit = src.indexOf("note:               'POS deposit (auto-recorded at SO create)'");

  test('both deposit paths are written after the line insert', () => {
    expect(linesInsert).toBeGreaterThan(0);
    expect(splitDeposit).toBeGreaterThan(linesInsert);
    expect(singleDeposit).toBeGreaterThan(linesInsert);
  });

  test('a failed deposit row reaches the response', () => {
    const between = src.slice(splitDeposit, src.indexOf('/* ── FAIR LINK (owner 2026-09-13)', splitDeposit));
    expect((between.match(/paymentErrors\.push\(/g) ?? []).length).toBe(2);
    expect(src).toContain('return c.json({ ...created, ...(paymentErrors.length ? { paymentErrors } : {}) }, 201);');
  });
});
