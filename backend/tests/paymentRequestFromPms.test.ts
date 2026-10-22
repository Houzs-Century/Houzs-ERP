/* A payment request raised from a PMS row (owner 2026-10-08: 我的bd 会upload
   rental invoice 在这里，可以让他连过来for request payment 吗 … 就在这里加
   request payment … 做，但可以有可能是performa invoice, 所以finance 这样也要可以
   remark 要follow up actual invoice). Pinned through the real routers:
     • a requester raises a request from the event's CONTRACT row: it keeps the
       row and takes the row's event when none is named;
     • the row must be the active company's, in a payable section, not N/A,
       and of the event the request names — anything else is refused by name;
     • the row reads its requests back (/from-checklist): a requester's own,
       Finance's all, each with its stage and 欠正式单 state;
     • 申请付余额 keeps the row, so every instalment shows on it;
     • Finance's remark rides 欠正式单: written with the tick on the voucher,
       changed while still owed, read back on the row.
   Same fake-PostgREST harness as tests/paymentRequests.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { paymentVouchers } from '../src/scm/routes/payment-vouchers';
import { paymentRequests } from '../src/scm/routes/payment-requests';
import { officialDocs } from '../src/scm/routes/official-docs';
import { isPayableSection, parseChecklistItemId } from '../src/scm/lib/pms-checklist-source';

const CO = 1;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const BD = { id: 31, name: 'Wei Ling', perms: ['scm.payment_request.create'] };
const OTHER_BD = { id: 32, name: 'Kar Jiun', perms: ['scm.payment_request.create'] };
const FINANCE = { id: 9, name: 'Chew', perms: PV_KEYS };
const NOBODY = { id: 50, name: 'Warehouse', perms: ['scm.access'] };

const EVENTS: Row[] = [
  { id: 348, company_id: 1, code: '2026-10-ZANOTTI-REX', name: 'Kuala Lumpur [ZANOTTI] REX @ MITEC', start_date: '2026-10-13', end_date: '2026-10-19', status: 'confirmed', archived_at: null },
  { id: 349, company_id: 1, code: '2026-10-AKEMI-IOI', name: 'Putrajaya [AKEMI] @ IOI CITY MALL', start_date: '2026-10-20', end_date: '2026-10-26', status: 'confirmed', archived_at: null },
];
const SECTIONS: Row[] = [{ id: 70, name: 'CONTRACT' }, { id: 71, name: 'BOOTH SETUP' }, { id: 80, name: 'CONTRACT' }];
const CHECKLIST: Row[] = [
  { id: 5001, project_id: 348, company_id: 1, title: 'Agreement / Quotation', status: 'done', section_id: 70 },
  { id: 5002, project_id: 348, company_id: 1, title: '3D Approved by Peter', status: 'pending', section_id: 71 },
  { id: 5003, project_id: 349, company_id: 1, title: 'Agreement / Quotation', status: 'na', section_id: 80 },
  { id: 6001, project_id: 900, company_id: 2, title: 'Agreement / Quotation', status: 'pending', section_id: 70 },
];

/* env.DB as the routes read it: the events (lib/event-tags.ts) and the
   checklist rows (lib/pms-checklist-source.ts), each under the company the
   route's own fragment names. */
const fakeDb = {
  prepare(sql: string) {
    return {
      bind(...vals: unknown[]) {
        return {
          async all<T>() {
            if (/FROM project_checklist c/.test(sql)) {
              const co = /c\.company_id = (\d+)/.exec(sql);
              const hit = CHECKLIST.filter((r) => r.id === Number(vals[0]) && (!co || r.company_id === Number(co[1])));
              return { results: hit.map((r) => ({ id: r.id, projectid: r.project_id, title: r.title, status: r.status, section: SECTIONS.find((s) => s.id === r.section_id)?.name ?? null })) as unknown as T[] };
            }
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

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});

function world() {
  const sb = fakeSb({
    accounts: [
      acct('900-0000', 'Operating Expense', 'EXPENSE'),
      acct('900-R032', 'RENTAL - EXHIBITION', 'EXPENSE', { parent_code: '900-0000' }),
      acct('310-0020', 'CASH AT BANK - HLBB', 'ASSET', { acc_money: true }),
    ],
    suppliers: [],
    companies: [{ id: CO, code: 'HC' }],
    acc_account_roles: [],
    acc_payment_requests: [],
    acc_payment_request_files: [],
    acc_pv_files: [],
    payment_vouchers: [],
    payment_voucher_lines: [],
    pv_allocations: [],
    ap_invoices: [],
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
  app.route('/official-docs', officialDocs);
  return async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: fakeDb, SLIPS: w.r2, ANTHROPIC_API_KEY: 'k' });
    return { status: res.status, body: await res.json() as Row };
  };
}

/* The BD's rental invoice off the Agreement / Quotation row — the event comes from the row. */
const FROM_ROW = {
  payeeName: 'MALAYSIA INTERNATIONAL TRADE & EXHIBITION CENTRE', amountSen: 1_272_000, dueDate: '2026-10-10',
  purpose: 'Booth rental — ZANOTTI REX', checklistItemId: 5001,
};

async function raisedFromRow(w: ReturnType<typeof world>, body: Row = FROM_ROW) {
  const bd = as(w, BD);
  const r = await bd('/payment-requests', 'POST', body);
  expect(r.status).toBe(201);
  const id = String(r.body.request.id);
  expect((await bd(`/payment-requests/${id}/files`, 'POST', { fileName: 'MITEC rental invoice.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF-1.4 proforma') })).status).toBe(201);
  return { bd, id, no: String(r.body.request.request_no) };
}

describe('the row a payment may come from', () => {
  test('ids parse like event ids; the CONTRACT section is the payable one', () => {
    expect(parseChecklistItemId(undefined)).toBeNull();
    expect(parseChecklistItemId('')).toBeNull();
    expect(parseChecklistItemId(5001)).toBe(5001);
    expect(parseChecklistItemId(' 5001 ')).toBe(5001);
    expect(parseChecklistItemId(true)).toBe('invalid');
    expect(parseChecklistItemId(-3)).toBe('invalid');
    expect(parseChecklistItemId('5001a')).toBe('invalid');
    expect(isPayableSection('CONTRACT')).toBe(true);
    expect(isPayableSection(' contract ')).toBe(true);
    expect(isPayableSection('BOOTH SETUP')).toBe(false);
    expect(isPayableSection(null)).toBe(false);
  });
});

describe('a request raised from an event\'s CONTRACT row', () => {
  test('keeps the row and takes the row\'s event when none is named', async () => {
    const w = world();
    const { no } = await raisedFromRow(w);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ request_no: no, checklist_item_id: 5001, project_id: 348, status: 'SUBMITTED' });
    /* The trail says where it came from. */
    const audit = w.sb.tables.entity_audit_log.find((a) => a.entity_type === 'PAYMENT_REQUEST' && a.action === 'CREATE');
    expect(JSON.stringify(audit)).toContain('checklistItemId');
  });

  test('the row\'s own event named is fine; another event, another company\'s row, a non-contract row, an N/A row or a bad id is refused by name', async () => {
    const w = world();
    const bd = as(w, BD);
    expect((await bd('/payment-requests', 'POST', { ...FROM_ROW, projectId: 348 })).status).toBe(201);
    const other = await bd('/payment-requests', 'POST', { ...FROM_ROW, projectId: 349 });
    expect(other.status).toBe(400);
    expect(other.body.error).toBe('checklist_event_mismatch');
    const foreign = await bd('/payment-requests', 'POST', { ...FROM_ROW, checklistItemId: 6001 });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('checklist_item_not_found');
    const setup = await bd('/payment-requests', 'POST', { ...FROM_ROW, checklistItemId: 5002 });
    expect(setup.status).toBe(400);
    expect(setup.body).toMatchObject({ error: 'checklist_item_not_payable' });
    expect(String(setup.body.message)).toContain('3D Approved by Peter');
    const na = await bd('/payment-requests', 'POST', { ...FROM_ROW, checklistItemId: 5003 });
    expect(na.status).toBe(409);
    expect(na.body.error).toBe('checklist_item_na');
    const bad = await bd('/payment-requests', 'POST', { ...FROM_ROW, checklistItemId: 'row-1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_checklist_item');
    /* Only the good one stands. */
    expect(w.sb.tables.acc_payment_requests).toHaveLength(1);
  });

  test('edited later, it keeps the row\'s event — moving it to another is refused; the rest still changes', async () => {
    const w = world();
    const { bd, id } = await raisedFromRow(w);
    const moved = await bd(`/payment-requests/${id}`, 'PATCH', { projectId: 349 });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('checklist_event_locked');
    const cleared = await bd(`/payment-requests/${id}`, 'PATCH', { projectId: null });
    expect(cleared.body.error).toBe('checklist_event_locked');
    expect((await bd(`/payment-requests/${id}`, 'PATCH', { amountSen: 636_000, purpose: 'Booth rental — 50% deposit' })).status).toBe(200);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ project_id: 348, amount_sen: 636_000, checklist_item_id: 5001 });
  });
});

describe('the row reads its requests back', () => {
  test('a requester sees their own, Finance sees all, each with its stage; no key, no read', async () => {
    const w = world();
    const { no } = await raisedFromRow(w);
    const mine = await as(w, BD)('/payment-requests/from-checklist?items=5001,5002');
    expect(mine.status).toBe(200);
    expect(mine.body.requests).toHaveLength(1);
    expect(mine.body.requests[0]).toMatchObject({ request_no: no, checklist_item_id: 5001, stage: 'SUBMITTED', officialDoc: null });
    expect((await as(w, OTHER_BD)('/payment-requests/from-checklist?items=5001')).body.requests).toEqual([]);
    const fin = await as(w, FINANCE)('/payment-requests/from-checklist?items=5001');
    expect(fin.body).toMatchObject({ finance: true });
    expect(fin.body.requests.map((r: Row) => r.request_no)).toEqual([no]);
    expect((await as(w, NOBODY)('/payment-requests/from-checklist?items=5001')).status).toBe(403);
  });

  test('no rows asked is an empty answer; a bad id is refused; more than 200 rows is refused', async () => {
    const w = world();
    const bd = as(w, BD);
    expect((await bd('/payment-requests/from-checklist')).body).toMatchObject({ requests: [] });
    expect((await bd('/payment-requests/from-checklist?items=5001,x')).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => i + 1).join(',');
    expect((await bd(`/payment-requests/from-checklist?items=${many}`)).body.error).toBe('too_many_items');
  });

  test('申请付余额 keeps the row: both instalments show on it', async () => {
    const w = world();
    const { bd, id } = await raisedFromRow(w, { ...FROM_ROW, billTotalSen: 2_544_000 });
    const bal = await bd(`/payment-requests/${id}/balance`, 'POST', { amountSen: 1_272_000 });
    expect(bal.status).toBe(201);
    const rows = (await bd('/payment-requests/from-checklist?items=5001')).body.requests as Row[];
    /* The first request is instalment 1 (the column's default — the fake keeps none). */
    expect(rows.map((r) => [Number(r.installment_no ?? 1), r.checklist_item_id])).toEqual([[1, 5001], [2, 5001]]);
  });
});

describe('Finance\'s remark on 欠正式单 — the proforma\'s follow-up', () => {
  const voucherFor = (id: string, extra: Row = {}) => ({
    payeeName: 'MALAYSIA INTERNATIONAL TRADE & EXHIBITION CENTRE', creditAccountCode: '310-0020', voucherDate: '2026-10-08', purpose: 'OTHER', paymentRequestId: id,
    lines: [{ debitAccountCode: '900-R032', description: 'Booth rental — ZANOTTI REX', amountSen: 1_272_000, projectId: 348 }],
    ...extra,
  });

  test('written with the tick on the voucher, read back on the row; changed while owed; kept when re-marked blank', async () => {
    const w = world();
    const { id } = await raisedFromRow(w);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', voucherFor(id, { officialDocOwed: true, officialDocNote: '  Proforma only — follow up the actual invoice from MITEC  ' }));
    expect(pv.status).toBe(201);
    expect(w.sb.tables.payment_vouchers[0]).toMatchObject({ official_doc: 'OWED', official_doc_note: 'Proforma only — follow up the actual invoice from MITEC' });
    const row = (await as(w, BD)('/payment-requests/from-checklist?items=5001')).body.requests[0] as Row;
    expect(row.officialDoc).toEqual({ state: 'OWED', note: 'Proforma only — follow up the actual invoice from MITEC' });

    /* The draft's edit changes the remark while it is still owed. */
    expect((await fin(`/payment-vouchers/${pv.body.id}`, 'PATCH', { officialDocOwed: true, officialDocNote: 'Ask MITEC for the tax invoice' })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers[0]!.official_doc_note).toBe('Ask MITEC for the tax invoice');
    /* Re-marked owed from the detail with nothing typed: the remark stays. */
    expect((await fin(`/official-docs/PV/${pv.body.id}`, 'POST', { state: 'OWED', note: '' })).status).toBe(200);
    expect(w.sb.tables.payment_vouchers[0]!.official_doc_note).toBe('Ask MITEC for the tax invoice');
    /* …and with a new line, it changes; a remark is a line, cut at 500. */
    expect((await fin(`/official-docs/PV/${pv.body.id}`, 'POST', { state: 'OWED', note: 'x'.repeat(600) })).status).toBe(200);
    expect(String(w.sb.tables.payment_vouchers[0]!.official_doc_note)).toHaveLength(500);
  });

  test('a voucher not owing anything ignores a stray remark', async () => {
    const w = world();
    const { id } = await raisedFromRow(w);
    const pv = await as(w, FINANCE)('/payment-vouchers', 'POST', voucherFor(id, { officialDocNote: 'ignored' }));
    expect(pv.status).toBe(201);
    expect(w.sb.tables.payment_vouchers[0]!.official_doc ?? null).toBeNull();
    expect(w.sb.tables.payment_vouchers[0]!.official_doc_note ?? null).toBeNull();
  });
});
