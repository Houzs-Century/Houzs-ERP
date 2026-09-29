/* The planner behind merge-duplicate-skus.mjs (BUG-38: AKEMI / HAPPI SLEEP
 * SOLITUDE mattress under two codes). Every refusal is a case where acting would
 * have split or lost something real. The pairs file is pinned here too, so the
 * ruling cannot drift from what the script will run.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMappingCsv } from '../scripts/lib/ac-mapping-csv.mjs';
import { PRODUCT_CODE_CASCADE } from '../src/scm/lib/product-code-rename';
import { planDuplicateSkuMerge, confirmPhrase, STAYS_ON_DROP } from '../scripts/lib/duplicate-sku-merge-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'scripts', 'data');

const DROP = 'AKEMI SOLITUDE MATT (Q)';
const KEEP = 'HAPPI SLEEP SOLITUDE MATT (Q)';
const product = (code, over = {}) => ({ id: `p-${code}`, code, status: 'ACTIVE', category: 'MATTRESS', ...over });
const ref = (table, rows, over = {}) => ({ table, col: 'item_code', code: DROP, rows, hasId: true, ...over });

const plan = (over) => planDuplicateSkuMerge({
  pairs: [{ drop: DROP, keep: KEEP }],
  products: [product(DROP), product(KEEP)],
  refs: [],
  stock: [],
  stockTakeLines: [],
  ...over,
});

describe('BUG-38 pairs file', () => {
  const book = JSON.parse(fs.readFileSync(path.join(DATA, 'duplicate-sku-merges.json'), 'utf8'));
  const pairs = book['BUG-38'].pairs;

  it('merges the four duplicated sizes into HAPPI SLEEP, and leaves K and SS alone', () => {
    expect(pairs.map((p) => p.drop)).toEqual(['Q', 'S', 'SK', 'SP'].map((s) => `AKEMI SOLITUDE MATT (${s})`));
    expect(pairs.map((p) => p.keep)).toEqual(['Q', 'S', 'SK', 'SP'].map((s) => `HAPPI SLEEP SOLITUDE MATT (${s})`));
  });

  it('keeps the code AutoCount already maps to, so a pulled document lands on the survivor', () => {
    const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, 'autocount-erp-mapping-1561.csv'), 'utf8'));
    const erpCodes = new Set([...mapping.values()].map((m) => m.erp));
    for (const p of pairs) {
      expect(erpCodes.has(p.keep)).toBe(true);
      expect(erpCodes.has(p.drop)).toBe(false);
    }
  });
});

describe('planDuplicateSkuMerge', () => {
  it('re-keys documents and stock, leaves catalogue-side rows, and retires the dropped row', () => {
    const r = plan({
      refs: [ref('mfg_sales_order_items', 2), ref('purchase_order_items', 1), ref('inventory_movements', 3), ref('supplier_material_bindings', 1)],
      stock: [{ code: DROP, warehouseCode: 'HQ', ledgerQty: 1, lotQty: 1 }],
    });
    const p = r.pairs[0];
    expect(p.refusals).toEqual([]);
    expect(p.rekey.map((x) => x.table)).toEqual(['mfg_sales_order_items', 'purchase_order_items', 'inventory_movements']);
    expect(p.stay.map((x) => x.table)).toEqual(['supplier_material_bindings']);
    expect(p.unitsMoved).toBe(1);
    expect(p.retire).toBe(true);
    expect(r.totals).toEqual({ pairs: 1, refused: 0, rowsToRekey: 6, unitsMoved: 1, toRetire: 1 });
    expect(confirmPhrase(r.totals)).toBe('MERGE 1 CODES: REKEY 6 ROWS, MOVE 1 UNITS, RETIRE 1');
  });

  it('plans nothing on a re-run after the apply', () => {
    const r = plan({
      products: [product(DROP, { status: 'INACTIVE' }), product(KEEP)],
      refs: [ref('supplier_material_bindings', 1)],
    });
    expect(r.pairs[0].refusals).toEqual([]);
    expect(r.totals).toMatchObject({ rowsToRekey: 0, unitsMoved: 0, toRetire: 0 });
  });

  it('refuses when the ledger and the open lots disagree, or the dropped code is negative', () => {
    const mismatch = plan({ stock: [{ code: DROP, warehouseCode: 'HQ', ledgerQty: 2, lotQty: 1 }], refs: [ref('mfg_sales_order_items', 1)] });
    expect(mismatch.pairs[0].refusals[0]).toMatch(/ledger says 2 and the open lots say 1/);
    expect(mismatch.pairs[0].rekey).toEqual([]);
    expect(mismatch.pairs[0].retire).toBe(false);
    const negative = plan({ stock: [{ code: DROP, warehouseCode: 'HQ', ledgerQty: -1, lotQty: -1 }] });
    expect(negative.pairs[0].refusals[0]).toMatch(/is at -1/);
  });

  it('refuses a missing or inactive survivor, a category mismatch, and a self-merge', () => {
    expect(plan({ products: [product(DROP)] }).pairs[0].refusals[0]).toMatch(/not in the catalogue/);
    expect(plan({ products: [product(DROP), product(KEEP, { status: 'INACTIVE' })] }).pairs[0].refusals[0]).toMatch(/INACTIVE, not ACTIVE/);
    expect(plan({ products: [product(DROP), product(KEEP, { category: 'BEDFRAME' })] }).pairs[0].refusals[0]).toMatch(/category/);
    expect(plan({ pairs: [{ drop: DROP, keep: DROP }] }).pairs[0].refusals[0]).toMatch(/into itself/);
  });

  it('refuses a chain, where a kept code is itself merged away', () => {
    const other = 'HAPPI SLEEP SOLITUDE MATT (X)';
    const r = plan({ pairs: [{ drop: DROP, keep: KEEP }, { drop: KEEP, keep: other }], products: [product(DROP), product(KEEP), product(other)] });
    expect(r.pairs[0].refusals.join(' ')).toMatch(/also being merged away/);
  });

  it('refuses a re-key it could not undo row by row', () => {
    const r = plan({ refs: [ref('hr_item_kpi', 1, { col: 'ref', hasId: false }), ref('warehouse_rack_items', 1, { hasId: false })] });
    expect(r.pairs[0].refusals).toEqual(['scm.warehouse_rack_items has no id column, so a re-key could not be undone row by row']);
  });

  describe('stock take lines - unique per (take, code, variant), so the kept line is usually already there', () => {
    const take = (id, over = {}) => ({ id, code: DROP, takeStatus: 'POSTED', collides: true, systemQty: 0, countedQty: 0, ...over });

    it("leaves a closed take's line as the record of that count, and does not re-key it into a collision", () => {
      const r = plan({ refs: [ref('stock_take_lines', 2)], stockTakeLines: [take('t1'), take('t2', { takeStatus: 'CANCELLED', collides: false })] });
      expect(r.pairs[0].refusals).toEqual([]);
      expect(r.pairs[0].rekey).toEqual([]);
      expect(r.pairs[0].stay).toEqual([{ table: 'stock_take_lines', col: 'item_code', rows: 2 }]);
      expect(r.pairs[0].retire).toBe(true);
    });

    it("moves an open take's line only where the kept code has none", () => {
      const r = plan({ stockTakeLines: [take('t1', { takeStatus: 'OPEN', collides: false }), take('t2', { takeStatus: 'OPEN' })] });
      expect(r.pairs[0].rekey).toEqual([{ table: 'stock_take_lines', col: 'item_code', rows: 1, ids: ['t1'] }]);
      expect(r.pairs[0].stay).toEqual([{ table: 'stock_take_lines', col: 'item_code', rows: 1 }]);
    });

    it('refuses while an open take has counted the dropped code beside the kept one', () => {
      const r = plan({ stockTakeLines: [take('t1', { takeStatus: 'OPEN', countedQty: 1 })] });
      expect(r.pairs[0].refusals[0]).toMatch(/OPEN stock take counts/);
      expect(r.pairs[0].retire).toBe(false);
    });
  });

  it('only leaves behind tables the rename cascade knows about', () => {
    const cascadeTables = new Set(PRODUCT_CODE_CASCADE.map((c) => c.table));
    for (const t of STAYS_ON_DROP) expect(cascadeTables.has(t)).toBe(true);
  });
});
