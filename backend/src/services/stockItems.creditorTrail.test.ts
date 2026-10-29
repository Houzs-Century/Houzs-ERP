// HC-0130: the auto-resolver's "creditor_resolved" trail row named a
// created_by column that assr_activity does not have, so every insert failed
// and was swallowed: no case showed when or from where its supplier came. The
// fake DB refuses an assr_activity column the real table lacks.
// Farra's rule: PO, else SO supplier, else blank — AutoCount's MainSupplier is
// never used, even when the stock_items cache has one.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const order = vi.hoisted(() => ({ result: null as { code: string; source: 'po' | 'so' } | 'so-missing' | null, withPo: new Set<string>(), updChanges: 1 }));
vi.mock('../db/supabase', () => ({ isSupabaseConfigured: () => true, getSupabaseService: () => ({}) }));
vi.mock('./assrOrderPos', () => ({
  orderSupplierCode: async () => order.result,
  itemsWithLivePo: async () => order.withPo,
  poKey: (c: unknown, d: unknown, i: unknown) => `${c}|${d}|${i}`,
}));
vi.mock('./logger', () => ({ writeLog: async () => undefined }));
vi.mock('./autocount', () => ({
  AutoCountClient: class { async getStockItem(code: string) { return { ItemCode: code, MainSupplier: '400-D002' }; } },
}));

import { resolveCreditorForCase, runStockItemsRefresh } from './stockItems';
import { fillCreditorFromNewPo } from './assr';
import type { Env } from '../types';

const ACTIVITY_COLS = new Set([
  'id', 'assr_id', 'action', 'from_value', 'to_value', 'note', 'user_id', 'category', 'created_at',
  'stage_elapsed_days', 'stage_target_days', 'source_channel', 'references_entry_id', 'is_correction',
]);

const BLANK = { creditor_code: null, creditor_source: null };
function fakeEnv(inserted: Array<unknown[]>, sqls: string[], current: { creditor_code: string | null; creditor_source: string | null } = BLANK) {
  const DB = {
    prepare(sql: string) {
      sqls.push(sql);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (sql.includes('FROM assr_cases')) return { ...current, doc_no: 'HC-SO-1', company_id: 1 };
          if (sql.includes('FROM stock_items')) return { item_code: 'MAT-1', main_supplier: '400-D002' };
          return null;
        },
        async run() {
          const m = sql.match(/INSERT INTO assr_activity \(([^)]*)\)/);
          if (m) {
            const bad = m[1].split(',').map((c) => c.trim()).filter((c) => !ACTIVITY_COLS.has(c));
            if (bad.length) throw new Error(`column ${bad.join(', ')} does not exist`);
            inserted.push(args);
          }
          return { meta: { changes: /UPDATE\s+assr_cases/.test(sql) ? order.updChanges : 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB } as unknown as Env;
}

describe('resolveCreditorForCase', () => {
  beforeEach(() => { order.result = null; order.withPo = new Set(); order.updChanges = 1; });

  test('writes a creditor_resolved row the real assr_activity table accepts', async () => {
    order.result = { code: '400-H003', source: 'so' };
    const inserted: Array<unknown[]> = [];
    expect(await resolveCreditorForCase(fakeEnv(inserted, []), 5, 'MAT-1')).toEqual({ code: '400-H003', soMissing: false });
    expect(inserted).toEqual([[5, null, '400-H003', 'Auto-resolved from the SO supplier of item MAT-1']]);
  });

  test('no PO or SO supplier leaves it blank and never reads AutoCount', async () => {
    const inserted: Array<unknown[]> = [];
    const sqls: string[] = [];
    expect(await resolveCreditorForCase(fakeEnv(inserted, sqls), 5, 'MAT-1')).toEqual({ code: null, soMissing: false });
    expect(sqls.some((s) => s.includes('stock_items'))).toBe(false);
    expect(inserted).toEqual([]);
  });

  test('SO not in the ERP: Resolve now keeps the current supplier and source (YH, 21 Oct)', async () => {
    order.result = 'so-missing';
    const inserted: Array<unknown[]> = [];
    const sqls: string[] = [];
    const env = fakeEnv(inserted, sqls, { creditor_code: '400-D002', creditor_source: 'auto' });
    expect(await resolveCreditorForCase(env, 5, 'MAT-1', { force: true })).toEqual({ code: '400-D002', soMissing: true });
    expect(sqls.filter((s) => /UPDATE\s+assr_cases/.test(s))).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test('Resolve now with no PO and no SO supplier keeps the existing pick', async () => {
    const inserted: Array<unknown[]> = [];
    const sqls: string[] = [];
    const env = fakeEnv(inserted, sqls, { creditor_code: '400-D002', creditor_source: 'manual' });
    expect(await resolveCreditorForCase(env, 5, 'MAT-1', { force: true })).toEqual({ code: '400-D002', soMissing: false, kept: true });
    expect(sqls.filter((s) => /UPDATE\s+assr_cases/.test(s))).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test('a manual pick is not overwritten by the PO supplier without force', async () => {
    order.result = { code: '400-H003', source: 'po' };
    const sqls: string[] = [];
    const env = fakeEnv([], sqls, { creditor_code: '400-D002', creditor_source: 'manual' });
    expect(await resolveCreditorForCase(env, 5, 'MAT-1')).toEqual({ code: '400-D002', soMissing: false });
    expect(sqls.filter((s) => /UPDATE\s+assr_cases/.test(s))).toEqual([]);
  });
});

describe('stale read', () => {
  beforeEach(() => { order.updChanges = 1; });
  test('the UPDATE refuses a manual pick and a lost race logs nothing', async () => {
    order.result = { code: '400-H003', source: 'po' };
    order.updChanges = 0; // someone hand-picked between our read and our write
    const inserted: Array<unknown[]> = [];
    const sqls: string[] = [];
    const res = await resolveCreditorForCase(fakeEnv(inserted, sqls), 5, 'MAT-1');
    expect(sqls.find((q) => /UPDATE\s+assr_cases/.test(q))).toMatch(/creditor_source <> 'manual'/);
    expect(res.code).toBeNull();
    expect(inserted).toEqual([]);
  });
});

describe('fillCreditorFromNewPo', () => {
  beforeEach(() => { order.updChanges = 1; });
  test('an unrelated item PO on the SO does not trigger a resolve', async () => {
    order.result = { code: '400-H003', source: 'po' };
    const sqls: string[] = [];
    const rows: Array<Record<string, any>> = [
      { id: 1, company_id: 1, doc_no: 'HC-SO-1', item_code: 'ITEM-B', creditor_code: null, order_pos: [{ id: 'p', po_number: 'PO-1' }] },
    ];
    order.withPo = new Set(['1|HC-SO-1|ITEM-A']);
    await fillCreditorFromNewPo(fakeEnv([], sqls), rows);
    expect(rows[0].creditor_code).toBeNull();
    expect(sqls.filter((q) => /assr_cases/.test(q))).toEqual([]);
  });

  test('a blank row with a live PO gets the PO supplier; manual, filled and PO-less rows are left alone', async () => {
    order.result = { code: '400-H003', source: 'po' };
    const sqls: string[] = [];
    const rows: Array<Record<string, any>> = [
      { id: 1, company_id: 1, doc_no: 'D', item_code: 'MAT-1', creditor_code: null, creditor_source: null, order_pos: [{ id: 'p', po_number: 'PO-1' }] },
      { id: 2, item_code: 'MAT-1', creditor_code: null, creditor_source: 'manual', order_pos: [{ id: 'p', po_number: 'PO-1' }] },
      { id: 3, item_code: 'MAT-1', creditor_code: '400-X', creditor_source: 'so', order_pos: [{ id: 'p', po_number: 'PO-1' }] },
      { id: 4, item_code: 'MAT-1', creditor_code: null, creditor_source: null, order_pos: [] },
    ];
    order.withPo = new Set(['1|D|MAT-1']);
    for (const r of rows) { r.company_id = 1; r.doc_no = 'D'; }
    await fillCreditorFromNewPo(fakeEnv([], sqls), rows);
    expect(rows.map((r) => r.creditor_code)).toEqual(['400-H003', null, '400-X', null]);
    expect(sqls.filter((q) => /UPDATE\s+assr_cases/.test(q))).toHaveLength(1);
  });
});

describe('runStockItemsRefresh', () => {
  test('updates stock items only and never writes a case (HC-0130)', async () => {
    const sqls: string[] = [];
    const DB = {
      prepare(sql: string) {
        sqls.push(sql);
        const stmt = {
          bind() { return stmt; },
          async all() { return { results: [{ item_code: 'MAT-1' }] }; },
          async first() { return null; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const res = await runStockItemsRefresh({ DB } as unknown as Env);
    expect(res.upserted).toBe(1);
    expect(res.cases_updated).toBe(0);
    expect(sqls.some((s) => s.includes('INSERT INTO stock_items'))).toBe(true);
    expect(sqls.filter((s) => /UPDATE\s+assr_cases|INSERT INTO assr_activity/i.test(s))).toEqual([]);
  });
});
