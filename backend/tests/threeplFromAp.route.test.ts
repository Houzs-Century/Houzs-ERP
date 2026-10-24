/* The 3PL invoices tab filled from the AP invoice Finance already keyed (owner
   2026-10-23: 「先做」 — 「其实我的ap invoice 本身就带有so number 或do number / 所以你要
   根据我的系统的do 对比supplier charge 我的amount对比 / 仓储，搬运不算」, 2990's
   orders are Houzs's to deliver and bill back). Pinned:
     • the list: AP invoices with a bill attached, the 3PL each supplier bills
       as (by name, then by the link a confirm leaves), what was brought in;
     • the read: every line of the bill matched to a DO across both companies
       — an SO number, a slip, two lines on one DO summed — storage, handling
       and dismantling beside them, an unknown number said; NOTHING written;
     • the confirm: what the person kept is saved against the AP invoice, the
       carrier remembers its supplier, reading the bill again REPLACES its
       rows, a DO another bill already charges is left as it is;
     • Finance only; a bill with nothing attached, or cancelled, is refused. */
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { threeplDoCharges } from '../src/scm/routes/threepl-do-charges';

const HOUZS = 1;
const T2990 = 2;
const anthropicAnswer = (body: unknown) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }] }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); });

/* MSJ's handwritten sheet as the reader answers it — with a 2990 order, a
   customer's slip, a dismantling, a handling row and a DO the system never had. */
const BILL = {
  lines: [
    { text: '6/10-SO-013216', kind: 'transport', amountRm: 120, date: '2026-10-06', orders: [{ soNo: '6/10-SO-013216' }] },
    { text: '6/10-SO-013216', kind: 'transport', amountRm: 100, date: '2026-10-06', orders: [{ soNo: '6/10-SO-013216' }] },
    { text: '2990-SO-2606-037', kind: 'delivery', amountRm: 145, orders: [{ soNo: '2990-SO-2606-037' }] },
    { text: 'JOHOR TO SINGAPORE - HC12975', kind: 'delivery', amountRm: 50, orders: [{ ref: 'HC12975' }] },
    { text: 'DISMANTLE SETIA SPICE (2 TRIPS)', kind: 'dismantle', amountRm: 1100, orders: [] },
    { text: "HANDLING OUT SEP'26", kind: 'handling', amountRm: 53, orders: [] },
    { text: 'DO-010676', kind: 'delivery', amountRm: 600, orders: [{ doNo: 'DO-010676' }] },
  ],
};

const fakeR2 = () => {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: async (k: string) => { const hit = store.get(k); return hit ? { body: new Blob([hit]).stream() } : null; },
  };
};

function harness(perms: string[] = ['scm.finance.accounting', 'scm.transportation.drivers'], extra: Partial<Record<string, Row[]>> = {}) {
  const sb = fakeSb({
    suppliers: [
      { id: 'sup-msj', company_id: HOUZS, code: '405-M003', name: 'MSJ TRANSPORT SERVICE' },
      { id: 'sup-tnb', company_id: HOUZS, code: '400-T001', name: 'TENAGA NASIONAL BERHAD' },
    ],
    threepl_companies: [
      { id: 'car-msj', company_id: HOUZS, name: 'MSJ TRANSPORT SERVICE', supplier_id: null, is_active: true },
      { id: 'car-eu', company_id: HOUZS, name: 'EU LOGISTICS', supplier_id: null, is_active: true },
    ],
    ap_invoices: [
      { id: 'api-9', company_id: HOUZS, invoice_number: 'HC-API-2610-009', supplier_invoice_ref: '617797', invoice_date: '2026-10-13', total_sen: 228_000, status: 'POSTED', supplier_id: 'sup-msj' },
      { id: 'api-tnb', company_id: HOUZS, invoice_number: 'HC-API-2610-020', supplier_invoice_ref: null, invoice_date: '2026-10-14', total_sen: 50_000, status: 'POSTED', supplier_id: 'sup-tnb' },
      { id: 'api-x', company_id: HOUZS, invoice_number: 'HC-API-2610-021', supplier_invoice_ref: '617801', invoice_date: '2026-10-15', total_sen: 1_000, status: 'CANCELLED', supplier_id: 'sup-msj' },
    ],
    acc_ap_invoice_files: [
      { id: 'f-9', company_id: HOUZS, ap_invoice_id: 'api-9', file_key: 'ap-invoice-files/1/api-9/a.pdf', file_name: 'MSJ - rm9150-1.pdf', mime: 'application/pdf', size_bytes: 8, sort_no: 1 },
      { id: 'f-x', company_id: HOUZS, ap_invoice_id: 'api-x', file_key: 'ap-invoice-files/1/api-x/a.pdf', file_name: 'x.pdf', mime: 'application/pdf', size_bytes: 8, sort_no: 1 },
    ],
    mfg_sales_orders: [
      { company_id: HOUZS, doc_no: 'HC-SO-013216', status: 'CONFIRMED', customer_so_no: 'HC12001', ref: 'HC12001', postcode: '10200', address1: 'Penang', address2: null },
      { company_id: T2990, doc_no: '2990-SO-2606-037', status: 'DELIVERED', customer_so_no: null, ref: null, postcode: '50450', address1: 'KL', address2: null },
      { company_id: HOUZS, doc_no: 'HC-SO-012967', status: 'DELIVERED', customer_so_no: 'HC12975', ref: 'HC12975', postcode: '81200', address1: 'JB', address2: null },
    ],
    mfg_sales_order_items: [],
    delivery_orders: [
      { id: 'do-1', company_id: HOUZS, do_number: 'HC-DO-2610-004', do_date: '2026-10-06', so_doc_no: 'HC-SO-013216', debtor_name: 'Tan', status: 'DELIVERED' },
      { id: 'do-2', company_id: T2990, do_number: '2990-DO-2610-001', do_date: '2026-10-07', so_doc_no: '2990-SO-2606-037', debtor_name: 'Lee', status: 'DELIVERED' },
      { id: 'do-3', company_id: HOUZS, do_number: 'HC-DO-2609-154', do_date: '2026-09-24', so_doc_no: 'HC-SO-012967', debtor_name: 'Ng', status: 'LOADED' },
    ],
    threepl_do_charges: [],
    delivery_rate_cards: [],
    delivery_rate_rules: [],
    ...extra,
  });
  const r2 = fakeR2();
  r2.store.set('ap-invoice-files/1/api-9/a.pdf', new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer);
  r2.store.set('ap-invoice-files/1/api-x/a.pdf', new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, HOUZS as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 7, name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [HOUZS, T2990] as never);
    c.set('companies' as never, [{ id: HOUZS, code: 'HOUZS' }, { id: T2990, code: '2990' }] as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    await next();
  });
  app.route('/threepl-do-charges', threeplDoCharges);
  const req = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { ANTHROPIC_API_KEY: 'k', SLIPS: r2 } as never);
  return { req, sb };
}
const tables = (sb: unknown) => (sb as { tables: Record<string, Row[]> }).tables;

describe('the AP invoices a bill can be brought in from', () => {
  test('a bill attached and not cancelled, the 3PL its supplier bills as, nothing brought in yet', async () => {
    const { req } = harness();
    const res = await req('/threepl-do-charges/from-ap/invoices');
    expect(res.status).toBe(200);
    const body = await res.json() as { invoices: Row[]; carriers: Row[] };
    expect(body.invoices.map((i) => [i.invoiceNumber, i.supplierName, i.files, i.carrierId, i.broughtInDos])).toEqual([
      ['HC-API-2610-009', 'MSJ TRANSPORT SERVICE', 1, 'car-msj', 0],
    ]);
    expect(body.carriers.map((k) => k.name)).toEqual(['EU LOGISTICS', 'MSJ TRANSPORT SERVICE']);
  });

  test('Finance only — the AP invoice is Finance\'s', async () => {
    const { req } = harness(['scm.transportation.drivers']);
    expect((await req('/threepl-do-charges/from-ap/invoices')).status).toBe(403);
    expect((await req('/threepl-do-charges/from-ap/api-9/read', 'POST', {})).status).toBe(403);
    expect((await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-msj', rows: [] })).status).toBe(403);
  });
});

describe('reading the bill', () => {
  test('every line to a DO across both companies; storage, handling, dismantling beside them; nothing written', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(BILL)));
    const { req, sb } = harness();
    const res = await req('/threepl-do-charges/from-ap/api-9/read', 'POST', {});
    expect(res.status).toBe(200);
    const body = await res.json() as { carrierId: string; dos: Row[]; lines: Row[]; totals: Row; invoice: Row };
    expect(body.carrierId).toBe('car-msj');
    expect(body.invoice).toMatchObject({ invoiceNumber: 'HC-API-2610-009', supplierRef: '617797', supplierName: 'MSJ TRANSPORT SERVICE' });
    expect(body.dos.map((d) => [d.doNumber, d.companyCode, d.billedSen, d.expectedSen, d.alreadyOn])).toEqual([
      ['HC-DO-2610-004', 'HOUZS', 22_000, null, null],
      ['2990-DO-2610-001', '2990', 14_500, null, null],
      ['HC-DO-2609-154', 'HOUZS', 5_000, null, null],
    ]);
    expect(body.dos[0]!.note).toBe('HC-API-2610-009: 6/10-SO-013216 — RM 120.00 / 6/10-SO-013216 — RM 100.00');
    expect(body.lines.map((l) => l.status)).toEqual(['matched', 'matched', 'matched', 'matched', 'not_delivery', 'not_delivery', 'not_found']);
    expect(body.totals).toEqual({ all: 216_800, matched: 41_500, not_found: 60_000, no_number: 0, service_case: 0, not_delivery: 115_300 });
    expect(tables(sb)?.threepl_do_charges ?? []).toEqual([]);
  });

  test('a bill with nothing attached, or a cancelled one, is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(BILL)));
    const { req } = harness();
    const none = await req('/threepl-do-charges/from-ap/api-tnb/read', 'POST', {});
    expect(none.status).toBe(409);
    expect((await none.json() as Row).error).toBe('no_files');
    expect((await req('/threepl-do-charges/from-ap/api-x/read', 'POST', {})).status).toBe(409);
  });

  test('the reader refusing is said, not read as an empty bill', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('overloaded', { status: 529 })));
    const { req } = harness();
    const res = await req('/threepl-do-charges/from-ap/api-9/read', 'POST', {});
    expect(res.status).toBe(502);
  });
});

describe('confirming what the person kept', () => {
  const ROWS = [
    { doId: 'do-1', billedSen: 22_000, note: 'HC-API-2610-009: 6/10-SO-013216' },
    { doId: 'do-2', billedSen: 14_500, note: 'HC-API-2610-009: 2990-SO-2606-037' },
    { doId: 'do-3', billedSen: 5_000, note: 'HC-API-2610-009: HC12975' },
  ];

  test('saved against the AP invoice, the carrier remembers its supplier, reading again replaces', async () => {
    const { req, sb } = harness();
    const first = await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-msj', rows: ROWS });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ saved: 3, skipped: [] });
    const rows = () => (tables(sb)?.threepl_do_charges ?? []).map((r) => [r.do_id, r.billed_sen, r.ap_invoice_id, r.invoice_no, r.invoice_date, r.threepl_company_id]);
    expect(rows()).toEqual([
      ['do-1', 22_000, 'api-9', '617797', '2026-10-13', 'car-msj'],
      ['do-2', 14_500, 'api-9', '617797', '2026-10-13', 'car-msj'],
      ['do-3', 5_000, 'api-9', '617797', '2026-10-13', 'car-msj'],
    ]);
    expect(tables(sb)?.threepl_companies?.find((k) => k.id === 'car-msj')?.supplier_id).toBe('sup-msj');

    const again = await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-msj', rows: [{ ...ROWS[0]!, billedSen: 21_000 }, ROWS[1]] });
    expect(await again.json()).toEqual({ saved: 2, skipped: [] });
    expect(rows()).toEqual([
      ['do-1', 21_000, 'api-9', '617797', '2026-10-13', 'car-msj'],
      ['do-2', 14_500, 'api-9', '617797', '2026-10-13', 'car-msj'],
    ]);

    const listed = await (await req('/threepl-do-charges/from-ap/invoices')).json() as { invoices: Row[] };
    expect(listed.invoices[0]).toMatchObject({ broughtInDos: 2, broughtInSen: 35_500, carrierId: 'car-msj' });
    const tab = await (await req('/threepl-do-charges')).json() as { rows: Row[] };
    expect(tab.rows.map((r) => [r.doNumber, r.doCompanyCode, r.billedSen, r.apInvoiceId])).toEqual([
      ['HC-DO-2610-004', 'HOUZS', 21_000, 'api-9'],
      ['2990-DO-2610-001', '2990', 14_500, 'api-9'],
    ]);
  });

  test('a DO another bill already charges on this carrier is left as it is', async () => {
    const manual = { id: 'm-1', company_id: HOUZS, do_id: 'do-3', threepl_company_id: 'car-msj', invoice_no: 'MANUAL-1', invoice_date: '2026-10-01', billed_sen: 4_000, note: null, ap_invoice_id: null };
    const { req, sb } = harness(undefined, { threepl_do_charges: [manual] });
    const res = await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-msj', rows: ROWS });
    expect(await res.json()).toEqual({ saved: 2, skipped: [{ doId: 'do-3', invoiceNo: 'MANUAL-1' }] });
    expect(tables(sb)?.threepl_do_charges?.find((r) => r.id === 'm-1')).toMatchObject({ billed_sen: 4_000, ap_invoice_id: null });
  });

  test('refusals: no carrier, a carrier not ours, a cancelled DO, a DO twice', async () => {
    const { req } = harness(undefined, {
      delivery_orders: [{ id: 'do-1', company_id: HOUZS, do_number: 'HC-DO-2610-004', do_date: '2026-10-06', so_doc_no: 'HC-SO-013216', debtor_name: 'Tan', status: 'CANCELLED' }],
    });
    expect((await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { rows: ROWS })).status).toBe(400);
    expect((await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-other', rows: ROWS })).status).toBe(404);
    expect((await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-msj', rows: [ROWS[0]] })).status).toBe(409);
    expect((await req('/threepl-do-charges/from-ap/api-9/confirm', 'POST', { carrierId: 'car-msj', rows: [ROWS[0], ROWS[0]] })).status).toBe(400);
  });
});
