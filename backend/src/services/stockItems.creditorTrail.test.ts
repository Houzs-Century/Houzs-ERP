// HC-0130: the auto-resolver's "creditor_resolved" trail row named a
// created_by column that assr_activity does not have, so every insert failed
// and was swallowed: no case showed when or from where its supplier came. The
// fake DB refuses an assr_activity column the real table lacks.
// Farra's rule: PO, else SO supplier, else blank — AutoCount's MainSupplier is
// never used, even when the stock_items cache has one.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const order = vi.hoisted(() => ({ result: null as { code: string; source: 'po' | 'so' } | null }));
vi.mock('../db/supabase', () => ({ isSupabaseConfigured: () => true, getSupabaseService: () => ({}) }));
vi.mock('./assrOrderPos', () => ({ orderSupplierCode: async () => order.result }));
vi.mock('./logger', () => ({ writeLog: async () => undefined }));
vi.mock('./autocount', () => ({
  AutoCountClient: class { async getStockItem(code: string) { return { ItemCode: code, MainSupplier: '400-D002' }; } },
}));

import { resolveCreditorForCase, runStockItemsRefresh } from './stockItems';
import type { Env } from '../types';

const ACTIVITY_COLS = new Set([
  'id', 'assr_id', 'action', 'from_value', 'to_value', 'note', 'user_id', 'category', 'created_at',
  'stage_elapsed_days', 'stage_target_days', 'source_channel', 'references_entry_id', 'is_correction',
]);

function fakeEnv(inserted: Array<unknown[]>, sqls: string[]) {
  const DB = {
    prepare(sql: string) {
      sqls.push(sql);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (sql.includes('FROM assr_cases')) return { creditor_code: null, creditor_source: null, doc_no: 'HC-SO-1', company_id: 1 };
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
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB } as unknown as Env;
}

describe('resolveCreditorForCase', () => {
  beforeEach(() => { order.result = null; });

  test('writes a creditor_resolved row the real assr_activity table accepts', async () => {
    order.result = { code: '400-H003', source: 'so' };
    const inserted: Array<unknown[]> = [];
    expect(await resolveCreditorForCase(fakeEnv(inserted, []), 5, 'MAT-1')).toBe('400-H003');
    expect(inserted).toEqual([[5, null, '400-H003', 'Auto-resolved from the SO supplier of item MAT-1']]);
  });

  test('no PO or SO supplier leaves it blank and never reads AutoCount', async () => {
    const inserted: Array<unknown[]> = [];
    const sqls: string[] = [];
    expect(await resolveCreditorForCase(fakeEnv(inserted, sqls), 5, 'MAT-1')).toBeNull();
    expect(sqls.some((s) => s.includes('stock_items'))).toBe(false);
    expect(inserted).toEqual([]);
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
