/* 申请付款 — the payment request (owner 2026-09-29/30: 3a a new document, 4a a
   new permission; the requester sees 已付 when the voucher is approved, and
   银行已确认 once its bank line is matched). Pinned through the real routers:
     • a holder of scm.payment_request.create raises, edits and withdraws their
       OWN request; another requester cannot even see it; Finance sees all;
     • Finance returns a request with the why; the requester fixes it and it
       goes back in;
     • a voucher made from the request claims it and carries its bill; a second
       voucher for the same request is refused and never stands;
     • the stage is read off the voucher: Processing → Paid at approval → Bank
       confirmed once a POSTED bank line matches its entry; a cancelled voucher
       lets Finance make the next one;
     • requireScmAccess admits the key for /payment-requests and nothing else.
   Same fake-PostgREST harness as tests/eventPerLine.test.ts. */

import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { requireScmAccess } from '../src/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { paymentVouchers } from '../src/scm/routes/payment-vouchers';
import { paymentRequests } from '../src/scm/routes/payment-requests';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { requestStage } from '../src/scm/lib/payment-request';

const CO = 1;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const JAMES = { id: 22, name: 'James Seow', perms: ['scm.payment_request.create'] };
const KAR = { id: 23, name: 'Kar Jiun', perms: ['scm.payment_request.create'] };
const FINANCE = { id: 9, name: 'Chew', perms: PV_KEYS };
const NOBODY = { id: 50, name: 'Warehouse', perms: ['scm.access'] };

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});

const EVENTS: Row[] = [
  { id: 348, company_id: 1, code: '2026-09-MLE-PENANG-PWCC-AKEMI', name: 'Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: null },
  { id: 900, company_id: 2, code: 'OTHER', name: 'Another company\'s fair', start_date: '2026-09-05', end_date: '2026-09-07', status: 'confirmed', archived_at: null },
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
            return { results: hit.map((r) => ({ id: r.id, code: r.code, name: r.name, startdate: r.start_date, enddate: r.end_date, status: r.status, archivedat: r.archived_at })) as unknown as T[] };
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
      acct('900-A001', 'RENTAL', 'EXPENSE', { parent_code: '900-0000' }),
      acct('310-0010', 'MAYBANK', 'ASSET', { acc_money: true }),
    ],
    suppliers: [{ id: 'sup-mle', company_id: CO, code: '400-M001', name: 'MLE EVENTS SDN BHD', status: 'ACTIVE' }],
    ap_invoices: [],
    ap_invoice_lines: [],
    acc_ap_invoice_files: [],
    companies: [{ id: CO, code: 'HC' }],
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

function as(w: ReturnType<typeof world>, who: { id: number; name: string; perms: string[] }) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, w.sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: who.id, name: who.name, permissions_set: new Set(who.perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
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

const RENTAL = {
  payeeName: 'MLE EVENTS SDN BHD', amountSen: 850_000, dueDate: '2026-09-15', purpose: 'Booth F1 rental — MLE Penang',
  projectId: 348, bankName: 'Maybank', bankAccountNo: '5123 4567 8901', bankAccountName: 'MLE EVENTS SDN BHD',
};

async function raised(w: ReturnType<typeof world>) {
  const james = as(w, JAMES);
  const r = await james('/payment-requests', 'POST', RENTAL);
  expect(r.status).toBe(201);
  return { james, id: String(r.body.request.id), no: String(r.body.request.request_no) };
}

describe('the requester raises, changes and withdraws their own request', () => {
  test('raise: a numbered SUBMITTED request carrying who asked, the event and the payee\'s bank', async () => {
    const w = world();
    const { no } = await raised(w);
    expect(no).toMatch(/PRQ-\d{4}-001$/);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({
      status: 'SUBMITTED', requested_by: 22, requested_by_name: 'James Seow', amount_sen: 850_000, project_id: 348,
      bank_account_no: '5123 4567 8901', payee_name: 'MLE EVENTS SDN BHD',
    });
    expect(w.sb.tables.entity_audit_log.filter((a) => a.entity_type === 'PAYMENT_REQUEST' && a.action === 'CREATE')).toHaveLength(1);
  });

  test('a request without payee, purpose or a positive amount, or naming another company\'s event, is refused', async () => {
    const w = world();
    const james = as(w, JAMES);
    for (const bad of [{ payeeName: '' }, { purpose: ' ' }, { amountSen: 0 }, { amountSen: 12.5 }]) {
      expect((await james('/payment-requests', 'POST', { ...RENTAL, ...bad })).status).toBe(400);
    }
    const foreign = await james('/payment-requests', 'POST', { ...RENTAL, projectId: 900 });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('event_not_found');
    expect(w.sb.tables.acc_payment_requests).toHaveLength(0);
  });

  test('a requester sees only their own; another requester cannot open it; Finance sees all', async () => {
    const w = world();
    const { id } = await raised(w);
    const kar = as(w, KAR);
    await kar('/payment-requests', 'POST', { ...RENTAL, payeeName: 'REX EXPO' });
    expect((await kar('/payment-requests')).body.requests.map((r: Row) => r.payee_name)).toEqual(['REX EXPO']);
    expect((await kar(`/payment-requests/${id}`)).status).toBe(404);
    expect((await kar(`/payment-requests/${id}`, 'PATCH', { amountSen: 1 })).status).toBe(404);
    const fin = await as(w, FINANCE)('/payment-requests');
    expect(fin.body.finance).toBe(true);
    expect(fin.body.requests).toHaveLength(2);
    expect((await as(w, NOBODY)('/payment-requests')).status).toBe(403);
  });

  test('the requester edits while it waits; Finance cannot edit it; a withdrawn request is closed', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const edited = await james(`/payment-requests/${id}`, 'PATCH', { amountSen: 900_000 });
    expect(edited.status).toBe(200);
    expect(w.sb.tables.acc_payment_requests[0]!.amount_sen).toBe(900_000);
    expect((await as(w, FINANCE)(`/payment-requests/${id}`, 'PATCH', { amountSen: 1 })).status).toBe(403);
    expect((await james(`/payment-requests/${id}/withdraw`, 'POST')).status).toBe(200);
    expect(w.sb.tables.acc_payment_requests[0]!.status).toBe('WITHDRAWN');
    expect((await james(`/payment-requests/${id}`, 'PATCH', { amountSen: 5 })).status).toBe(409);
  });
});

describe('Finance returns a request with the why; the requester sends it again', () => {
  test('return needs a note; the fix puts it back to SUBMITTED', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const fin = as(w, FINANCE);
    expect((await fin(`/payment-requests/${id}/return`, 'POST', { note: ' ' })).status).toBe(400);
    expect((await james(`/payment-requests/${id}/return`, 'POST', { note: 'x' })).status).toBe(403);
    expect((await fin(`/payment-requests/${id}/return`, 'POST', { note: 'Attach the organiser\'s invoice, not the quotation' })).status).toBe(200);
    const mine = await james(`/payment-requests/${id}`);
    expect(mine.body.request).toMatchObject({ stage: 'RETURNED', finance_note: 'Attach the organiser\'s invoice, not the quotation', decided_by: 'Chew' });
    expect((await james(`/payment-requests/${id}`, 'PATCH', { purpose: 'Booth F1 rental — invoice MLE-0925' })).status).toBe(200);
    expect((await james(`/payment-requests/${id}`)).body.request.stage).toBe('SUBMITTED');
  });
});

describe('the voucher that answers a request', () => {
  const voucherFor = (id: string, amountSen = 850_000) => ({
    payeeName: 'MLE EVENTS SDN BHD', creditAccountCode: '310-0010', voucherDate: '2026-09-10', purpose: 'OTHER', paymentRequestId: id,
    lines: [{ debitAccountCode: '900-A001', description: 'Booth F1 rental', amountSen, projectId: 348 }],
  });

  test('claims the request and carries its bill; a second voucher for it is refused and never stands', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const up = await james(`/payment-requests/${id}/files`, 'POST', { fileName: 'mle-invoice.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF-1.4 bill') });
    expect(up.status).toBe(201);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id));
    expect(pv.status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ status: 'VOUCHERED', pv_id: pv.body.id });
    /* The bill travelled: a copy under the voucher's own prefix, indexed on it. */
    expect(w.sb.tables.acc_pv_files).toHaveLength(1);
    expect(String(w.sb.tables.acc_pv_files[0]!.file_key)).toMatch(new RegExp(`^pv-files/1/${pv.body.id}/`));
    expect(w.r2.store.size).toBe(2);
    expect((await james(`/payment-requests/${id}`)).body.request).toMatchObject({ stage: 'PROCESSING', voucher: { id: pv.body.id } });

    const again = await fin('/payment-vouchers', 'POST', voucherFor(id));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('request_has_voucher');
    expect(w.sb.tables.payment_vouchers).toHaveLength(1);
    /* Answered: the requester can no longer change or withdraw it, nor drop its bill. */
    expect((await james(`/payment-requests/${id}`, 'PATCH', { amountSen: 1 })).status).toBe(409);
    expect((await james(`/payment-requests/${id}/withdraw`, 'POST')).status).toBe(409);
  });

  test('Paid when the voucher is approved; Bank confirmed once a POSTED bank line matches its entry', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id));
    const row = w.sb.tables.payment_vouchers[0]!;
    Object.assign(row, { pv_number: 'HC-PV-2609-001', checked_at: '2026-09-10T01:00:00Z', approved_at: '2026-09-10T02:00:00Z' });
    expect((await fin(`/payment-vouchers/${pv.body.id}/post`, 'POST')).status).toBe(200);
    const paid = (await james(`/payment-requests/${id}`)).body.request;
    expect(paid).toMatchObject({ stage: 'PAID', voucher: { pvNumber: 'HC-PV-2609-001', status: 'POSTED', bankConfirmed: false } });

    const je = w.sb.tables.journal_entries.find((j) => j.source_type === 'PV')!;
    w.sb.tables.acc_bank_statement_lines.push({ id: 'bl-1', company_id: CO, state: 'OPEN' });
    w.sb.tables.acc_bank_statement_matches.push({ company_id: CO, je_no: je.je_no, bank_line_id: 'bl-1', amount_sen: 850_000 });
    /* A match on a line that is not POSTED is nobody's claim yet. */
    expect((await james(`/payment-requests/${id}`)).body.request.stage).toBe('PAID');
    w.sb.tables.acc_bank_statement_lines[0]!.state = 'POSTED';
    expect((await james(`/payment-requests/${id}`)).body.request).toMatchObject({ stage: 'BANK_CONFIRMED', voucher: { bankConfirmed: true } });
  });

  test('a cancelled voucher lets Finance make the next one, or return the request', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id));
    w.sb.tables.payment_vouchers[0]!.status = 'CANCELLED';
    expect((await james(`/payment-requests/${id}`)).body.request.stage).toBe('VOUCHER_CANCELLED');
    const next = await fin('/payment-vouchers', 'POST', voucherFor(id, 840_000));
    expect(next.status).toBe(201);
    expect(next.body.id).not.toBe(pv.body.id);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ status: 'VOUCHERED', pv_id: next.body.id });
    /* With a live voucher again, Finance cannot return it without cancelling first. */
    expect((await fin(`/payment-requests/${id}/return`, 'POST', { note: 'no' })).status).toBe(409);
  });

  test('a withdrawn or returned request takes no voucher; an unknown one is refused', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const fin = as(w, FINANCE);
    await james(`/payment-requests/${id}/withdraw`, 'POST');
    const closed = await fin('/payment-vouchers', 'POST', voucherFor(id));
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe('request_closed');
    expect((await fin('/payment-vouchers', 'POST', voucherFor('no-such-request'))).status).toBe(404);
    expect(w.sb.tables.payment_vouchers).toHaveLength(0);
  });
});

/* ── The AP invoice that answers a request (owner 2026-09-30, 6.1–6.4 → 做) ──
   A supplier's bill is booked first and paid later by an AP Payment; the
   request points at ONE live document of either kind. */
describe('the AP invoice that answers a request', () => {
  const invoiceFor = (id: string) => ({
    supplierId: 'sup-mle', supplierInvoiceRef: 'MLE-0925', invoiceDate: '2026-09-10', paymentRequestId: id,
    lines: [{ debitAccountCode: '900-A001', description: 'Booth F1 rental', amountSen: 850_000, projectId: 348 }],
  });
  const voucherFor = (id: string) => ({
    payeeName: 'MLE EVENTS SDN BHD', creditAccountCode: '310-0010', voucherDate: '2026-09-10', purpose: 'OTHER', paymentRequestId: id,
    lines: [{ debitAccountCode: '900-A001', description: 'Booth F1 rental', amountSen: 850_000, projectId: 348 }],
  });

  test('claims the request and carries its bill onto the invoice; a second answer of either kind is refused', async () => {
    const w = world();
    const { james, id } = await raised(w);
    expect((await james(`/payment-requests/${id}/files`, 'POST', { fileName: 'mle-invoice.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF-1.4 bill') })).status).toBe(201);
    const fin = as(w, FINANCE);
    const inv = await fin('/ap-invoices', 'POST', invoiceFor(id));
    expect(inv.status).toBe(201);
    expect(inv.body.requestFilesCopied).toBe(1);
    const invId = String(inv.body.invoice.id);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ status: 'VOUCHERED', ap_invoice_id: invId, pv_id: null });
    expect(w.sb.tables.acc_ap_invoice_files).toHaveLength(1);
    expect(String(w.sb.tables.acc_ap_invoice_files[0]!.file_key)).toMatch(new RegExp(`^ap-invoice-files/1/${invId}/`));
    expect((await james(`/payment-requests/${id}`)).body.request).toMatchObject({
      stage: 'PROCESSING', voucher: null, invoice: { id: invId, status: 'DRAFT', totalSen: 850_000, paidSen: 0 },
    });

    const again = await fin('/ap-invoices', 'POST', invoiceFor(id));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('request_has_voucher');
    expect(String(again.body.message)).toContain('AP invoice');
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id));
    expect(pv.status).toBe(409);
    expect(w.sb.tables.ap_invoices).toHaveLength(1);
    expect(w.sb.tables.payment_vouchers).toHaveLength(0);
  });

  test('Booked when posted, Partly paid, Paid, then Bank confirmed once every AP Payment that paid it is on a statement', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const fin = as(w, FINANCE);
    const invId = String((await fin('/ap-invoices', 'POST', invoiceFor(id))).body.invoice.id);
    const bill = w.sb.tables.ap_invoices[0]!;
    const stage = async () => (await james(`/payment-requests/${id}`)).body.request;

    bill.status = 'POSTED';
    expect((await stage()).stage).toBe('BOOKED');

    /* An AP Payment paid part of it: posted, with an allocation on the bill. */
    w.sb.tables.payment_vouchers.push({ id: 'pv-a', company_id: CO, pv_number: 'HC-PV-2609-010', status: 'POSTED' });
    w.sb.tables.pv_allocations.push({ id: 'al-a', company_id: CO, pv_id: 'pv-a', ap_invoice_id: invId, amount_sen: 300_000, applied_sen: 300_000 });
    Object.assign(bill, { status: 'PARTIALLY_PAID', paid_sen: 300_000 });
    expect(await stage()).toMatchObject({ stage: 'PARTLY_PAID', invoice: { paidSen: 300_000, totalSen: 850_000, paidBy: ['HC-PV-2609-010'] } });

    /* A second one paid the rest — and a DRAFT payment is nobody's payer yet. */
    w.sb.tables.payment_vouchers.push({ id: 'pv-b', company_id: CO, pv_number: 'HC-PV-2609-011', status: 'POSTED' });
    w.sb.tables.payment_vouchers.push({ id: 'pv-c', company_id: CO, pv_number: null, status: 'DRAFT' });
    w.sb.tables.pv_allocations.push({ id: 'al-b', company_id: CO, pv_id: 'pv-b', ap_invoice_id: invId, amount_sen: 550_000, applied_sen: 550_000 });
    w.sb.tables.pv_allocations.push({ id: 'al-c', company_id: CO, pv_id: 'pv-c', ap_invoice_id: invId, amount_sen: 1, applied_sen: 0 });
    Object.assign(bill, { status: 'PAID', paid_sen: 850_000 });
    expect(await stage()).toMatchObject({ stage: 'PAID', invoice: { bankConfirmed: false, paidBy: ['HC-PV-2609-010', 'HC-PV-2609-011'] } });

    /* One payment on the bank is not enough; both are. */
    const onBank = (pvNo: string, lineId: string) => {
      w.sb.tables.journal_entries.push({ id: `je-${lineId}`, company_id: CO, je_no: `JE-${pvNo}`, source_type: 'PV', source_doc_no: pvNo, reversed: false, posted: true });
      w.sb.tables.acc_bank_statement_lines.push({ id: lineId, company_id: CO, state: 'POSTED' });
      w.sb.tables.acc_bank_statement_matches.push({ company_id: CO, je_no: `JE-${pvNo}`, bank_line_id: lineId, amount_sen: 1 });
    };
    onBank('HC-PV-2609-010', 'bl-a');
    expect((await stage()).stage).toBe('PAID');
    onBank('HC-PV-2609-011', 'bl-b');
    expect(await stage()).toMatchObject({ stage: 'BANK_CONFIRMED', invoice: { bankConfirmed: true } });
  });

  test('a live AP invoice stops a return; once cancelled, Finance may answer with a voucher instead', async () => {
    const w = world();
    const { james, id } = await raised(w);
    const fin = as(w, FINANCE);
    await fin('/ap-invoices', 'POST', invoiceFor(id));
    const blocked = await fin(`/payment-requests/${id}/return`, 'POST', { note: 'wrong supplier' });
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.message)).toContain('cancel that AP invoice first');
    w.sb.tables.ap_invoices[0]!.status = 'CANCELLED';
    expect((await james(`/payment-requests/${id}`)).body.request.stage).toBe('VOUCHER_CANCELLED');
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id));
    expect(pv.status).toBe(201);
    /* The request now points at the voucher alone. */
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ status: 'VOUCHERED', pv_id: pv.body.id, ap_invoice_id: null });
    expect((await james(`/payment-requests/${id}`)).body.request).toMatchObject({ stage: 'PROCESSING', invoice: null, voucher: { id: pv.body.id } });
  });
});

/* ── The bill read when Finance opens the answer (6.2) ─────────────────────── */
describe('POST /payment-vouchers/extract { fromRequest } reads the request\'s own bill', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('its files are one bill\'s pages, read from the file store', async () => {
    const w = world();
    const { james, id } = await raised(w);
    await james(`/payment-requests/${id}/files`, 'POST', { fileName: 'p1.jpg', mime: 'image/jpeg', dataBase64: btoa('page one') });
    await james(`/payment-requests/${id}/files`, 'POST', { fileName: 'p2.jpg', mime: 'image/jpeg', dataBase64: btoa('page two') });
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ vendorName: 'MLE EVENTS SDN BHD', documentKind: 'invoice', invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-01', currency: 'MYR', totalRm: 8500, lines: [{ description: 'Booth F1 rental', amountRm: 8500 }], event: null }) }] }), { status: 200 });
    }));
    const res = await as(w, FINANCE)('/payment-vouchers/extract', 'POST', { fromRequest: id });
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0]).toMatchObject({ ok: true, extraction: { invoiceNumber: 'MLE-0925', totalSen: 850_000 }, supplierMatch: { id: 'sup-mle' } });
    /* One call, both pages in it. */
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(btoa('page one'));
    expect(sent[0]).toContain(btoa('page two'));
  });

  test('a request with no bill reads as none, without calling the reader; another company\'s is not found; a requester cannot ask', async () => {
    const w = world();
    const { id } = await raised(w);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const fin = as(w, FINANCE);
    const none = await fin('/payment-vouchers/extract', 'POST', { fromRequest: id });
    expect(none.status).toBe(200);
    expect(none.body.bills).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await fin('/payment-vouchers/extract', 'POST', { fromRequest: 'no-such-request' })).status).toBe(404);
    expect((await as(w, JAMES)('/payment-vouchers/extract', 'POST', { fromRequest: id })).status).toBe(403);
  });
});

describe('the files are the requester\'s own', () => {
  test('another requester cannot add to it or read it', async () => {
    const w = world();
    const { id } = await raised(w);
    const kar = as(w, KAR);
    expect((await kar(`/payment-requests/${id}/files`, 'POST', { fileName: 'x.pdf', mime: 'application/pdf', dataBase64: btoa('x') })).status).toBe(404);
    expect((await kar(`/payment-requests/${id}/files`)).status).toBe(404);
  });
});

describe('requireScmAccess admits the key for /payment-requests alone', () => {
  const gate = (perms: string[]) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user' as never, { id: 22, permissions_set: new Set(perms), page_access: {} } as never);
      await next();
    });
    app.use('/api/scm/*', requireScmAccess as never);
    app.all('/api/scm/*', (c) => c.json({ ok: true }));
    return (path: string) => app.request(path);
  };
  test('the requester reaches payment requests and not the vouchers', async () => {
    const req = gate(['scm.payment_request.create']);
    expect((await req('/api/scm/payment-requests')).status).toBe(200);
    expect((await req('/api/scm/payment-requests/abc/files')).status).toBe(200);
    expect((await req('/api/scm/payment-vouchers')).status).toBe(403);
    expect((await req('/api/scm/payment-requests-archive')).status).toBe(403);
    expect((await gate([])('/api/scm/payment-requests')).status).toBe(403);
  });
});

describe('requestStage — the pure reading', () => {
  test('each stored status and voucher state reads as one stage', () => {
    const pv = (status: string) => ({ id: 'p', pv_number: 'PV-1', status, approved_at: null, posted_at: null });
    expect(requestStage('SUBMITTED', null, false)).toBe('SUBMITTED');
    expect(requestStage('VOUCHERED', null, false)).toBe('SUBMITTED');
    expect(requestStage('VOUCHERED', pv('DRAFT'), false)).toBe('PROCESSING');
    expect(requestStage('VOUCHERED', pv('POSTED'), false)).toBe('PAID');
    expect(requestStage('VOUCHERED', pv('POSTED'), true)).toBe('BANK_CONFIRMED');
    expect(requestStage('VOUCHERED', pv('CANCELLED'), false)).toBe('VOUCHER_CANCELLED');
    expect(requestStage('REJECTED', null, false)).toBe('RETURNED');
    expect(requestStage('WITHDRAWN', pv('POSTED'), true)).toBe('WITHDRAWN');
    const inv = (status: string) => ({ id: 'i', invoice_number: 'API-1', status, total_sen: 100, paid_sen: 0 });
    expect(requestStage('VOUCHERED', null, false, inv('DRAFT'))).toBe('PROCESSING');
    expect(requestStage('VOUCHERED', null, false, inv('POSTED'))).toBe('BOOKED');
    expect(requestStage('VOUCHERED', null, false, inv('PARTIALLY_PAID'))).toBe('PARTLY_PAID');
    expect(requestStage('VOUCHERED', null, false, inv('PAID'))).toBe('PAID');
    expect(requestStage('VOUCHERED', null, true, inv('PAID'))).toBe('BANK_CONFIRMED');
    expect(requestStage('VOUCHERED', null, false, inv('CANCELLED'))).toBe('VOUCHER_CANCELLED');
    expect(requestStage('REJECTED', null, false, inv('POSTED'))).toBe('RETURNED');
  });
});
