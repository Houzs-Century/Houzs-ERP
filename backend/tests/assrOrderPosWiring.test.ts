import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getAssrDetail, listAssrCases } from '../src/services/assr';

// The Service Case list and detail both carry `order_pos` — the supplier
// purchase orders raised from the case's SO. The merge rule is pinned in
// src/services/assrOrderPos.test.ts; this pins that the two READS actually run
// it against a real D1 case row.
//
// NO vi.mock: under the Workers pool it does not reliably intercept imports
// (tests/pvRateFromPayment.test.ts). The REAL supabase-js client runs instead,
// pointed at a fake host, and `fetch` answers its PostgREST GETs from the
// fixture below — so the company predicate is checked on the wire, as sent.

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  mfg_sales_order_items: [
    { id: 'l-1', doc_no: 'SO-WIRE-1', company_id: 1 },
    { id: 'l-9', doc_no: 'SO-WIRE-1', company_id: 2 },
  ],
  purchase_order_items: [
    { so_item_id: 'l-1', purchase_order_id: 'po-1', company_id: 1 },
    { so_item_id: 'l-9', purchase_order_id: 'po-9', company_id: 2 },
  ],
  purchase_orders: [
    { id: 'po-1', po_number: 'HC-PO-000777', status: 'SUBMITTED', company_id: 1 },
    { id: 'po-9', po_number: 'PO-OTHER-CO', status: 'SUBMITTED', company_id: 2 },
  ],
};

const requested: string[] = [];
function postgrest(url: URL): Row[] {
  const table = url.pathname.split('/').pop() ?? '';
  let rows = TABLES[table] ?? [];
  for (const [col, raw] of url.searchParams) {
    if (col === 'select' || col === 'order') continue;
    if (raw.startsWith('eq.')) rows = rows.filter((r) => String(r[col]) === raw.slice(3));
    else if (raw.startsWith('in.(')) {
      const vals = raw.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''));
      rows = rows.filter((r) => vals.includes(String(r[col])));
    } else if (raw === 'not.is.null') rows = rows.filter((r) => r[col] != null);
  }
  return rows;
}

const realFetch = globalThis.fetch;
beforeEach(async () => {
  requested.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requested.push(`${url.pathname.split('/').pop()}?${url.searchParams.toString()}`);
    return new Response(JSON.stringify(postgrest(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await env.DB.exec(`CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, code TEXT)`);
  try {
    await env.DB.exec(`ALTER TABLE assr_cases ADD COLUMN company_id INTEGER`);
  } catch {
    // already added by an earlier beforeEach in this file
  }
  await env.DB.exec(`DELETE FROM assr_cases`);
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, customer_name, po_no, company_id)
     VALUES (501, 'ASSR/WIRE-1', 'SO-WIRE-1', 'pending_review', 'Wire Co', 'SVC-PO-9', 1)`,
  ).run();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const scmEnv = () => ({ ...env, SUPABASE_URL: 'https://fake-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' }) as typeof env;

describe('Service Case reads carry order_pos', () => {
  test('list', async () => {
    const r = await listAssrCases(scmEnv(), {});
    const row = (r.data as Row[]).find((x) => x.id === 501);
    expect(row?.order_pos).toEqual([{ id: 'po-1', po_number: 'HC-PO-000777' }]);
    expect(row?.po_no).toBe('SVC-PO-9');
    for (const t of ['mfg_sales_order_items', 'purchase_order_items', 'purchase_orders']) {
      expect(requested.filter((q) => q.startsWith(`${t}?`)).every((q) => q.includes('company_id=eq.1'))).toBe(true);
      expect(requested.some((q) => q.startsWith(`${t}?`))).toBe(true);
    }
  });

  test('detail', async () => {
    const d = await getAssrDetail(scmEnv(), 501);
    expect((d?.case as Row).order_pos).toEqual([{ id: 'po-1', po_number: 'HC-PO-000777' }]);
    expect((d?.case as Row).po_no).toBe('SVC-PO-9');
  });
});
