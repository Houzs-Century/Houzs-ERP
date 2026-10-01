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
