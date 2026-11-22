/* HC-0145: the 15-minute cron warms the Procurement Overview page (due to month
   end) and the home Overview (due today). The two differ only in "due to", which
   no read uses, so each company is read once and both copies are built from it.
   At the 2026-10-23 peak the run took 105 s reading every company twice. */
import { describe, expect, it, vi } from 'vitest';
import {
  buildProcurementOverview, procurementOverviewKey, procurementOverviewParams, refreshProcurementOverviewSnapshots,
} from '../src/scm/routes/procurement-overview';
import { MRP_REFRESH_COMPANY_IDS } from '../src/scm/lib/mrp-snapshot';
import type { Env } from '../src/types';

type Row = Record<string, unknown>;

/* One open PO line due 28 Oct: inside "due to month end", outside "due today". */
const tables: Record<string, Row[]> = {
  purchase_orders: [{ id: 'po-1', po_number: 'HC-PO-2610-001', po_date: '2026-10-05', supplier_id: 'sup-1', expected_at: null }],
  purchase_order_items: [{
    id: 'poi-1', purchase_order_id: 'po-1', item_code: 'BF-1', item_group: 'BEDFRAME', description: 'Bedframe',
    qty: 2, received_qty: 0, unit_price_sen: 10000, line_total_sen: 20000, delivery_date: '2026-10-28', so_item_id: null,
  }],
  suppliers: [{ id: 'sup-1', name: 'S' }],
};

/* Every read answers with the table's rows, filters ignored: this suite counts
   reads, it does not test what a filter keeps. */
const reads: string[] = [];
function countingSb() {
  return {
    from(table: string) {
      reads.push(table);
      const q: unknown = new Proxy({}, {
        get: (_t, k) => (k === 'then'
          ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, ko)
          : () => q),
      });
      return q;
    },
  };
}
vi.mock('../src/db/supabase', () => ({ getSupabaseService: () => countingSb() }));

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string, opts?: { type: string }) => { const v = m.get(k); return v == null ? null : opts?.type === 'json' ? JSON.parse(v) : v; },
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  } as unknown as KVNamespace & { m: Map<string, string> };
}

const today = '2026-10-23';
const page = procurementOverviewParams((k) => (k === 'dueTo' ? '2026-10-31' : undefined), today);
const home = procurementOverviewParams(() => undefined, today);
const ctxOf = (companyId: number) => ({ get: (k: string) => (k === 'companyId' ? companyId : undefined) });
const json = (x: unknown) => JSON.parse(JSON.stringify(x));

describe('procurement overview cron', () => {
  it('reads each company once, not once per view', async () => {
    reads.length = 0;
    await buildProcurementOverview(countingSb(), ctxOf(1), page);
    const onePass = reads.length;
    expect(onePass).toBeGreaterThan(0);

    reads.length = 0;
    await refreshProcurementOverviewSnapshots({ SESSION_CACHE: fakeKv() } as unknown as Env, today);
    expect(reads.length).toBe(onePass * MRP_REFRESH_COMPANY_IDS.length);
  });

  it('stores each view exactly as the route would build it', async () => {
    const kv = fakeKv();
    await refreshProcurementOverviewSnapshots({ SESSION_CACHE: kv } as unknown as Env, today);
    for (const companyId of MRP_REFRESH_COMPANY_IDS) {
      for (const p of [page, home]) {
        const stored = JSON.parse(kv.m.get(procurementOverviewKey(companyId, p)) as string).v;
        expect(stored).toEqual(json(await buildProcurementOverview(countingSb(), ctxOf(companyId), p)));
      }
    }
  });

  it('the page counts the line due on the 28th, the home Overview does not', async () => {
    const kv = fakeKv();
    await refreshProcurementOverviewSnapshots({ SESSION_CACHE: kv } as unknown as Env, today);
    const dueLines = (p: typeof page) => JSON.parse(kv.m.get(procurementOverviewKey(1, p)) as string).v.body.total.due.lines;
    expect(dueLines(page)).toBe(1);
    expect(dueLines(home)).toBe(0);
  });
});
