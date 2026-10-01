/* 申请付款 item 1 (owner 2026-10-01 → 做): the bill a request carries.
     • 申请一定要有 — a request keeps its last file, and Finance cannot answer a
       request that has none (voucher or AP invoice alike);
     • the bill is READ as it is attached (POST /payment-requests/read-bill):
       its number, date and total, and — in a company that runs events — whether
       it is for one, with the events it points at;
     • a bill for an event goes with its Event, or with the requester's reason
       why there is none;
     • 同一张单上传两次 — every OTHER live request, voucher or AP invoice with the
       same bill NUMBER and DATE is named (never refused); a request and the
       voucher made from it are one payment, not a match;
     • the voucher keeps the bill's number and date (bill_ref, bill_date), taken
       from the request it answers unless Finance types its own.
   Same fake-PostgREST harness as tests/paymentRequests.test.ts. */

import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { paymentVouchers } from '../src/scm/routes/payment-vouchers';
import { paymentRequests } from '../src/scm/routes/payment-requests';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { eventBillRefusal, normalizeBillNo, pvBillFields, readBillFacts } from '../src/scm/lib/bill-matches';
import { officialDocs } from '../src/scm/routes/official-docs';
import { compareOfficial, officialOwedFields, officialOwedUpdates } from '../src/scm/lib/official-doc';

const CO = 1;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const JAMES = { id: 22, name: 'James Seow', perms: ['scm.payment_request.create'] };
const KAR = { id: 23, name: 'Kar Jiun', perms: ['scm.payment_request.create'] };
const FINANCE = { id: 9, name: 'Chew', perms: PV_KEYS };

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});

/* Company 1 runs events; company 2 (2990) has none. */
const EVENTS: Row[] = [
  { id: 348, company_id: 1, code: '2026-09-MLE-PENANG-PWCC-AKEMI', name: 'Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: null, venue: 'PENANG WATERFRONT CONVENTION CENTRE', brand: 'AKEMI', organizer: 'MLE', booth_no: 'F1' },
];
const fakeDb = {
  prepare(sql: string) {
    return {
      bind(...vals: unknown[]) {
        return {
          async all<T>() {
            let hit = EVENTS.slice();
            const co = /p\.company_id = (\d+)/.exec(sql);
            if (co) hit = hit.filter((r) => r.company_id === Number(co[1]));
            if (/p\.id IN/.test(sql)) hit = hit.filter((r) => vals.map(Number).includes(r.id));
            return {
              results: hit.map((r) => ({
                id: r.id, code: r.code, name: r.name, startdate: r.start_date, enddate: r.end_date, status: r.status, archivedat: r.archived_at,
                venue: r.venue, brand: r.brand, organizer: r.organizer, boothno: r.booth_no,
              })) as unknown as T[],
            };
          },
        };
      },
    };
  },
};

const fakeR2 = () => {
  const store = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) => { store.set(k, { bytes: v, contentType: o?.httpMetadata?.contentType ?? '' }); },
    get: async (k: string) => {
      const hit = store.get(k);
      return hit ? { arrayBuffer: async () => hit.bytes, body: new Blob([hit.bytes]).stream(), httpMetadata: { contentType: hit.contentType } } : null;
    },
    delete: async (k: string) => { store.delete(k); },
  };
};

function world() {
  const sb = fakeSb({
    accounts: [
      acct('900-0000', 'Operating Expense', 'EXPENSE'),
      acct('900-R032', 'RENTAL - EXHIBITION', 'EXPENSE', { parent_code: '900-0000' }),
      acct('310-0010', 'MAYBANK', 'ASSET', { acc_money: true }),
    ],
    suppliers: [{ id: 'sup-mle', company_id: CO, code: '400-M001', name: 'MLE EVENTS SDN BHD', status: 'ACTIVE' }],
    ap_invoices: [],
    ap_invoice_lines: [],
    acc_ap_invoice_files: [],
    companies: [{ id: CO, code: 'HC' }, { id: 2, code: '2990' }],
    acc_account_roles: [],
    acc_payment_requests: [],
    acc_payment_request_files: [],
    acc_pv_files: [],
    payment_vouchers: [],
    payment_voucher_lines: [],
    pv_allocations: [],
    journal_entries: [],
    journal_entry_lines: [],
    acc_bank_statement_matches: [],
    acc_bank_statement_lines: [],
    entity_audit_log: [],
    acc_vendor_memory: [],
  });
  sb.rpcHandlers.entity_audit_writable = () => true;
  return { sb, r2: fakeR2() };
}

function as(w: ReturnType<typeof world>, who: { id: number; name: string; perms: string[] }, companyId = CO) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, w.sb as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: who.id, name: who.name, permissions_set: new Set(who.perms) } as never);
    c.set('allowedCompanyIds' as never, [companyId] as never);
    c.set('companies' as never, [{ id: companyId, code: companyId === CO ? 'HC' : '2990' }] as never);
    c.set('companyCode' as never, (companyId === CO ? 'HC' : '2990') as never);
    await next();
  });
  app.route('/payment-requests', paymentRequests);
  app.route('/payment-vouchers', paymentVouchers);
  app.route('/ap-invoices', apInvoices);
  app.route('/official-docs', officialDocs);
  return async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: fakeDb, SLIPS: w.r2, ANTHROPIC_API_KEY: 'k' });
    return { status: res.status, body: await res.json() as Row };
  };
}

/* The reader answers what a test says the bill prints. */
const reads = (printed: Row) => {
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ vendorName: 'MLE EVENTS SDN BHD', documentKind: 'invoice', currency: 'MYR', lines: [{ description: 'Booth F1 rental', amountRm: 8500 }], event: null, ...printed }) }] }), { status: 200 });
  }));
  return sent;
};
const PAGE = { name: 'bill.jpg', mime: 'image/jpeg', dataBase64: btoa('the organiser invoice') };

const RENTAL = {
  payeeName: 'MLE EVENTS SDN BHD', amountSen: 850_000, dueDate: '2026-09-15', purpose: 'Booth F1 rental — MLE Penang', projectId: 348,
};
async function raise(w: ReturnType<typeof world>, who = JAMES, over: Row = {}, files = 1) {
  const ask = as(w, who);
  const r = await ask('/payment-requests', 'POST', { ...RENTAL, ...over });
  expect(r.status).toBe(201);
  const id = String(r.body.request.id);
  for (let i = 0; i < files; i += 1) {
    expect((await ask(`/payment-requests/${id}/files`, 'POST', { fileName: `p${i}.pdf`, mime: 'application/pdf', dataBase64: btoa(`page ${i}`) })).status).toBe(201);
  }
  return { ask, id, no: String(r.body.request.request_no) };
}
const voucherFor = (id: string, over: Row = {}) => ({
  payeeName: 'MLE EVENTS SDN BHD', creditAccountCode: '310-0010', voucherDate: '2026-09-10', purpose: 'OTHER', paymentRequestId: id,
  lines: [{ debitAccountCode: '900-R032', description: 'Booth F1 rental', amountSen: 850_000, projectId: 348 }], ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('申请一定要有 — no bill, no payment', () => {
  test('Finance cannot answer a request that carries no bill — neither a voucher nor an AP invoice', async () => {
    const w = world();
    const { id, no } = await raise(w, JAMES, {}, 0);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id));
    expect(pv.status).toBe(409);
    expect(pv.body).toMatchObject({ error: 'request_no_bill' });
    expect(String(pv.body.message)).toBe(`${no} has no bill attached — return it so the requester attaches one.`);
    const inv = await fin('/ap-invoices', 'POST', {
      supplierId: 'sup-mle', supplierInvoiceRef: 'MLE-0925', invoiceDate: '2026-09-10', paymentRequestId: id,
      lines: [{ debitAccountCode: '900-R032', description: 'Booth F1 rental', amountSen: 850_000 }],
    });
    expect(inv.status).toBe(409);
    expect(inv.body.error).toBe('request_no_bill');
    expect(w.sb.tables.payment_vouchers).toHaveLength(0);
    expect(w.sb.tables.ap_invoices).toHaveLength(0);
  });

  test('the last file stays: removing it is refused; with two, one may go', async () => {
    const w = world();
    const { ask, id } = await raise(w, JAMES, {}, 2);
    const [a, b] = w.sb.tables.acc_payment_request_files;
    expect((await ask(`/payment-requests/${id}/files/${a!.id}`, 'DELETE')).status).toBe(200);
    const last = await ask(`/payment-requests/${id}/files/${b!.id}`, 'DELETE');
    expect(last.status).toBe(409);
    expect(last.body).toMatchObject({ error: 'bill_required', message: 'A request keeps its bill — attach the right file first, then remove this one.' });
    expect(w.sb.tables.acc_payment_request_files).toHaveLength(1);
  });
});

describe('POST /payment-requests/read-bill — the bill read as it is attached', () => {
  test('reads number, date and total; an event bill offers the events it points at', async () => {
    const w = world();
    const sent = reads({ invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-01', totalRm: 8500, event: { name: 'MLE Penang', venue: 'Penang Waterfront Convention Centre', booth: 'F1', dateFrom: '2026-09-25', dateTo: '2026-09-27' } });
    const res = await as(w, JAMES)('/payment-requests/read-bill', 'POST', { files: [PAGE] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, hasEvents: true, eventBill: true,
      bill: { billNo: 'MLE-0925', billDate: '2026-09-01', totalSen: 850_000, vendorName: 'MLE EVENTS SDN BHD' },
      matches: [],
    });
    expect(res.body.eventSuggestions.map((s: Row) => s.id)).toEqual([348]);
    expect(sent).toHaveLength(1);
    expect(w.sb.tables.acc_payment_requests).toHaveLength(0); // nothing written
  });

  test('a bill naming no event, or any bill of a company without events, needs none', async () => {
    const w = world();
    reads({ invoiceNumber: 'TNB-1', invoiceDate: '2026-09-01', totalRm: 120, event: null });
    expect((await as(w, JAMES)('/payment-requests/read-bill', 'POST', { files: [PAGE] })).body).toMatchObject({ ok: true, eventBill: false, eventSuggestions: [] });
    reads({ invoiceNumber: 'MLE-1', invoiceDate: '2026-09-01', totalRm: 100, event: { name: 'Home Deco Fair', venue: 'MITEC', booth: null, dateFrom: null, dateTo: null } });
    const co2 = await as(w, JAMES, 2)('/payment-requests/read-bill', 'POST', { files: [PAGE] });
    expect(co2.body).toMatchObject({ ok: true, hasEvents: false, eventBill: false });
  });

  test('a reader that fails is said, not a refusal; bad files are refused before any read', async () => {
    const w = world();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('overloaded', { status: 529 })));
    const res = await as(w, JAMES)('/payment-requests/read-bill', 'POST', { files: [PAGE] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.reason)).toContain('529');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const ask = as(w, JAMES);
    expect((await ask('/payment-requests/read-bill', 'POST', { files: [] })).body.error).toBe('no_files');
    expect((await ask('/payment-requests/read-bill', 'POST', { files: [{ ...PAGE, mime: 'text/plain' }] })).body.error).toBe('bad_file_type');
    expect(spy).not.toHaveBeenCalled();
  });

  test('a stored bill: the requester\'s own, or any for Finance — another requester\'s is not found', async () => {
    const w = world();
    const { id } = await raise(w);
    reads({ invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-01', totalRm: 8500 });
    expect((await as(w, JAMES)('/payment-requests/read-bill', 'POST', { requestId: id })).body).toMatchObject({ ok: true, bill: { billNo: 'MLE-0925' } });
    expect((await as(w, FINANCE)('/payment-requests/read-bill', 'POST', { requestId: id })).status).toBe(200);
    expect((await as(w, KAR)('/payment-requests/read-bill', 'POST', { requestId: id })).status).toBe(404);
  });
});

describe('a bill for an event goes with its Event, or the reason there is none', () => {
  test('without either it is refused; with a reason or an event it goes, the reason moot once an event is picked', async () => {
    const w = world();
    const ask = as(w, JAMES);
    const bare = await ask('/payment-requests', 'POST', { ...RENTAL, projectId: null, eventBill: true, billNo: 'MLE-0925', billDate: '2026-09-01' });
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ error: 'event_required', message: 'This bill is for an event — pick the event, or say in a line why there is none.' });
    expect((await ask('/payment-requests', 'POST', { ...RENTAL, projectId: null, eventBill: true, noEventReason: 'no' })).status).toBe(400);
    const reasoned = await ask('/payment-requests', 'POST', { ...RENTAL, projectId: null, eventBill: true, noEventReason: 'Fair not in PMS yet' });
    expect(reasoned.status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ event_bill: true, project_id: null, no_event_reason: 'Fair not in PMS yet' });
    const picked = await ask('/payment-requests', 'POST', { ...RENTAL, eventBill: true, noEventReason: 'stale reason' });
    expect(picked.status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[1]).toMatchObject({ event_bill: true, project_id: 348, no_event_reason: null });
    /* An edit that drops the event of an event bill is refused the same way. */
    const id = String(picked.body.request.id);
    expect((await ask(`/payment-requests/${id}`, 'PATCH', { projectId: null })).body.error).toBe('event_required');
  });

  test('a company without events drops the flag rather than asking for an event it cannot have', async () => {
    const w = world();
    const r = await as(w, JAMES, 2)('/payment-requests', 'POST', { ...RENTAL, projectId: null, eventBill: true });
    expect(r.status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ company_id: 2, event_bill: false });
  });
});

describe('同一张单 — the same bill number and date, said out loud', () => {
  test('requests carrying one bill name each other on the list; withdrawn ones and other dates do not', async () => {
    const w = world();
    const a = await raise(w, JAMES, { billNo: 'MLE-0925', billDate: '2026-09-01', billTotalSen: 850_000 });
    const b = await raise(w, KAR, { billNo: 'mle 0925', billDate: '2026-09-01', amountSen: 425_000 });
    await raise(w, KAR, { billNo: 'MLE-0925', billDate: '2026-09-02' });
    const gone = await raise(w, KAR, { billNo: 'MLE0925', billDate: '2026-09-01' });
    await as(w, KAR)(`/payment-requests/${gone.id}/withdraw`, 'POST');

    const list = await as(w, FINANCE)('/payment-requests');
    expect(list.body.hasEvents).toBe(true);
    const byId = new Map((list.body.requests as Row[]).map((r) => [String(r.id), r]));
    expect(byId.get(a.id)!.billMatches).toEqual([{ kind: 'PRQ', id: b.id, number: b.no, amountSen: 425_000, status: 'SUBMITTED', answeredBy: null }]);
    expect(byId.get(b.id)!.billMatches.map((m: Row) => m.id)).toEqual([a.id]);
    expect(w.sb.tables.acc_payment_requests.find((r) => r.id === a.id)).toMatchObject({ bill_no: 'MLE-0925', bill_date: '2026-09-01', bill_total_sen: 850_000 });
    /* The requester's own view says it too. */
    expect((await as(w, KAR)(`/payment-requests/${b.id}`)).body.request.billMatches.map((m: Row) => m.number)).toEqual([a.no]);
  });

  test('a request and the voucher made from it are one payment; the next request for that bill names both', async () => {
    const w = world();
    const first = await raise(w, JAMES, { billNo: 'MLE-0925', billDate: '2026-09-01' });
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(first.id));
    expect(pv.status).toBe(201);
    /* The voucher kept the request's bill number and date. */
    expect(w.sb.tables.payment_vouchers[0]).toMatchObject({ bill_ref: 'MLE-0925', bill_date: '2026-09-01' });
    expect((await fin(`/payment-requests/${first.id}`)).body.request.billMatches).toEqual([]);

    const second = await raise(w, KAR, { billNo: 'MLE-0925', billDate: '2026-09-01' });
    const seen = (await fin(`/payment-requests/${second.id}`)).body.request.billMatches;
    expect(seen).toEqual([{ kind: 'PRQ', id: first.id, number: first.no, amountSen: 850_000, status: 'VOUCHERED', answeredBy: pv.body.pv_number ?? w.sb.tables.payment_vouchers[0]!.pv_number }]);
  });

  test('read-bill names a voucher paid straight from a scan and an AP invoice with the same pair; cancelled ones are not named', async () => {
    const w = world();
    w.sb.tables.payment_vouchers.push(
      { id: 'pv-1', company_id: CO, pv_number: 'HC-PV-2609-004', total_sen: 850_000, status: 'POSTED', bill_ref: 'MLE/0925', bill_date: '2026-09-01' },
      { id: 'pv-x', company_id: CO, pv_number: 'HC-PV-2609-005', total_sen: 850_000, status: 'CANCELLED', bill_ref: 'MLE-0925', bill_date: '2026-09-01' },
    );
    w.sb.tables.ap_invoices.push(
      { id: 'api-1', company_id: CO, invoice_number: 'HC-API-2609-002', total_sen: 850_000, status: 'POSTED', supplier_invoice_ref: 'MLE-0925', invoice_date: '2026-09-01' },
      { id: 'api-2', company_id: 2, invoice_number: '2990-API-2609-001', total_sen: 1, status: 'POSTED', supplier_invoice_ref: 'MLE-0925', invoice_date: '2026-09-01' },
    );
    reads({ invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-01', totalRm: 8500 });
    const res = await as(w, JAMES)('/payment-requests/read-bill', 'POST', { files: [PAGE] });
    expect(res.body.matches.map((m: Row) => `${m.kind} ${m.number}`)).toEqual(['PV HC-PV-2609-004', 'API HC-API-2609-002']);
    /* Number alone, or date alone, is not the same bill. */
    reads({ invoiceNumber: 'MLE-0925', invoiceDate: null, totalRm: 8500 });
    expect((await as(w, JAMES)('/payment-requests/read-bill', 'POST', { files: [PAGE] })).body.matches).toEqual([]);
  });

  test('GET /bill-matches answers Finance\'s voucher form, leaving out what it is told to', async () => {
    const w = world();
    const first = await raise(w, JAMES, { billNo: 'MLE-0925', billDate: '2026-09-01' });
    const fin = as(w, FINANCE);
    expect((await fin('/payment-requests/bill-matches?no=MLE-0925&date=2026-09-01')).body.matches.map((m: Row) => m.id)).toEqual([first.id]);
    expect((await fin(`/payment-requests/bill-matches?no=MLE-0925&date=2026-09-01&excludeRequest=${first.id}`)).body.matches).toEqual([]);
    expect((await fin('/payment-requests/bill-matches?no=MLE-0925')).body.matches).toEqual([]);
  });
});

describe('the voucher keeps the bill\'s number and date', () => {
  test('typed on the voucher it wins over the request; a draft edit changes it', async () => {
    const w = world();
    const { id } = await raise(w, JAMES, { billNo: 'MLE-0925', billDate: '2026-09-01' });
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id, { billRef: 'MLE-0925A', billDate: '2026-09-02' }));
    expect(pv.status).toBe(201);
    expect(w.sb.tables.payment_vouchers[0]).toMatchObject({ bill_ref: 'MLE-0925A', bill_date: '2026-09-02' });
    expect((await fin(`/payment-vouchers/${pv.body.id}`, 'PATCH', { billRef: 'MLE-0926' })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers[0]).toMatchObject({ bill_ref: 'MLE-0926', bill_date: '2026-09-02' });
  });
});

describe('the pure pieces', () => {
  test('normalizeBillNo folds case, spaces and punctuation', () => {
    expect(normalizeBillNo(' inv/00-12 ')).toBe('INV0012');
    expect(normalizeBillNo(null)).toBe('');
  });
  test('readBillFacts checks the total and keeps the flag strict', () => {
    expect(readBillFacts({ billTotalSen: 12.5 })).toMatchObject({ error: 'bill_total_invalid' });
    expect(readBillFacts({ billNo: ' A1 ', billDate: '2026-09-01', billTotalSen: 100, eventBill: 'true' })).toEqual({
      facts: { bill_no: 'A1', bill_date: '2026-09-01', bill_total_sen: 100, event_bill: false, no_event_reason: null },
    });
  });
  test('eventBillRefusal asks only of an event bill with neither an event nor a reason', () => {
    expect(eventBillRefusal({ event_bill: false, project_id: null, no_event_reason: null })).toBeNull();
    expect(eventBillRefusal({ event_bill: true, project_id: 1, no_event_reason: null })).toBeNull();
    expect(eventBillRefusal({ event_bill: true, project_id: null, no_event_reason: 'Not in PMS' })).toBeNull();
    expect(eventBillRefusal({ event_bill: true, project_id: null, no_event_reason: ' ab ' })).toMatchObject({ error: 'event_required' });
  });
  test('pvBillFields takes the body first, then the request', () => {
    expect(pvBillFields({}, { bill_no: 'R-1', bill_date: '2026-09-01' })).toEqual({ bill_ref: 'R-1', bill_date: '2026-09-01' });
    expect(pvBillFields({ billRef: '', billDate: null }, { bill_no: 'R-1', bill_date: '2026-09-01' })).toEqual({ bill_ref: null, bill_date: null });
    expect(pvBillFields({}, null)).toEqual({ bill_ref: null, bill_date: null });
  });
});

/* ── Item 2 (owner 2026-10-01): 一张单付两次 — 我不想要他们上传两次 ─────────────
   The first request names the bill (its total) and how much is paid now — an
   amount or a percent; 申请付余额 raises the next instalment of the SAME bill
   from it: no second upload, payee / bank / event carried, the bill's figures
   read for the whole family. */
describe('a bill paid in instalments', () => {
  const FIRST = { billNo: 'MLE-0925', billDate: '2026-09-01', billTotalSen: 1_000_000, amountSen: 500_000, payPct: 50 };

  test('申请付余额 raises the next instalment of the same bill — no upload, payee, bank and event carried', async () => {
    const w = world();
    const first = await raise(w, JAMES, { ...FIRST, bankName: 'Maybank', bankAccountNo: '5123', bankAccountName: 'MLE EVENTS SDN BHD' });
    const bal = await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 500_000, dueDate: '2026-10-15' });
    expect(bal.status).toBe(201);
    expect(bal.body.overTotal).toBe(false);
    const child = w.sb.tables.acc_payment_requests.find((r) => r.id === bal.body.request.id)!;
    expect(child).toMatchObject({
      parent_request_id: first.id, installment_no: 2, status: 'SUBMITTED', amount_sen: 500_000, due_date: '2026-10-15',
      payee_name: 'MLE EVENTS SDN BHD', bank_name: 'Maybank', bank_account_no: '5123', project_id: 348,
      bill_no: 'MLE-0925', bill_date: '2026-09-01', bill_total_sen: 1_000_000, event_bill: false,
      purpose: 'Balance — Booth F1 rental — MLE Penang',
    });
    expect(w.sb.tables.acc_payment_request_files.filter((f) => f.request_id === child.id)).toHaveLength(0);
    expect(w.sb.tables.acc_payment_requests.find((r) => r.id === first.id)).toMatchObject({ pay_pct: 50 });
  });

  test('the bill\'s figures read for the whole family: total, asked, paid, pending, left to ask', async () => {
    const w = world();
    const first = await raise(w, JAMES, FIRST);
    const bal = await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 300_000 });
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(first.id, { lines: [{ debitAccountCode: '900-R032', description: 'Deposit', amountSen: 500_000, projectId: 348 }] }));
    expect(pv.status).toBe(201);
    Object.assign(w.sb.tables.payment_vouchers[0]!, { pv_number: 'HC-PV-2610-001', checked_at: '2026-10-01T01:00:00Z', approved_at: '2026-10-01T02:00:00Z' });
    expect((await fin(`/payment-vouchers/${pv.body.id}/post`, 'POST')).status).toBe(200);
    for (const id of [first.id, String(bal.body.request.id)]) {
      const fam = (await first.ask(`/payment-requests/${id}`)).body.request.family;
      expect(fam).toMatchObject({ rootId: first.id, rootNo: first.no, totalSen: 1_000_000, askedSen: 800_000, paidSen: 500_000, pendingSen: 300_000, remainingSen: 200_000 });
      expect(fam.installments.map((m: Row) => [m.installment_no, m.amount_sen, m.stage])).toEqual([[1, 500_000, 'PAID'], [2, 300_000, 'SUBMITTED']]);
    }
    /* A withdrawn instalment asks for nothing. */
    await first.ask(`/payment-requests/${bal.body.request.id}/withdraw`, 'POST');
    expect((await first.ask(`/payment-requests/${first.id}`)).body.request.family).toMatchObject({ askedSen: 500_000, remainingSen: 500_000 });
  });

  test('more than the bill is said, not refused; a balance of a balance is the next of the first; a withdrawn first takes none', async () => {
    const w = world();
    const first = await raise(w, JAMES, FIRST);
    const two = await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 500_000 });
    const over = await first.ask(`/payment-requests/${two.body.request.id}/balance`, 'POST', { amountSen: 100_000 });
    expect(over.status).toBe(201);
    expect(over.body.overTotal).toBe(true);
    expect(w.sb.tables.acc_payment_requests.find((r) => r.id === over.body.request.id)).toMatchObject({ parent_request_id: first.id, installment_no: 3 });
    expect((await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 0 })).status).toBe(400);
    expect((await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 1, payPct: 101 })).body.error).toBe('pay_pct_invalid');
    expect((await as(w, KAR)(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 1 })).status).toBe(404);

    const w2 = world();
    const gone = await raise(w2, JAMES, FIRST);
    await gone.ask(`/payment-requests/${gone.id}/withdraw`, 'POST');
    const refused = await gone.ask(`/payment-requests/${gone.id}/balance`, 'POST', { amountSen: 500_000 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('bill_withdrawn');
  });

  test('Finance answers a balance with the first request\'s bill — it travels to the voucher, and the reader reads it', async () => {
    const w = world();
    const first = await raise(w, JAMES, FIRST);
    const bal = await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 500_000 });
    const balId = String(bal.body.request.id);
    const pv = await as(w, FINANCE)('/payment-vouchers', 'POST', voucherFor(balId, { lines: [{ debitAccountCode: '900-R032', description: 'Balance', amountSen: 500_000, projectId: 348 }] }));
    expect(pv.status).toBe(201);
    expect(w.sb.tables.acc_pv_files.filter((f) => f.pv_id === pv.body.id)).toHaveLength(1);
    const sent = reads({ invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-01', totalRm: 10000 });
    const read = await as(w, FINANCE)('/payment-vouchers/extract', 'POST', { fromRequest: balId });
    expect(read.body.bills).toHaveLength(1);
    expect(sent[0]).toContain(btoa('page 0'));
  });

  test('a bill\'s own instalments are never its matches; a NEW request for the same bill names them all', async () => {
    const w = world();
    const first = await raise(w, JAMES, FIRST);
    const bal = await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 500_000 });
    const fin = as(w, FINANCE);
    expect((await fin(`/payment-requests/${first.id}`)).body.request.billMatches).toEqual([]);
    expect((await fin(`/payment-requests/${bal.body.request.id}`)).body.request.billMatches).toEqual([]);
    const stray = await raise(w, KAR, { billNo: 'MLE 0925', billDate: '2026-09-01' });
    expect((await fin(`/payment-requests/${stray.id}`)).body.request.billMatches.map((m: Row) => m.id).sort()).toEqual([first.id, String(bal.body.request.id)].sort());
  });
});

/* ── Item 3 (owner 2026-10-01): 欠正式单 — a payment made on a proforma owes its
   official invoice. FINANCE marks it (the voucher's tick); the requester sees
   it on their request and uploads the official invoice later — copied to the
   payment, RECEIVED, with what the reader found; Finance checks it off its list.
   The ledger never moves. */
describe('a payment on a proforma owes its official invoice', () => {
  const PROFORMA = { billNo: 'MLE-PF-0925', billDate: '2026-09-01', billTotalSen: 850_000 };
  const paidOn = async (w: ReturnType<typeof world>, over: Row = {}) => {
    const req = await raise(w, JAMES, PROFORMA);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(req.id, { officialDocOwed: true, ...over }));
    expect(pv.status).toBe(201);
    return { req, fin, pvId: String(pv.body.id) };
  };
  const OFFICIAL = { fileName: 'official.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF official') };

  test('Finance marks it on the voucher; the requester reads it on their request', async () => {
    const w = world();
    const { req, pvId } = await paidOn(w);
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)).toMatchObject({ official_doc: 'OWED', official_doc_by: 'Chew' });
    expect((await req.ask(`/payment-requests/${req.id}`)).body.request.officialDoc).toEqual({ state: 'OWED', note: null });
  });

  test('the requester uploads the official invoice: it stays on the request, travels to the voucher, and waits for Finance with the reader\'s note', async () => {
    const w = world();
    const { req, fin, pvId } = await paidOn(w);
    reads({ invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-20', totalRm: 9000 });
    const up = await req.ask(`/payment-requests/${req.id}/official-doc`, 'POST', OFFICIAL);
    expect(up.status).toBe(201);
    expect(up.body.received).toEqual([{ kind: 'PV', number: w.sb.tables.payment_vouchers[0]!.pv_number ?? null }]);
    expect(up.body.note).toBe('The official invoice reads RM 9,000.00; the proforma read RM 8,500.00 (more by RM 500.00).');
    expect(w.sb.tables.acc_payment_request_files.filter((f) => f.request_id === req.id && f.kind === 'official')).toHaveLength(1);
    expect(w.sb.tables.acc_pv_files.filter((f) => f.pv_id === pvId && f.kind === 'official')).toHaveLength(1);
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)).toMatchObject({ official_doc: 'RECEIVED', official_doc_note: up.body.note });
    expect((await req.ask(`/payment-requests/${req.id}`)).body.request.officialDoc).toMatchObject({ state: 'RECEIVED' });

    /* Finance's list: received, to check — with the request and who asked. */
    const list = await fin('/official-docs');
    expect(list.body.rows).toEqual([expect.objectContaining({ kind: 'PV', id: pvId, state: 'RECEIVED', request: { id: req.id, requestNo: req.no, requestedBy: 'James Seow' } })]);
    expect((await fin(`/official-docs/PV/${pvId}`, 'POST', { state: 'CHECKED', note: 'Balance RM 500 paid separately' })).status).toBe(200);
    expect((await fin('/official-docs')).body.rows).toEqual([]);
    expect((await fin('/official-docs?all=1')).body.rows).toEqual([expect.objectContaining({ id: pvId, state: 'CHECKED', note: 'Balance RM 500 paid separately' })]);
    /* The voucher's ledger was never touched by any of it. */
    expect(w.sb.tables.journal_entries).toHaveLength(0);
  });

  test('Finance alone marks; checked needs a mark first; RECEIVED is the upload\'s; a cancelled payment owes nothing', async () => {
    const w = world();
    const { req, fin, pvId } = await paidOn(w, { officialDocOwed: false });
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)!.official_doc ?? null).toBeNull();
    expect((await fin(`/official-docs/PV/${pvId}`, 'POST', { state: 'CHECKED' })).body.error).toBe('nothing_owed');
    expect((await fin(`/official-docs/PV/${pvId}`, 'POST', { state: 'RECEIVED' })).body.error).toBe('bad_state');
    expect((await req.ask(`/official-docs/PV/${pvId}`, 'POST', { state: 'OWED' })).status).toBe(403);
    expect((await req.ask('/official-docs')).status).toBe(403);
    expect((await fin(`/official-docs/PV/${pvId}`, 'POST', { state: 'OWED' })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)).toMatchObject({ official_doc: 'OWED' });
    expect((await fin(`/official-docs/PV/${pvId}`, 'POST', { state: null })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)!.official_doc).toBeNull();
    w.sb.tables.payment_vouchers.find((v) => v.id === pvId)!.status = 'CANCELLED';
    expect((await fin(`/official-docs/PV/${pvId}`, 'POST', { state: 'OWED' })).body.error).toBe('doc_cancelled');
  });

  test('uploaded on the balance, it reaches every payment of the bill that owes it', async () => {
    const w = world();
    const first = await raise(w, JAMES, { ...PROFORMA, amountSen: 500_000 });
    const fin = as(w, FINANCE);
    const pv1 = await fin('/payment-vouchers', 'POST', voucherFor(first.id, { officialDocOwed: true, lines: [{ debitAccountCode: '900-R032', description: 'Deposit', amountSen: 500_000 }] }));
    const bal = await first.ask(`/payment-requests/${first.id}/balance`, 'POST', { amountSen: 350_000 });
    const pv2 = await fin('/payment-vouchers', 'POST', voucherFor(String(bal.body.request.id), { officialDocOwed: true, lines: [{ debitAccountCode: '900-R032', description: 'Balance', amountSen: 350_000 }] }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 529 })));
    const up = await first.ask(`/payment-requests/${bal.body.request.id}/official-doc`, 'POST', OFFICIAL);
    expect(up.status).toBe(201);
    expect(up.body.received).toHaveLength(2);
    expect(up.body.note).toBeNull();
    for (const id of [pv1.body.id, pv2.body.id]) {
      expect(w.sb.tables.payment_vouchers.find((v) => v.id === id)).toMatchObject({ official_doc: 'RECEIVED' });
    }
  });

  test('a draft voucher\'s tick goes on and comes off; an AP invoice booked on a proforma owes the same way', async () => {
    const w = world();
    const { fin, pvId } = await paidOn(w, { officialDocOwed: false });
    expect((await fin(`/payment-vouchers/${pvId}`, 'PATCH', { officialDocOwed: true })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)).toMatchObject({ official_doc: 'OWED' });
    expect((await fin(`/payment-vouchers/${pvId}`, 'PATCH', { officialDocOwed: false })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers.find((v) => v.id === pvId)!.official_doc).toBeNull();

    const req2 = await raise(w, KAR, { billNo: 'Q-1', billDate: '2026-09-02' });
    const inv = await fin('/ap-invoices', 'POST', {
      supplierId: 'sup-mle', supplierInvoiceRef: 'Q-1', invoiceDate: '2026-09-02', paymentRequestId: req2.id, officialDocOwed: true,
      lines: [{ debitAccountCode: '900-R032', description: 'Booth', amountSen: 850_000 }],
    });
    expect(inv.status).toBe(201);
    expect(w.sb.tables.ap_invoices[0]).toMatchObject({ official_doc: 'OWED' });
    expect((await as(w, KAR)(`/payment-requests/${req2.id}`)).body.request.officialDoc).toEqual({ state: 'OWED', note: null });
    expect((await fin('/official-docs')).body.rows.map((r: Row) => r.kind).sort()).toEqual(['API']);
  });

  test('the pure pieces: the reader against the proforma, and the tick', () => {
    expect(compareOfficial({ invoiceNumber: 'INV-1', totalSen: 850_000 }, { billNo: 'PF-1', totalSen: 850_000 })).toBeNull();
    expect(compareOfficial({ invoiceNumber: 'pf 1', totalSen: 850_000 }, { billNo: 'PF-1', totalSen: 850_000 })).toBe("It carries the proforma's own number (pf 1) — check it is the official invoice.");
    expect(compareOfficial(null, { billNo: null, totalSen: null })).toBeNull();
    expect(officialOwedFields({ officialDocOwed: true }, 'Chew')).toMatchObject({ official_doc: 'OWED', official_doc_by: 'Chew' });
    expect(officialOwedFields({}, 'Chew')).toEqual({});
    expect(officialOwedUpdates({ officialDocOwed: false }, 'Chew', { official_doc: 'RECEIVED' })).toEqual({});
  });
});
