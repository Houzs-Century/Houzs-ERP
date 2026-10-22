/* An event per voucher / AP invoice line (owner 2026-09-29/30: 我的 payment 可能
   需要绑定 event — 5a, the header a default). Pinned through the real routes:
     • a PV line and an AP invoice line keep the event they were saved with, and
       posting carries it onto that line's OWN journal leg — never the bank or
       AP-control leg;
     • a reversal (PV cancel, AP invoice edit) carries the event onto the contra,
       so the pair nets to zero per event;
     • an event of another company, a malformed id, and an event on a supplier
       payment's AP line are refused before anything is written;
     • a posted voucher line's event changes in place — line and leg together,
       with a history row — and a leg that does not match the line is refused;
     • the picker and the cost report read the company's own events only.
   Same fake-PostgREST harness as tests/apInvoices.test.ts; public.projects is a
   small fake of env.DB (the scm client cannot reach public). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { paymentVouchers, buildLines } from '../src/scm/routes/payment-vouchers';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { accEvents } from '../src/scm/routes/acc-events';
import { buildEventCosts, type LegEntry, type TaggedLeg } from '../src/scm/lib/event-costs';
import { parseEventId, type EventRow } from '../src/scm/lib/event-tags';

const CO = 1;
const KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('900-0000', 'Operating Expense', 'EXPENSE'),
  acct('900-A001', 'RENTAL', 'EXPENSE', { parent_code: '900-0000' }),
  acct('900-A002', 'SERVICE FEE', 'EXPENSE', { parent_code: '900-0000' }),
  acct('200-D001', 'RENTAL DEPOSIT', 'ASSET'),
  acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
  acct('405-0000', 'OTHER CREDITORS', 'LIABILITY', { special_type: 'SCC' }),
  acct('310-0010', 'MAYBANK', 'ASSET', { acc_money: true }),
];

/* public.projects — one row per brand per fair, as production keeps them. */
const EVENTS: Row[] = [
  { id: 336, company_id: 1, code: '2026-09-HOMELOVE-PENANG-SPICE-AKEMI', name: 'Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE CONVENTION CENTRE', start_date: '2026-09-04', end_date: '2026-09-06', status: 'confirmed', archived_at: null, venue: 'SETIA SPICE CONVENTION CENTRE', brand: 'AKEMI', organizer: 'HOMELOVE', booth_no: '1129-1132' },
  { id: 348, company_id: 1, code: '2026-09-MLE-PENANG-PWCC-AKEMI', name: 'Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: null, venue: 'PENANG WATERFRONT CONVENTION CENTRE', brand: 'AKEMI', organizer: 'MLE', booth_no: 'F1' },
  { id: 339, company_id: 1, code: '2026-09-MYHOME-KL-STARLING-ERGOTEX', name: 'Kuala Lumpur [ERGOTEX] MYHOME @ THE STARLING MALL', start_date: '2026-09-04', end_date: '2026-09-06', status: 'cancelled', archived_at: null, venue: 'THE STARLING MALL', brand: 'ERGOTEX', organizer: 'MYHOME', booth_no: null },
  { id: 777, company_id: 1, code: '2026-09-DUP-ARCHIVED', name: 'A duplicate the office withdrew', start_date: '2026-09-10', end_date: '2026-09-12', status: 'confirmed', archived_at: '2026-08-01T00:00:00Z', venue: 'MID VALLEY', brand: 'AKEMI', organizer: 'REX', booth_no: null },
  { id: 900, company_id: 2, code: '2026-09-OTHER-COMPANY', name: 'Another company\'s fair', start_date: '2026-09-05', end_date: '2026-09-07', status: 'confirmed', archived_at: null, venue: 'SUNWAY PYRAMID', brand: 'X', organizer: 'Y', booth_no: null },
];

/* A fake of env.DB for the three shapes lib/event-tags.ts and the cost report
   send: ids, a search, and a date window — each with the company fragment. */
function fakeDb(rows: Row[]) {
  const pick = (r: Row) => ({
    id: r.id, code: r.code, name: r.name, startdate: r.start_date, enddate: r.end_date, status: r.status,
    archivedat: r.archived_at, venue: r.venue, brand: r.brand, organizer: r.organizer, boothno: r.booth_no,
  });
  const calls: string[] = [];
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql);
      return {
        bind(...vals: unknown[]) {
          return {
            async all<T>() {
              let hit = rows.slice();
              const co = /p\.company_id = (\d+)/.exec(sql);
              if (co) hit = hit.filter((r) => r.company_id === Number(co[1]));
              if (/1=0/.test(sql)) hit = [];
              if (/p\.id IN/.test(sql)) hit = hit.filter((r) => vals.map(Number).includes(r.id));
              else if (/LIKE \?/.test(sql)) {
                const needle = String(vals[0]).replace(/%/g, '');
                hit = hit.filter((r) => r.archived_at == null
                  && ['code', 'name', 'venue', 'organizer', 'brand', 'booth_no'].some((k) => String(r[k] ?? '').toLowerCase().includes(needle)));
              } else if (/p\.start_date <= \?\s+AND coalesce/.test(sql)) {
                const [hi, lo] = vals.map(String);
                hit = hit.filter((r) => r.archived_at == null && r.start_date <= hi && (r.end_date ?? r.start_date) >= lo);
              } else if (/p\.start_date >= \? AND p\.start_date <= \?/.test(sql)) {
                const [lo, hi] = vals.map(String);
                hit = hit.filter((r) => r.start_date >= lo && r.start_date <= hi);
              }
              return { results: hit.map(pick) as unknown as T[] };
            },
          };
        },
      };
    },
  };
}

function harness(perms: readonly string[] = KEYS) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    suppliers: [{ id: 'sup-h', company_id: CO, code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', status: 'ACTIVE' }],
    companies: [{ id: CO, code: 'HC' }],
    acc_account_roles: [],
    payment_vouchers: [],
    payment_voucher_lines: [],
    pv_allocations: [],
    ap_invoices: [],
    ap_invoice_lines: [],
    journal_entries: [],
    journal_entry_lines: [],
    entity_audit_log: [],
    acc_vendor_memory: [],
    purchase_invoices: [],
  });
  sb.rpcHandlers.entity_audit_writable = () => true;
  const db = fakeDb(EVENTS);
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/payment-vouchers', paymentVouchers);
  app.route('/ap-invoices', apInvoices);
  app.route('/acc-events', accEvents);
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: db });
  return { sb, db, call };
}

const RENTAL_PV = {
  payeeName: 'HOMELOVE EXPO SDN BHD', creditAccountCode: '310-0010', voucherDate: '2026-09-02', purpose: 'OTHER',
  lines: [
    { debitAccountCode: '900-A001', description: 'Booth rental 1129-1132', amountSen: 1_200_000, projectId: 336 },
    { debitAccountCode: '900-A002', description: 'Bank charge', amountSen: 1_000 },
  ],
};

/** Create the voucher, then stand it where Check + Approve leave it, and post. */
async function paidVoucher(h: ReturnType<typeof harness>, body: Row = RENTAL_PV) {
  const res = await h.call('/payment-vouchers', 'POST', body);
  expect(res.status).toBe(201);
  const pv = h.sb.tables.payment_vouchers.at(-1)!;
  Object.assign(pv, { pv_number: 'HC-PV-2609-001', checked_at: '2026-09-02T01:00:00Z', checked_by: 'Chew', approved_at: '2026-09-02T02:00:00Z', approved_by: 'Chew' });
  const posted = await h.call(`/payment-vouchers/${pv.id}/post`, 'POST');
  expect(posted.status).toBe(200);
  return pv;
}

const legsOf = (h: ReturnType<typeof harness>, sourceType: string) => {
  const je = h.sb.tables.journal_entries.find((j) => j.source_type === sourceType)!;
  return h.sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen), l.project_id ?? null]);
};

describe('a voucher line keeps its event and posts it onto its own leg', () => {
  test('the event rides the expense leg; the bank leg and the untagged line carry none', async () => {
    const h = harness();
    const pv = await paidVoucher(h);
    expect(h.sb.tables.payment_voucher_lines.filter((l) => l.pv_id === pv.id).map((l) => l.project_id)).toEqual([336, null]);
    expect(legsOf(h, 'PV')).toEqual([
      ['900-A001', 1_200_000, 0, 336],
      ['900-A002', 1_000, 0, null],
      ['310-0010', 0, 1_201_000, null],
    ]);
  });

  test('cancelling the voucher writes a contra that carries the event back', async () => {
    const h = harness();
    const pv = await paidVoucher(h);
    const res = await h.call(`/payment-vouchers/${pv.id}/cancel`, 'POST', { reason: 'keyed twice' });
    expect(res.status).toBe(200);
    expect(legsOf(h, 'PV_REVERSAL')).toEqual([
      ['900-A001', 0, 1_200_000, 336],
      ['900-A002', 0, 1_000, null],
      ['310-0010', 1_201_000, 0, null],
    ]);
  });

  test('another company\'s event, a malformed id and an event on a supplier payment are refused before anything is written', async () => {
    const h = harness();
    const foreign = await h.call('/payment-vouchers', 'POST', { ...RENTAL_PV, lines: [{ debitAccountCode: '900-A001', amountSen: 100, projectId: 900 }] });
    expect(foreign.status).toBe(400);
    expect((await foreign.json() as { error: string }).error).toBe('event_not_found');
    const bad = await h.call('/payment-vouchers', 'POST', { ...RENTAL_PV, lines: [{ debitAccountCode: '900-A001', amountSen: 100, projectId: 'fair' }] });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('line_event_invalid');
    const ap = await h.call('/payment-vouchers', 'POST', {
      ...RENTAL_PV, purpose: 'SUPPLIER_PAYMENT', supplierId: 'sup-h',
      lines: [{ debitAccountCode: '405-0000', amountSen: 100, projectId: 336 }],
    });
    expect(ap.status).toBe(400);
    expect((await ap.json() as { error: string }).error).toBe('event_not_on_this_voucher');
    expect(h.sb.tables.payment_vouchers).toHaveLength(0);
    expect(h.sb.tables.payment_voucher_lines).toHaveLength(0);
  });

  test('an edit keeps the event it is sent and refuses one it cannot find', async () => {
    const h = harness();
    const res = await h.call('/payment-vouchers', 'POST', RENTAL_PV);
    const pv = h.sb.tables.payment_vouchers.at(-1)!;
    expect(res.status).toBe(201);
    const moved = await h.call(`/payment-vouchers/${pv.id}`, 'PATCH', { lines: [{ debitAccountCode: '900-A001', amountSen: 1_200_000, projectId: 348 }] });
    expect(moved.status).toBe(200);
    expect(h.sb.tables.payment_voucher_lines.filter((l) => l.pv_id === pv.id).map((l) => l.project_id)).toEqual([348]);
    const gone = await h.call(`/payment-vouchers/${pv.id}`, 'PATCH', { lines: [{ debitAccountCode: '900-A001', amountSen: 1, projectId: 424242 }] });
    expect(gone.status).toBe(400);
    /* Refused BEFORE the old lines were deleted. */
    expect(h.sb.tables.payment_voucher_lines.filter((l) => l.pv_id === pv.id).map((l) => l.project_id)).toEqual([348]);
  });
});

describe('an AP invoice line keeps its event through post and edit', () => {
  const BILL = {
    supplierId: 'sup-h', supplierInvoiceRef: 'MLE-0925', invoiceDate: '2026-09-20', dueDate: '2026-09-30',
    lines: [
      { description: 'Booth F1 rental', debitAccountCode: '900-A001', amountSen: 800_000, projectId: 336 },
      { description: 'Admin fee', debitAccountCode: '900-A002', amountSen: 20_000 },
    ],
  };

  test('post: the event on the expense leg, none on the AP control; a re-post moves it and the contra takes the old one back', async () => {
    const h = harness();
    const created = await (await h.call('/ap-invoices', 'POST', BILL)).json() as { invoice: Row };
    expect(h.sb.tables.ap_invoice_lines.map((l) => l.project_id)).toEqual([336, null]);
    expect((await h.call(`/ap-invoices/${created.invoice.id}/post`, 'POST')).status).toBe(200);
    expect(legsOf(h, 'API')).toEqual([
      ['900-A001', 800_000, 0, 336],
      ['900-A002', 20_000, 0, null],
      ['405-0000', 0, 820_000, null],
    ]);

    const edited = await h.call(`/ap-invoices/${created.invoice.id}`, 'PATCH', { lines: [{ ...BILL.lines[0], projectId: 348 }, BILL.lines[1]] });
    expect(edited.status).toBe(200);
    const contra = h.sb.tables.journal_entries.find((j) => j.source_type === 'API_REVERSAL')!;
    const contraLegs = h.sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === contra.id).map((l) => [l.account_code, l.project_id ?? null]);
    expect(contraLegs).toContainEqual(['900-A001', 336]);
    const live = h.sb.tables.journal_entries.filter((j) => j.source_type === 'API' && !j.reversed);
    expect(live).toHaveLength(1);
    const liveLegs = h.sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === live[0]!.id).map((l) => [l.account_code, l.project_id ?? null]);
    expect(liveLegs).toContainEqual(['900-A001', 348]);
  });

  test('an event of another company is refused on create', async () => {
    const h = harness();
    const res = await h.call('/ap-invoices', 'POST', { ...BILL, lines: [{ ...BILL.lines[0], projectId: 900 }] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('event_not_found');
    expect(h.sb.tables.ap_invoices).toHaveLength(0);
  });
});

describe('changing the event on a posted voucher line', () => {
  test('moves the line and its leg together and writes the history', async () => {
    const h = harness();
    const pv = await paidVoucher(h);
    const line = h.sb.tables.payment_voucher_lines.find((l) => l.pv_id === pv.id && l.line_no === 1)!;
    const res = await h.call(`/acc-events/pv-lines/${line.id}/event`, 'POST', { projectId: 348 });
    expect(res.status).toBe(200);
    expect(line.project_id).toBe(348);
    expect(legsOf(h, 'PV')[0]).toEqual(['900-A001', 1_200_000, 0, 348]);
    const trail = h.sb.tables.entity_audit_log.filter((a) => a.entity_id === pv.id && a.note === 'event changed');
    expect(trail).toHaveLength(1);
    expect(JSON.stringify(trail[0]!.field_changes)).toContain('348');

    /* Clearing is a change too. */
    expect((await h.call(`/acc-events/pv-lines/${line.id}/event`, 'POST', { projectId: null })).status).toBe(200);
    expect(legsOf(h, 'PV')[0]).toEqual(['900-A001', 1_200_000, 0, null]);
  });

  test('a leg that does not match its line is refused and nothing moves', async () => {
    const h = harness();
    const pv = await paidVoucher(h);
    const line = h.sb.tables.payment_voucher_lines.find((l) => l.pv_id === pv.id && l.line_no === 1)!;
    const je = h.sb.tables.journal_entries.find((j) => j.source_type === 'PV')!;
    const leg = h.sb.tables.journal_entry_lines.find((l) => l.journal_entry_id === je.id && l.line_no === 1)!;
    leg.debit_sen = 999;
    const res = await h.call(`/acc-events/pv-lines/${line.id}/event`, 'POST', { projectId: 348 });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('entry_mismatch');
    expect(line.project_id).toBe(336);
    expect(leg.project_id).toBe(336);
  });

  test('a cancelled voucher, another company\'s event and a caller without the voucher keys are refused', async () => {
    const h = harness();
    const pv = await paidVoucher(h);
    const line = h.sb.tables.payment_voucher_lines.find((l) => l.pv_id === pv.id && l.line_no === 1)!;
    const foreign = await h.call(`/acc-events/pv-lines/${line.id}/event`, 'POST', { projectId: 900 });
    expect(foreign.status).toBe(400);
    const reader = harness(['scm.access']);
    Object.assign(reader.sb.tables, h.sb.tables);
    expect((await reader.call(`/acc-events/pv-lines/${line.id}/event`, 'POST', { projectId: 348 })).status).toBe(403);
    pv.status = 'CANCELLED';
    const cancelled = await h.call(`/acc-events/pv-lines/${line.id}/event`, 'POST', { projectId: 348 });
    expect(cancelled.status).toBe(409);
    expect(line.project_id).toBe(336);
  });
});

describe('the picker and the report read the company\'s own events', () => {
  test('options: the window around the date leaves out archived events and other companies; a search finds by code or booth; ids read labels', async () => {
    const h = harness();
    const around = await (await h.call('/acc-events/options?around=2026-09-10')).json() as { events: EventRow[] };
    expect(around.events.map((e) => e.id).sort()).toEqual([336, 339, 348]);
    expect(around.events.find((e) => e.id === 339)!.status).toBe('cancelled');
    const q = await (await h.call('/acc-events/options?q=pwcc')).json() as { events: EventRow[] };
    expect(q.events.map((e) => e.id)).toEqual([348]);
    const booth = await (await h.call('/acc-events/options?q=1129')).json() as { events: EventRow[] };
    expect(booth.events.map((e) => e.id)).toEqual([336]);
    const labels = await (await h.call('/acc-events/options?ids=336,900,777')).json() as { events: EventRow[] };
    /* 900 is another company's; the archived 777 still reads (a tag already on a line). */
    expect(labels.events.map((e) => e.id).sort()).toEqual([336, 777]);
    expect(h.db.calls.every((sql) => sql.includes('p.company_id = 1'))).toBe(true);
  });

  test('costs: a paid voucher and a posted AP invoice count; a cancelled voucher does not; an event with nothing booked still shows', async () => {
    const h = harness();
    await paidVoucher(h);
    const bill = await (await h.call('/ap-invoices', 'POST', {
      supplierId: 'sup-h', invoiceDate: '2026-09-20', lines: [{ debitAccountCode: '200-D001', amountSen: 300_000, projectId: 336, description: 'Deposit' }],
    })).json() as { invoice: Row };
    await h.call(`/ap-invoices/${bill.invoice.id}/post`, 'POST');
    const second = await h.call('/payment-vouchers', 'POST', { ...RENTAL_PV, lines: [{ debitAccountCode: '900-A001', amountSen: 50_000, projectId: 348 }] });
    expect(second.status).toBe(201);
    const pv2 = h.sb.tables.payment_vouchers.at(-1)!;
    Object.assign(pv2, { pv_number: 'HC-PV-2609-002', checked_at: 'x', approved_at: 'x' });
    expect((await h.call(`/payment-vouchers/${pv2.id}/post`, 'POST')).status).toBe(200);
    expect((await h.call(`/payment-vouchers/${pv2.id}/cancel`, 'POST', { reason: 'wrong fair' })).status).toBe(200);

    const res = await h.call('/acc-events/costs?from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    const b = await res.json() as { events: Array<{ event: EventRow; costSen: number; otherSen: number; lines: Row[] }>; totals: { costSen: number; otherSen: number } };
    const by = new Map(b.events.map((e) => [e.event.id, e]));
    expect(by.get(336)).toMatchObject({ costSen: 1_200_000, otherSen: 300_000 });
    expect(by.get(336)!.lines.map((l) => l.sourceType).sort()).toEqual(['API', 'PV']);
    /* 348's only voucher was cancelled: both sides of the pair drop out. */
    expect(by.get(348)).toMatchObject({ costSen: 0, otherSen: 0, lines: [] });
    /* Archived with nothing on it: withdrawn, not listed. Another company's: never read. */
    expect(by.has(777)).toBe(false);
    expect(by.has(900)).toBe(false);
    expect(b.totals).toEqual({ costSen: 1_200_000, otherSen: 300_000 });
  });
});

describe('the pure halves', () => {
  test('parseEventId: blank is no event, a positive integer is one, anything else is refused', () => {
    expect(parseEventId(undefined)).toBeNull();
    expect(parseEventId(null)).toBeNull();
    expect(parseEventId('')).toBeNull();
    expect(parseEventId(336)).toBe(336);
    expect(parseEventId('336')).toBe(336);
    for (const bad of [0, -1, 1.5, 'fair', {}, true]) expect(parseEventId(bad)).toBe('invalid');
  });

  test('buildLines carries the event and refuses a malformed one', () => {
    const ok = buildLines([{ debitAccountCode: '900-A001', amountSen: 100, projectId: 336 }, { debitAccountCode: '900-A002', amountSen: 5 }]);
    expect('rows' in ok && ok.rows.map((r) => r.project_id)).toEqual([336, null]);
    expect(buildLines([{ debitAccountCode: '900-A001', amountSen: 100, projectId: -3 }])).toEqual({ error: 'line_event_invalid' });
  });

  test('buildEventCosts: an archived event with money on it stays; the unposted and the paired drop out', () => {
    const ev = (id: number, archived = false): EventRow => ({ id, code: null, name: `E${id}`, startDate: '2026-09-01', endDate: null, status: 'confirmed', archived, venue: null, brand: null, organizer: null, boothNo: null });
    const leg = (je: string, account: string, dr: number, project: number): TaggedLeg => ({ journal_entry_id: je, line_no: 1, account_code: account, debit_sen: dr, credit_sen: 0, notes: null, project_id: project });
    const entry = (id: string, over: Partial<LegEntry> = {}): LegEntry => ({ id, je_no: id, entry_date: '2026-09-02', source_type: 'PV', source_doc_no: id, posted: true, reversed: false, reversed_by_je: null, ...over });
    const rows = buildEventCosts(
      [ev(1), ev(2, true), ev(3, true)],
      [leg('a', '900-A001', 100, 1), leg('b', '900-A001', 50, 1), leg('c', '900-A001', 70, 2), leg('d', '900-A001', 5, 1)],
      [entry('a'), entry('b', { posted: false }), entry('c'), entry('d', { reversed: true, reversed_by_je: 'e' })],
      [{ account_code: '900-A001', account_name: 'RENTAL', account_type: 'EXPENSE' }],
    );
    expect(rows.map((r) => [r.event.id, r.costSen])).toEqual([[1, 100], [2, 70]]);
  });
});
