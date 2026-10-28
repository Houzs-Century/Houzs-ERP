// Pins the repair script's row builder for the 0214 RPC
// (scm.rebuild_mfg_so_delivery_lines). The first prod DRY-RUN (workflow run
// 31197887561) died inside jsonb_populate_recordset because the rows were
// double-serialized ("cannot call jsonb_populate_recordset on a non-array") —
// the serialization half is fixed at the call site with sql.json (the
// pg-supabase-transaction.ts lesson); THIS suite pins the other half: the row
// object itself must be exactly the record shape the RPC's
// jsonb_populate_recordset(NULL::scm.mfg_sales_order_items, ...) consumes —
// the right key set, JSON-native scalars only (no Date / undefined / NaN), and
// the same field semantics recomputeDeliveryFeeCore writes.
import { describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs module (the runnable repair script); vitest
// resolves it natively, tsc never sees it (tests are outside tsconfig include).
import { buildFeeLineRow, dateOnly } from '../scripts/repair-so-fee-line-integrity.mjs';

/* The exact column list the 0214 RPC INSERTs from p_rows (migration
   0214_scm_rebuild_so_delivery_lines_rpc.sql), minus company_id — which the
   RPC reads off the SO header and must NOT ride in the row. */
const RPC_ROW_COLUMNS = [
  'doc_no', 'line_no', 'line_date', 'debtor_name', 'item_group', 'item_code',
  'description', 'description2', 'remark', 'uom', 'qty',
  'unit_price_sen', 'discount_sen', 'total_sen', 'total_inc_sen', 'balance_sen',
  'variants', 'unit_cost_sen', 'line_cost_sen', 'line_margin_sen',
  'divan_price_sen', 'leg_price_sen', 'special_order_price_sen', 'custom_specials',
  'line_delivery_date', 'line_delivery_date_overridden', 'warehouse_id',
  'branding', 'venue', 'stock_status',
].sort();

const base = {
  docNo: '2990-SO-2608-006',
  debtorName: 'A CUSTOMER',
  venue: 'SHOWROOM KL',
  customerDeliveryDate: '2026-08-20',
  crossCategorySourceDocNo: null,
  feeSen: 25000,
  keptMaxLineNo: 1,
  lineDate: '2026-08-08',
};

describe('buildFeeLineRow — the record jsonb_populate_recordset consumes', () => {
  test('carries exactly the RPC column set (and never company_id)', () => {
    const row = buildFeeLineRow(base);
    expect(Object.keys(row).sort()).toEqual(RPC_ROW_COLUMNS);
    expect('company_id' in row).toBe(false);
  });

  test('is JSON-native: one stringify/parse round-trip is identity', () => {
    const row = buildFeeLineRow({ ...base, customerDeliveryDate: new Date('2026-08-20T00:00:00Z') });
    // No undefined, NaN, or Date may survive into the record — those are what
    // corrupt a jsonb row. A lossless round-trip proves every value is a
    // JSON-native scalar or null.
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    for (const v of Object.values(row)) {
      expect(v === null || ['string', 'number', 'boolean'].includes(typeof v)).toBe(true);
    }
  });

  test('base fee: SVC-DELIVERY, every money field mirrors the header fee', () => {
    const row = buildFeeLineRow(base);
    expect(row.item_code).toBe('SVC-DELIVERY');
    expect(row.description).toBe('Delivery fee');
    expect(row.remark).toBeNull();
    expect(row.qty).toBe(1);
    for (const k of ['unit_price_sen', 'total_sen', 'total_inc_sen', 'balance_sen', 'line_margin_sen']) {
      expect(row[k]).toBe(25000);
    }
    for (const k of ['discount_sen', 'unit_cost_sen', 'line_cost_sen', 'divan_price_sen', 'leg_price_sen', 'special_order_price_sen']) {
      expect(row[k]).toBe(0);
    }
    expect(row.line_no).toBe(2); // kept max + 1, matching recomputeDeliveryFeeCore
    expect(row.item_group).toBe('service');
    expect(row.stock_status).toBe('READY');
  });

  test('stored cross-category source: SVC-DELIVERY-CROSS with the follow-up remark', () => {
    const row = buildFeeLineRow({ ...base, crossCategorySourceDocNo: '2990-SO-2607-001' });
    expect(row.item_code).toBe('SVC-DELIVERY-CROSS');
    expect(row.description).toBe('Cross-category delivery');
    expect(row.remark).toBe('Follow-up of 2990-SO-2607-001');
    expect(row.total_sen).toBe(25000);
  });

  test('no kept lines → line_no null; date from a Date object lands as YYYY-MM-DD', () => {
    const row = buildFeeLineRow({
      ...base,
      keptMaxLineNo: null,
      customerDeliveryDate: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(row.line_no).toBeNull();
    expect(row.line_delivery_date).toBe('2026-08-20');
  });

  test('refuses a non-positive or non-finite fee', () => {
    expect(() => buildFeeLineRow({ ...base, feeSen: 0 })).toThrow();
    expect(() => buildFeeLineRow({ ...base, feeSen: NaN })).toThrow();
  });
});

describe('dateOnly', () => {
  test('normalizes Date / ISO string / null', () => {
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(new Date('2026-08-06T00:00:00.000Z'))).toBe('2026-08-06');
    expect(dateOnly('2026-08-06')).toBe('2026-08-06');
    expect(dateOnly('2026-08-06T16:00:00.000Z')).toBe('2026-08-06');
  });
});
