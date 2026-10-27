/* 3PL bills read by themselves (owner 2026-10-24: 「我还需要按？ 不能直接我在ap
   invoice这几个supplier 直接link 过来吗？」 → 「手动还是要保留」 · 「做，好了叫我」).
   The half-hourly cron, pinned:
     • a new bill on an AP invoice from a 3PL supplier is read and kept: the DO
       lines on their DOs, storage / handling not counted, a dismantle on the
       fair of the AP invoice line of its amount, an unknown number waiting;
     • a bill read is not read again — until a file is added, and then a line a
       person had put somewhere keeps their choice;
     • a reading that fails is logged and tried three times in all;
     • a bill a person brought in before readings were logged is left alone;
     • a cancelled AP invoice's bill stops counting;
     • dark without the file store or the reader. */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { autoReadBills } from '../src/scm/lib/threepl-bill-import';

let currentSb: unknown = null;
vi.mock('../src/db/supabase', () => ({ getSupabaseService: () => currentSb }));

const HOUZS = 1;
const T2990 = 2;
const anthropicAnswer = (body: unknown) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }] }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); currentSb = null; });

const BILL = {
  lines: [
    { text: '6/10-SO-013216', kind: 'transport', amountRm: 120, date: '2026-10-06', orders: [{ soNo: '6/10-SO-013216' }] },
    { text: '2990-SO-2606-037', kind: 'delivery', amountRm: 145, orders: [{ soNo: '2990-SO-2606-037' }] },
    { text: 'DISMANTLE SETIA SPICE (2 TRIPS)', kind: 'dismantle', amountRm: 1100, orders: [] },
    { text: "HANDLING OUT SEP'26", kind: 'handling', amountRm: 53, orders: [] },
    { text: 'DO-010676', kind: 'delivery', amountRm: 600, orders: [{ doNo: 'DO-010676' }] },
  ],
};

function world(extra: Partial<Record<string, Row[]>> = {}) {
  const sb = fakeSb({
    suppliers: [{ id: 'sup-msj', company_id: HOUZS, code: '405-M003', name: 'MSJ TRANSPORT SERVICE' }],
    threepl_companies: [{ id: 'car-msj', company_id: HOUZS, name: 'MSJ TRANSPORT SERVICE', supplier_id: null, is_active: true }],
    ap_invoices: [
      { id: 'api-9', company_id: HOUZS, invoice_number: 'HC-API-2610-009', supplier_invoice_ref: '617797', invoice_date: '2026-10-13', total_sen: 228_000, status: 'POSTED', supplier_id: 'sup-msj' },
      { id: 'api-x', company_id: HOUZS, invoice_number: 'HC-API-2610-021', supplier_invoice_ref: '617801', invoice_date: '2026-10-15', total_sen: 1_000, status: 'CANCELLED', supplier_id: 'sup-msj' },
    ],
    ap_invoice_lines: [
      { id: 'l-1', company_id: HOUZS, invoice_id: 'api-9', amount_sen: 110_000, project_id: 345 },
      { id: 'l-2', company_id: HOUZS, invoice_id: 'api-9', amount_sen: 118_000, project_id: null },
    ],
    acc_ap_invoice_files: [
      { id: 'f-9', company_id: HOUZS, ap_invoice_id: 'api-9', file_key: 'k/api-9/a.pdf', file_name: 'MSJ.pdf', mime: 'application/pdf', size_bytes: 8, sort_no: 1, created_at: '2026-10-13T02:00:00Z' },
    ],
    mfg_sales_orders: [
      { company_id: HOUZS, doc_no: 'HC-SO-013216', status: 'CONFIRMED', customer_so_no: null, ref: null, postcode: '10200', address1: 'Penang', address2: null },
      { company_id: T2990, doc_no: '2990-SO-2606-037', status: 'DELIVERED', customer_so_no: null, ref: null, postcode: '50450', address1: 'KL', address2: null },
    ],
    mfg_sales_order_items: [],
    delivery_orders: [
      { id: 'do-1', company_id: HOUZS, do_number: 'HC-DO-2610-004', do_date: '2026-10-06', so_doc_no: 'HC-SO-013216', debtor_name: 'Tan', status: 'DELIVERED' },
      { id: 'do-2', company_id: T2990, do_number: '2990-DO-2610-001', do_date: '2026-10-07', so_doc_no: '2990-SO-2606-037', debtor_name: 'Lee', status: 'DELIVERED' },
    ],
    threepl_do_charges: [],
    threepl_bill_lines: [],
    threepl_bill_reads: [],
    delivery_rate_cards: [],
    delivery_rate_rules: [],
    ...extra,
  });
  currentSb = sb;
  const store = new Map<string, ArrayBuffer>([['k/api-9/a.pdf', new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer]]);
  const SLIPS = { store, get: async (k: string) => { const hit = store.get(k); return hit ? { body: new Blob([hit]).stream() } : null; } };
  const env = { ANTHROPIC_API_KEY: 'k', SLIPS } as never;
  return { sb, env, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

describe('a bill read by itself', () => {
  test('kept line by line; read once; a file added later reads it again and a person\'s choice stays', async () => {
    const reader = vi.fn(async () => anthropicAnswer(BILL));
    vi.stubGlobal('fetch', reader);
    const { env, tables } = world();
    expect(await autoReadBills(env)).toEqual({ due: 1, read: 1, failed: 0, released: 0, errors: [] });
    expect(tables.threepl_bill_lines!.map((l) => [l.line_no, l.assign, l.do_ids, l.project_id, l.assigned_by])).toEqual([
      [1, 'do', ['do-1'], null, 'auto'],
      [2, 'do', ['do-2'], null, 'auto'],
      [3, 'event', [], 345, 'auto'],
      [4, 'none', [], null, 'auto'],
      [5, null, [], null, null],
    ]);
    expect(tables.threepl_do_charges!.map((r) => [r.do_id, r.billed_sen, r.ap_invoice_id, r.threepl_company_id])).toEqual([
      ['do-1', 12_000, 'api-9', 'car-msj'], ['do-2', 14_500, 'api-9', 'car-msj'],
    ]);
    expect(tables.threepl_bill_reads).toEqual([expect.objectContaining({ ap_invoice_id: 'api-9', read_by: 'auto', files_count: 1, files_latest: '2026-10-13T02:00:00Z', error: null })]);
    expect(tables.threepl_companies![0]!.supplier_id).toBe('sup-msj');

    /* Read: not again. */
    expect(await autoReadBills(env)).toMatchObject({ due: 0, read: 0 });
    expect(reader).toHaveBeenCalledTimes(1);

    /* A person put the unknown line under Not counted and took the first line
       off its DO (misread); then the goods list is attached. */
    Object.assign(tables.threepl_bill_lines!.find((l) => l.line_no === 5)!, { assign: 'none', assigned_by: 'Chew', assigned_at: '2026-10-24T03:00:00Z' });
    Object.assign(tables.threepl_bill_lines!.find((l) => l.line_no === 1)!, { assign: null, do_ids: [], assigned_by: 'Chew', assigned_at: '2026-10-24T03:00:00Z' });
    tables.acc_ap_invoice_files!.push({ id: 'f-10', company_id: HOUZS, ap_invoice_id: 'api-9', file_key: 'k/api-9/a.pdf', file_name: 'goods.pdf', mime: 'application/pdf', size_bytes: 8, sort_no: 2, created_at: '2026-10-24T04:00:00Z' });
    expect(await autoReadBills(env)).toMatchObject({ due: 1, read: 1 });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(tables.threepl_bill_lines!.find((l) => l.line_no === 5)).toMatchObject({ assign: 'none', assigned_by: 'Chew', assigned_at: '2026-10-24T03:00:00Z' });
    expect(tables.threepl_bill_lines!.find((l) => l.line_no === 1)).toMatchObject({ assign: null, do_ids: [], assigned_by: 'Chew' });
    expect(tables.threepl_do_charges!.map((r) => r.do_id)).toEqual(['do-2']);
    expect(tables.threepl_bill_reads).toEqual([expect.objectContaining({ files_count: 2, files_latest: '2026-10-24T04:00:00Z' })]);
  });

  test('a reading that fails is logged and tried three times in all, then waits for its files to change', async () => {
    const reader = vi.fn(async () => new Response('overloaded', { status: 529 }));
    vi.stubGlobal('fetch', reader);
    const { env, tables } = world();
    for (let i = 1; i <= 3; i += 1) {
      expect(await autoReadBills(env)).toMatchObject({ due: 1, read: 0, failed: 1 });
      expect(tables.threepl_bill_reads).toEqual([expect.objectContaining({ ap_invoice_id: 'api-9', attempts: i, files_count: 1 })]);
    }
    expect(tables.threepl_bill_reads![0]!.error).toBeTruthy();
    expect(await autoReadBills(env)).toMatchObject({ due: 0, failed: 0 });
    expect(tables.threepl_bill_lines).toEqual([]);
    expect(tables.threepl_do_charges).toEqual([]);
  });

  test('a bill a person brought in before readings were logged is left alone', async () => {
    const reader = vi.fn(async () => anthropicAnswer(BILL));
    vi.stubGlobal('fetch', reader);
    const hand = { id: 'c-1', company_id: HOUZS, do_id: 'do-1', threepl_company_id: 'car-msj', invoice_no: '617797', invoice_date: '2026-10-13', billed_sen: 11_000, note: null, ap_invoice_id: 'api-9' };
    const { env, tables } = world({ threepl_do_charges: [hand] });
    expect(await autoReadBills(env)).toMatchObject({ due: 0, read: 0 });
    expect(reader).not.toHaveBeenCalled();
    expect(tables.threepl_do_charges).toEqual([hand]);
  });

  test('a cancelled AP invoice\'s bill stops counting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(BILL)));
    const { env, tables } = world({
      threepl_do_charges: [{ id: 'c-x', company_id: HOUZS, do_id: 'do-1', threepl_company_id: 'car-msj', invoice_no: '617801', billed_sen: 1_000, ap_invoice_id: 'api-x' }],
      threepl_bill_lines: [{ id: 'bl-x', company_id: HOUZS, ap_invoice_id: 'api-x', line_no: 1, text: 'x', amount_sen: 1_000, assign: 'do', do_ids: ['do-1'] }],
      threepl_bill_reads: [{ ap_invoice_id: 'api-x', company_id: HOUZS, read_by: 'auto', files_count: 1, attempts: 0 }],
    });
    expect(await autoReadBills(env)).toMatchObject({ released: 1, read: 1 });
    expect(tables.threepl_do_charges!.some((r) => r.ap_invoice_id === 'api-x')).toBe(false);
    expect(tables.threepl_bill_lines!.some((r) => r.ap_invoice_id === 'api-x')).toBe(false);
    expect(tables.threepl_bill_reads!.some((r) => r.ap_invoice_id === 'api-x')).toBe(false);
    /* The DO the cancelled bill held is charged by the live one. */
    expect(tables.threepl_do_charges!.find((r) => r.do_id === 'do-1')).toMatchObject({ ap_invoice_id: 'api-9' });
  });

  test('dark without the file store or the reader', async () => {
    const reader = vi.fn(async () => anthropicAnswer(BILL));
    vi.stubGlobal('fetch', reader);
    const { tables } = world();
    expect(await autoReadBills({ ANTHROPIC_API_KEY: 'k' } as never)).toEqual({ due: 0, read: 0, failed: 0, released: 0, errors: [] });
    expect(await autoReadBills({ SLIPS: {} } as never)).toMatchObject({ due: 0, read: 0 });
    expect(reader).not.toHaveBeenCalled();
    expect(tables.threepl_bill_reads).toEqual([]);
  });
});
