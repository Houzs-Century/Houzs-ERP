/* Owner 2026-09-28: 「purchase return - 是可以退货维修，然后supplier再送回来」 and
 * 「when raise purchase return need input reason and put in remark」.
 *
 * Phase 1: a return says WHY (a code, mandatory) and WHAT FOR — money back
 * (CREDIT) or goods back (REPAIR). A repair does not take the stock off the
 * books: each line's OUT is paired with an IN to the repair warehouse, which is
 * what the warehouse was doing by hand with stock transfers (18 movements into
 * KL SERVICE between 2026-09-18 and 09-24, recording nothing but the move).
 *
 * The endpoint needs a live DB, so these pin the SOURCE shapes — the same style
 * as purchaseReturnFromPoLinked.test.ts. The rules themselves are asserted in
 * scm/shared/purchase-return-reasons.test.ts. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BE = readFileSync(resolve(__dirname, '../src/scm/routes/purchase-returns.ts'), 'utf8');
const MIG = readFileSync(
  resolve(__dirname, '../src/db/migrations-pg/20260928T0800_scm_purchase_return_repair_kind.sql'),
  'utf8',
);
const FE = readFileSync(
  resolve(__dirname, '../../frontend/src/pages/scm-v2/PurchaseReturnNew.tsx'),
  'utf8',
);

const createHandler = (() => {
  const start = BE.indexOf("purchaseReturns.post('/', async (c) => {");
  return start < 0 ? '' : BE.slice(start, BE.indexOf("purchaseReturns.post('/from-grns'", start));
})();

describe('raising a return says why, before anything is written', () => {
  it('finds the handler (a pin over nothing must not pass)', () => {
    expect(createHandler).toContain("from('purchase_returns').insert(");
  });

  it('refuses a missing or unknown reason, and refuses it as a NO-WRITE', () => {
    expect(createHandler).toContain("error: 'reason_required'");
    expect(createHandler).toContain("error: 'reason_invalid'");
    /* `refuse` is the helper that marks the idempotency claim unused; a plain
       c.json would leave the operator with idempotency_key_reused after fixing
       the reason. Both checks must go through it. */
    expect(createHandler).toMatch(/return refuse\(400, \{ error: 'reason_required'/);
  });

  it('validates the code against the SHARED catalogue, keeping no second list', () => {
    expect(createHandler).toContain('isPurchaseReturnReasonCode(reasonCode)');
    expect(createHandler).not.toMatch(/\['DAMAGED'|"DAMAGED"/);
  });

  it('stores the code, not the raw body field', () => {
    const insert = createHandler.slice(createHandler.indexOf("from('purchase_returns').insert("));
    expect(insert).toContain('reason: reasonCode,');
    expect(insert).toContain('kind,');
    expect(insert).toContain('repair_warehouse_id: repairWarehouseId,');
  });
});

describe('a repair return keeps the goods on the books', () => {
  it('refuses a repair with nowhere for the goods to sit', () => {
    expect(createHandler).toContain("error: 'repair_warehouse_required'");
    // …and refuses a repair warehouse on a return that is not a repair.
    expect(createHandler).toContain("error: 'repair_warehouse_not_applicable'");
  });

  it('pairs every OUT with an IN to that warehouse, and reports a failed IN', () => {
    const writer = BE.slice(BE.indexOf('async function writePurchaseReturnMovements'));
    expect(writer).toContain("movement_type: 'IN' as const");
    expect(writer).toContain('warehouse_id: repairWarehouseId');
    /* Same line, same qty, same batch — one pair, so stock is never in two
       places and never in none. */
    expect(writer).toMatch(/movements\.map\(\(m\) => \(\{ \.\.\.m, movement_type: 'IN'/);
    expect(writer).toContain('`IN ${returnNumber}:');
  });

  it('reads kind + repair warehouse off the header, never off the request', () => {
    const writer = BE.slice(BE.indexOf('async function writePurchaseReturnMovements'));
    expect(writer).toContain(".select('company_id, kind, repair_warehouse_id')");
    expect(writer).toMatch(/prHead\?\.kind === 'REPAIR'/);
  });
});

describe('the migration', () => {
  it('adds both columns re-runnably, and ties them together', () => {
    expect(MIG).toContain('ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT \'CREDIT\'');
    expect(MIG).toContain('ADD COLUMN IF NOT EXISTS repair_warehouse_id uuid REFERENCES scm.warehouses(id)');
    expect(MIG).toContain("CHECK (kind IN ('CREDIT', 'REPAIR'))");
    // A repair must say where the goods went; a credit return must not.
    expect(MIG).toContain("CHECK ((kind = 'REPAIR') = (repair_warehouse_id IS NOT NULL))");
  });

  it('carries the reversal the release discipline asks for', () => {
    expect(MIG).toContain('REVERSAL:');
  });
});

describe('the form asks for both', () => {
  it('offers the shared catalogue rather than a free-text box', () => {
    expect(FE).toContain('PURCHASE_RETURN_REASONS.map');
    expect(FE).not.toContain('placeholder="e.g. defective, wrong colour, over-supply"');
  });

  it('will not submit without a reason, or a repair with no warehouse', () => {
    expect(FE).toContain('!!reason && (!isRepair || !!repairWarehouseId)');
  });

  it('finds the repair locations by their TYPE, not by their name', () => {
    expect(FE).toContain("=== 'service'");
    expect(FE).not.toMatch(/endsWith\('SERVICE'\)|includes\('SERVICE'\)/);
  });
});
