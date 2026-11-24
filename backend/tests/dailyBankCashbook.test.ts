/* Daily Bank's cash book, a second board beside the original (owner 2026-11-23:
   先做一个daily bank的一开始直接，但不需要列实际差额。然后我每天会手动输入收到的金额;
   付款就根据pv; then 原版的daily bank还是要保留哦，我这算是新的daily bank), pinned on
   the real handlers over fake PostgREST:
     • the original board (GET /daily-bank) does not move, whatever is typed;
     • the cash-book board (GET /daily-bank/cashbook/board) carries each account
       with a start: the start + the receipts typed for it − the approved
       (POSTED) vouchers paying out of it, on the Malaysia day each was approved
       (owner 2026-11-24), those approved before the start (or on it, dated
       before it) inside the start; a deleted receipt, a draft or cancelled voucher and another
       company's rows never count; an account without a start is listed as not
       started;
     • a receipt is refused for an account with no start, before its start, on a
       day still to come, without a note or an amount; edit and delete keep the
       row and write the change, from -> to, on the audit trail;
     • only the Finance write key (scm.payment_voucher.post) changes anything, and
       another company's account or receipt is never touched.
   The arithmetic itself is pinned in backend/src/acc/daily-bank.test.ts. */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { dailyBankHandler } from '../src/scm/routes/accounting';
import { cashbookBoardHandler } from '../src/scm/routes/accounting-daily-bank';
import {
  calendarDay, cashbookGet, cashbookReceiptCreate, cashbookReceiptDelete, cashbookReceiptUpdate,
  cashbookReceiptsDayPut, cashbookStartDelete, cashbookStartPut,
} from '../src/scm/routes/accounting-daily-bank-cashbook';

const CO = 1;
const OTHER = 9;
const TODAY = '2026-11-25';
const WRITE = 'scm.payment_voucher.post';

const gl = (jeNo: string, date: string, code: string, dr: number, cr: number): Row => ({
  line_id: Math.random(), company_id: CO, je_no: jeNo, entry_date: date, source_type: 'SOPAY', source_doc_no: null,
  line_no: 1, account_code: code, account_name: code, account_type: 'ASSET', debit_sen: dr, credit_sen: cr,
  party_type: null, party_code: null, party_name: null, notes: null, posted: true, posted_at: `${date}T10:00:00Z`,
  reversed: false, reversed_by_je: null,
});

const pv = (over: Row): Row => ({
  company_id: CO, status: 'POSTED', currency: 'MYR', exchange_rate: 1, purpose: 'OTHER', notes: null, bank_charge_sen: 0,
  submitted_at: '2026-11-20T01:00:00Z', checked_at: '2026-11-20T02:00:00Z', approved_at: '2026-11-20T03:00:00Z', ...over,
});

function tables(): Record<string, Row[]> {
  return {
    accounts: [
      { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', acc_money: true, is_active: true },
      { company_id: CO, account_code: '310-0020', account_name: 'CASH AT BANK - HLBB', account_type: 'ASSET', acc_money: true, is_active: true },
      { company_id: CO, account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)', account_type: 'ASSET', acc_money: false, is_active: true },
      { company_id: CO, account_code: '900-X001', account_name: 'SUNDRY EXPENSE', account_type: 'EXPENSE', acc_money: false, is_active: true },
      /* Another company's bank of the same code. */
      { company_id: OTHER, account_code: '310-0030', account_name: 'CASH AT BANK - ALLIANCE (OTHER CO)', account_type: 'ASSET', acc_money: true, is_active: true },
    ],
    v_gl_entries: [
      gl('JE-1', '2026-09-30', '310-0010', 52_943_781, 0),   // the ledger's Maybank: not what the bank holds
      gl('JE-2', '2026-11-24', '310-0010', 1_000, 0),       // a ledger line after the start: not the cash book's
      gl('JE-3', '2026-11-01', '310-0020', 0, 81_164_858),  // HLBB: no start, stays on the ledger
      gl('JE-4', '2026-11-20', '326-0000', 336_500, 0),
    ],
    acc_acquirers: [],
    acc_account_roles: [],
    payment_vouchers: [
      pv({ id: 'pv-1', pv_number: 'HPV-101', payee_name: 'UNICOM', credit_account_code: '310-0010', voucher_date: '2026-11-24', total_sen: 40_000, bank_charge_sen: 100, approved_at: '2026-11-24T03:00:00Z' }),
      pv({ id: 'pv-2', pv_number: 'HPV-102', payee_name: 'TAN YONG HONG', notes: 'Truck rental', credit_account_code: '310-0010', voucher_date: TODAY, total_sen: 25_000, approved_at: `${TODAY}T02:00:00Z` }),
      /* Before the start: already inside the starting balance. */
      pv({ id: 'pv-3', pv_number: 'HPV-090', payee_name: 'OLD', credit_account_code: '310-0010', voucher_date: '2026-11-20', total_sen: 99_999 }),
      /* Checked, not approved: pending, never paid as well. */
      pv({ id: 'pv-4', pv_number: 'HPV-103', payee_name: 'UMOBILE', credit_account_code: '310-0010', voucher_date: TODAY, total_sen: 30_000, status: 'DRAFT', approved_at: null }),
      /* Approved then cancelled: neither paid nor pending. */
      pv({ id: 'pv-5', pv_number: 'HPV-104', payee_name: 'CANCELLED', credit_account_code: '310-0010', voucher_date: TODAY, total_sen: 77_777, status: 'CANCELLED' }),
      /* Another company's voucher on the same account code. */
      pv({ id: 'pv-6', pv_number: 'ZZ-PV-1', payee_name: 'ELSEWHERE', credit_account_code: '310-0010', voucher_date: TODAY, total_sen: 12_345, company_id: OTHER }),
    ],
    acc_daily_bank_starts: [
      { id: 's-other', company_id: OTHER, account_code: '310-0010', start_date: '2026-11-01', balance_sen: 1, note: null, set_by: 'X', updated_at: '2026-11-01T00:00:00Z' },
    ],
    acc_daily_bank_receipts: [
      /* Another company's receipt on the same account code and day. */
      { id: 'r-other', company_id: OTHER, account_code: '310-0010', receipt_date: TODAY, amount_sen: 5_555, note: 'not ours', created_by: 'X', created_at: '2026-11-25T01:00:00Z', updated_by: null, updated_at: '2026-11-25T01:00:00Z', deleted_by: null, deleted_at: null },
    ],
    entity_audit_log: [],
    staff: [],
  };
}

function harness(perms: string[] = [WRITE]) {
  const t = tables();
  const sb = fakeSb(t);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { id: 7, name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/daily-bank', dailyBankHandler as never);
  app.get('/accounting/daily-bank/cashbook/board', cashbookBoardHandler as never);
  app.get('/accounting/daily-bank/cashbook', cashbookGet as never);
  app.put('/accounting/daily-bank/starts/:accountCode', cashbookStartPut as never);
  app.delete('/accounting/daily-bank/starts/:accountCode', cashbookStartDelete as never);
  app.post('/accounting/daily-bank/receipts', cashbookReceiptCreate as never);
  app.patch('/accounting/daily-bank/receipts/:id', cashbookReceiptUpdate as never);
  app.delete('/accounting/daily-bank/receipts/:id', cashbookReceiptDelete as never);
  app.put('/accounting/daily-bank/receipts/day', cashbookReceiptsDayPut as never);
  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { app, t, send };
}

type Block = {
  accountCode: string; start: { date: string; balanceSen: number } | null;
  openingSen: number; inSen: number; outSen: number; closingSen: number; pendingSen: number; availableSen: number;
  receipts: Array<{ sourceType: string; note: string; amountSen: number; typedBy?: string | null }>;
  payouts: Array<{ docNo: string; party: string | null; note: string; amountSen: number }>;
};
type Board = {
  book: string; blocks: Block[]; totalClosingSen: number; pendingApprovalSen: number; availableSen: number; note: string;
  transit: Array<{ acquirerCode: string; balanceSen: number }>; unassignedTransit: Array<{ acquirerCode: string }>;
  notStarted: Array<{ accountCode: string; startDate: string | null }>;
};
const fetchBoard = async (h: ReturnType<typeof harness>, path: string, date: string) => {
  const res = await h.app.request(`${path}?date=${date}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Board;
};
/** The cash-book board — the owner's new Daily Bank. */
const board = (h: ReturnType<typeof harness>, date = TODAY) => fetchBoard(h, '/accounting/daily-bank/cashbook/board', date);
/** The original board, from the ledger. */
const original = (h: ReturnType<typeof harness>, date = TODAY) => fetchBoard(h, '/accounting/daily-bank', date);
const blockOf = (b: { blocks: Block[] }, code: string): Block => b.blocks.find((x) => x.accountCode === code)!;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${TODAY}T04:00:00Z`)); });
afterEach(() => { vi.useRealTimers(); });

describe('Daily Bank cash book — the board', () => {
  test('no start anywhere: the cash book carries nothing yet; the original board is the ledger', async () => {
    const h = harness();
    const b = await board(h);
    expect(b).toMatchObject({ book: 'cashbook', blocks: [], totalClosingSen: 0, pendingApprovalSen: 0, availableSen: 0 });
    expect(b.notStarted.map((x) => [x.accountCode, x.startDate])).toEqual([['310-0010', null], ['310-0020', null]]);
    const o = await original(h);
    expect(o.book).toBe('ledger');
    expect(blockOf(o, '310-0010')).toMatchObject({ start: null, closingSen: 52_943_781 + 1_000 });
    expect(blockOf(o, '310-0020')).toMatchObject({ closingSen: -81_164_858 });
  });

  test('set a start, type receipts, and the approved vouchers come off on the day they were approved — on the new board only', async () => {
    const h = harness();
    const before = await original(h);
    expect((await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 77_408_649 })).status).toBe(200);
    const typed = await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: '2026-11-24', amountSen: 300_000, note: 'Hookka deposit' });
    expect(typed.status, await typed.clone().text()).toBe(201);
    expect((await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 120_050, note: '  Cash   sales showroom ' })).status).toBe(201);

    const b = await board(h);
    expect(b.blocks.map((x) => x.accountCode)).toEqual(['310-0010']);
    const may = blockOf(b, '310-0010');
    expect(may.start).toEqual({ date: '2026-11-24', balanceSen: 77_408_649 });
    /* B/F: the start, yesterday's typed receipt, yesterday's approved voucher and its bank charge. */
    expect(may.openingSen).toBe(77_408_649 + 300_000 - 40_100);
    expect(may.receipts.map((m) => [m.sourceType, m.note, m.amountSen, m.typedBy])).toEqual([['TYPED', 'Cash sales showroom', 120_050, 'Chew']]);
    /* Today's approved voucher; the draft, the cancelled and the other company's are not paid. */
    expect(may.payouts.map((m) => [m.docNo, m.party, m.amountSen])).toEqual([['HPV-102', 'TAN YONG HONG', 25_000]]);
    expect(may.closingSen).toBe(77_408_649 + 300_000 - 40_100 + 120_050 - 25_000);
    /* The checked voucher still waits as pending, as before. */
    expect(may.pendingSen).toBe(30_000);
    expect(may.availableSen).toBe(may.closingSen - 30_000);
    /* HLBB has no start: not on the cash book, not in its totals. */
    expect(b.notStarted.map((x) => x.accountCode)).toEqual(['310-0020']);
    expect(b.totalClosingSen).toBe(may.closingSen);
    expect(b.note).toMatch(/^The cash book/);
    /* Card money not yet in a bank: listed once, on its way; under no bank, not even "not tied to a bank". */
    expect(b.transit.map((t) => [t.acquirerCode, t.balanceSen])).toEqual([['Untagged bank', 336_500]]);
    expect(b.unassignedTransit).toEqual([]);

    /* The original board has not moved by a sen, its card money where it always was. */
    expect(await original(h)).toEqual(before);
    expect(before.unassignedTransit.map((t) => t.acquirerCode)).toEqual(['Untagged bank']);

    /* The day before the start: not on the cash book yet, and says when it starts. */
    const earlier = await board(h, '2026-11-23');
    expect(earlier.blocks).toEqual([]);
    expect(earlier.notStarted.map((x) => [x.accountCode, x.startDate])).toEqual([['310-0010', '2026-11-24'], ['310-0020', null]]);
  });

  /* Owner 2026-11-24, approving old vouchers that are being paid now: 其实就是我approved了
     就当做一件过了要扣，不可以吗？ — then 照这样改. */
  test('an approved voucher comes off on the Malaysia day it was approved, whatever its own date; one already inside the start stays out', async () => {
    const h = harness();
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_000_000 });
    h.t.payment_vouchers!.push(
      /* Dated long before the start, approved today: comes off today, saying its date. */
      pv({ id: 'pv-old', pv_number: 'HPV-050', payee_name: 'OLD BILL', credit_account_code: '310-0010', voucher_date: '2026-09-29', total_sen: 70_000, bank_charge_sen: 100, approved_at: `${TODAY}T01:00:00Z` }),
      /* Dated on the start day, approved today: moves from the 24th to today. */
      pv({ id: 'pv-moved', pv_number: 'HPV-105', payee_name: 'MOVED', credit_account_code: '310-0010', voucher_date: '2026-11-24', total_sen: 11_000, approved_at: '2026-11-24T23:30:00Z' }),
      /* Approved on the start day but dated before it: inside the start. */
      pv({ id: 'pv-in', pv_number: 'HPV-060', payee_name: 'IN THE START', credit_account_code: '310-0010', voucher_date: '2026-11-02', total_sen: 888, approved_at: '2026-11-24T02:00:00Z' }),
      /* Posted without an approval stamp: the day it was posted. */
      pv({ id: 'pv-unstamped', pv_number: 'HPV-106', payee_name: 'NO STAMP', credit_account_code: '310-0010', voucher_date: '2026-11-03', total_sen: 4_000, approved_at: null, posted_at: `${TODAY}T05:00:00Z` }),
    );
    const may = blockOf(await board(h), '310-0010');
    /* B/F: the start less HPV-101 (approved on the start day, dated on it, with its charge). */
    expect(may.openingSen).toBe(1_000_000 - 40_100);
    expect(may.payouts.map((m) => [m.docNo, m.party, m.note, m.amountSen])).toEqual([
      ['HPV-050', 'OLD BILL', 'Other · voucher dated 2026/09/29 · incl. bank charge RM 1.00', 70_100],
      ['HPV-102', 'TAN YONG HONG', 'Truck rental', 25_000],
      ['HPV-105', 'MOVED', 'Other · voucher dated 2026/11/24', 11_000],
      ['HPV-106', 'NO STAMP', 'Other · voucher dated 2026/11/03', 4_000],
    ]);
    expect(may.closingSen).toBe(1_000_000 - 40_100 - 70_100 - 25_000 - 11_000 - 4_000);
    /* The start day itself: HPV-101 then; HPV-105 not yet, the old ones never. */
    const startDay = blockOf(await board(h, '2026-11-24'), '310-0010');
    expect(startDay.payouts.map((m) => m.docNo)).toEqual(['HPV-101']);
    expect(startDay.closingSen).toBe(1_000_000 - 40_100);
  });

  test('a deleted receipt stops counting; an edited one counts as edited', async () => {
    const h = harness();
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_000_000 });
    const a = await (await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 50_000, note: 'A' })).json() as { id: string };
    const b2 = await (await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 70_000, note: 'B' })).json() as { id: string };
    expect((await h.send('PATCH', `/accounting/daily-bank/receipts/${a.id}`, { amountSen: 55_000 })).status).toBe(200);
    expect((await h.send('DELETE', `/accounting/daily-bank/receipts/${b2.id}`)).status).toBe(200);
    const may = blockOf(await board(h), '310-0010');
    expect(may.receipts.map((m) => [m.note, m.amountSen])).toEqual([['A', 55_000]]);
    /* The deleted row stays, stamped. */
    const row = h.t.acc_daily_bank_receipts!.find((r) => r.id === b2.id)!;
    expect(row).toMatchObject({ deleted_by: 'Chew' });
    expect(row.deleted_at).toBeTruthy();
  });

  test('removing the start takes the account off the cash book', async () => {
    const h = harness();
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_000_000 });
    expect((await board(h)).blocks.map((x) => x.accountCode)).toEqual(['310-0010']);
    expect((await h.send('DELETE', '/accounting/daily-bank/starts/310-0010')).status).toBe(200);
    const after = await board(h);
    expect(after.blocks).toEqual([]);
    expect(after.notStarted.map((x) => x.accountCode)).toEqual(['310-0010', '310-0020']);
  });
});

describe('Daily Bank cash book — the rules for a receipt', () => {
  test('refused: no start, before the start, a day to come, no note, no amount, not a money account', async () => {
    const h = harness();
    const post = (body: Row) => h.send('POST', '/accounting/daily-bank/receipts', body);
    const ok = { accountCode: '310-0010', date: TODAY, amountSen: 100, note: 'x' };
    expect((await (await post(ok)).json() as { error: string }).error).toBe('no_start');
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 0 });
    const cases: Array<[Row, number, string]> = [
      [{ ...ok, date: '2026-11-23' }, 409, 'before_start'],
      [{ ...ok, date: '2026-11-26' }, 400, 'future_date'],
      [{ ...ok, date: '2026-02-30' }, 400, 'bad_date'],
      [{ ...ok, note: '   ' }, 400, 'note_required'],
      [{ ...ok, amountSen: 0 }, 400, 'bad_amount'],
      [{ ...ok, amountSen: 12.5 }, 400, 'bad_amount'],
      [{ ...ok, accountCode: '900-X001' }, 400, 'not_money_account'],
      [{ ...ok, accountCode: '310-0030' }, 400, 'not_money_account'],   // another company's bank
    ];
    for (const [body, status, error] of cases) {
      const res = await post(body);
      expect([res.status, (await res.json() as { error: string }).error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect(h.t.acc_daily_bank_receipts!.filter((r) => r.company_id === CO)).toEqual([]);
  });

  test('a start is a real day and whole sen, and may be below zero (overdrawn)', async () => {
    const h = harness();
    const put = (body: Row) => h.send('PUT', '/accounting/daily-bank/starts/310-0010', body);
    expect((await put({ startDate: '24/11/2026', balanceSen: 1 })).status).toBe(400);
    expect((await put({ startDate: '2026-11-24', balanceSen: 1.5 })).status).toBe(400);
    expect((await put({ startDate: '2026-11-24', balanceSen: -250_000 })).status).toBe(200);
    expect((await h.send('PUT', '/accounting/daily-bank/starts/326-0000', { startDate: '2026-11-24', balanceSen: 1 })).status).toBe(400);
    expect(h.t.acc_daily_bank_starts!.filter((s) => s.company_id === CO).map((s) => [s.account_code, s.balance_sen])).toEqual([['310-0010', -250_000]]);
  });

  test('another company\'s receipt cannot be read, edited or deleted from here', async () => {
    const h = harness();
    expect((await h.send('PATCH', '/accounting/daily-bank/receipts/r-other', { amountSen: 1 })).status).toBe(404);
    expect((await h.send('DELETE', '/accounting/daily-bank/receipts/r-other')).status).toBe(404);
    expect(h.t.acc_daily_bank_receipts!.find((r) => r.id === 'r-other')).toMatchObject({ amount_sen: 5_555, deleted_at: null });
    const day = await (await h.app.request(`/accounting/daily-bank/cashbook?date=${TODAY}`)).json() as { receipts: unknown[]; accounts: Array<{ accountCode: string; start: unknown }> };
    expect(day.receipts).toEqual([]);
    /* Its start on the same code is not this company's start. */
    expect(day.accounts.find((a) => a.accountCode === '310-0010')!.start).toBeNull();
  });

  test('without the Finance write key nothing changes; the day can still be read', async () => {
    const h = harness([]);
    expect((await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1 })).status).toBe(403);
    expect((await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 1, note: 'x' })).status).toBe(403);
    expect((await h.send('DELETE', '/accounting/daily-bank/starts/310-0010')).status).toBe(403);
    const res = await h.app.request(`/accounting/daily-bank/cashbook?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect((await res.json() as { canWrite: boolean }).canWrite).toBe(false);
    expect(h.t.acc_daily_bank_starts!.filter((s) => s.company_id === CO)).toEqual([]);
  });
});

describe('Daily Bank cash book — the audit trail and the day view', () => {
  test('every change is on the trail with who and from -> to; the day lists live and deleted receipts', async () => {
    const h = harness();
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_000_000 });
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_200_000, note: 'statement 23/11' });
    const r = await (await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 50_000, note: 'Hookka' })).json() as { id: string };
    await h.send('PATCH', `/accounting/daily-bank/receipts/${r.id}`, { amountSen: 55_000, note: 'Hookka deposit' });
    const r2 = await (await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 9_000, note: 'typo' })).json() as { id: string };
    await h.send('DELETE', `/accounting/daily-bank/receipts/${r2.id}`);

    const trail = h.t.entity_audit_log!.map((a) => [a.entity_type, a.entity_id, a.action, a.company_id, a.actor_name_snapshot]);
    expect(trail).toEqual([
      ['DAILY_BANK_START', '310-0010', 'CREATE', CO, 'Chew'],
      ['DAILY_BANK_START', '310-0010', 'UPDATE', CO, 'Chew'],
      ['DAILY_BANK_RECEIPT', r.id, 'CREATE', CO, 'Chew'],
      ['DAILY_BANK_RECEIPT', r.id, 'UPDATE', CO, 'Chew'],
      ['DAILY_BANK_RECEIPT', r2.id, 'CREATE', CO, 'Chew'],
      ['DAILY_BANK_RECEIPT', r2.id, 'DELETE', CO, 'Chew'],
    ]);
    expect(h.t.entity_audit_log![1]!.field_changes).toEqual([
      { field: 'balance_sen', from: 1_000_000, to: 1_200_000 },
      { field: 'note', from: null, to: 'statement 23/11' },
    ]);
    expect(h.t.entity_audit_log![3]!.field_changes).toEqual([
      { field: 'amount_sen', from: 50_000, to: 55_000 },
      { field: 'note', from: 'Hookka', to: 'Hookka deposit' },
    ]);
    expect(h.t.entity_audit_log![5]!.field_changes).toContainEqual({ field: 'amount_sen', from: 9_000, to: null });

    const day = await (await h.app.request(`/accounting/daily-bank/cashbook?date=${TODAY}`)).json() as {
      canWrite: boolean;
      accounts: Array<{ accountCode: string; start: { date: string; balanceSen: number; note: string | null; setBy: string | null } | null }>;
      receipts: Array<{ id: string; amountSen: number; note: string; createdBy: string; updatedBy: string | null; counted: boolean }>;
      deleted: Array<{ id: string; deletedBy: string }>;
    };
    expect(day.canWrite).toBe(true);
    expect(day.accounts.map((a) => [a.accountCode, a.start?.balanceSen ?? null, a.start?.setBy ?? null])).toEqual([
      ['310-0010', 1_200_000, 'Chew'], ['310-0020', null, null],
    ]);
    expect(day.receipts.map((x) => [x.id, x.amountSen, x.note, x.createdBy, x.updatedBy, x.counted])).toEqual([[r.id, 55_000, 'Hookka deposit', 'Chew', 'Chew', true]]);
    expect(day.deleted.map((x) => [x.id, x.deletedBy])).toEqual([[r2.id, 'Chew']]);
    /* A deleted receipt cannot be edited back to life. */
    expect((await h.send('PATCH', `/accounting/daily-bank/receipts/${r2.id}`, { amountSen: 1 })).status).toBe(409);
  });
});

/* The day's income as a grid (owner 2026-11-23: 不能做成这样的表格给我keyin income？):
   bank by method, one total per cell; 0 clears a cell, a cell not sent stays. */
describe('Daily Bank cash book — the day as a grid', () => {
  const withTerminals = (h: ReturnType<typeof harness>) => {
    h.t.acc_acquirers!.push(
      { company_id: CO, code: 'HLB', transit_account_code: '326-0000', bank_account_code: '310-0020', is_active: true },
      { company_id: CO, code: 'GHL', transit_account_code: '326-0000', bank_account_code: '310-0020', is_active: true },
      { company_id: CO, code: 'AEON', transit_account_code: '326-0000', bank_account_code: null, is_active: false },
      { company_id: OTHER, code: 'CIMB', transit_account_code: '326-0000', bank_account_code: null, is_active: true },
    );
    return h;
  };
  const save = (h: ReturnType<typeof harness>, cells: Row[], date = TODAY) => h.send('PUT', '/accounting/daily-bank/receipts/day', { date, cells });

  test('its columns: Online, Cash, Cheque, then the company\'s active card terminals', async () => {
    const h = withTerminals(harness());
    const res = await h.app.request(`/accounting/daily-bank/cashbook?date=${TODAY}`);
    const body = await res.json() as { methods: Array<{ key: string; label: string }> };
    expect(body.methods).toEqual([
      { key: 'online', label: 'Online' }, { key: 'cash', label: 'Cash' }, { key: 'cheque', label: 'Cheque' },
      { key: 'card:GHL', label: 'GHL' }, { key: 'card:HLB', label: 'HLB' },
    ]);
  });

  test('typed, changed and cleared cell by cell; the board counts what is there; every change on the trail', async () => {
    const h = withTerminals(harness());
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_000_000 });
    const first = await save(h, [
      { accountCode: '310-0010', method: 'online', amountSen: 512_300 },
      { accountCode: '310-0010', method: 'card:GHL', amountSen: 903_150 },
      { accountCode: '310-0010', method: 'cash', amountSen: 0 },
    ]);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ ok: true, created: 2, updated: 0, deleted: 0 });
    const may = blockOf(await board(h), '310-0010');
    expect(may.receipts.map((m) => [m.note, m.amountSen, m.typedBy])).toEqual([['Online', 512_300, 'Chew'], ['GHL card', 903_150, 'Chew']]);
    expect(may.inSen).toBe(512_300 + 903_150);

    /* Sending the same again changes nothing. */
    expect(await (await save(h, [{ accountCode: '310-0010', method: 'online', amountSen: 512_300 }])).json()).toEqual({ ok: true, created: 0, updated: 0, deleted: 0 });

    const second = await save(h, [
      { accountCode: '310-0010', method: 'online', amountSen: 700_000 },
      { accountCode: '310-0010', method: 'card:GHL', amountSen: 0 },
    ]);
    expect(await second.json()).toEqual({ ok: true, created: 0, updated: 1, deleted: 1 });
    const view = await (await h.app.request(`/accounting/daily-bank/cashbook?date=${TODAY}`)).json() as {
      receipts: Array<{ method: string | null; amountSen: number; note: string; updatedBy: string | null }>;
      deleted: Array<{ method: string | null; amountSen: number; deletedBy: string | null }>;
    };
    expect(view.receipts.map((r) => [r.method, r.amountSen, r.note, r.updatedBy])).toEqual([['online', 700_000, 'Online', 'Chew']]);
    expect(view.deleted.map((r) => [r.method, r.amountSen, r.deletedBy])).toEqual([['card:GHL', 903_150, 'Chew']]);
    const trail = h.t.entity_audit_log!.filter((a) => a.entity_type === 'DAILY_BANK_RECEIPT').map((a) => a.action);
    expect(trail).toEqual(['CREATE', 'CREATE', 'UPDATE', 'DELETE']);
    expect(h.t.entity_audit_log!.find((a) => a.action === 'UPDATE')!.field_changes).toContainEqual({ field: 'amount_sen', from: 512_300, to: 700_000 });
  });

  test('a terminal turned off later keeps its column on a day that holds money from it, to change or clear', async () => {
    const h = withTerminals(harness());
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 0 });
    expect((await save(h, [{ accountCode: '310-0010', method: 'card:GHL', amountSen: 903_150 }])).status).toBe(200);
    h.t.acc_acquirers!.find((a) => a.company_id === CO && a.code === 'GHL')!.is_active = false;
    const columns = async (date: string) =>
      ((await (await h.app.request(`/accounting/daily-bank/cashbook?date=${date}`)).json()) as { methods: Array<{ key: string }> }).methods.map((m) => m.key);

    expect(await columns(TODAY)).toEqual(['online', 'cash', 'cheque', 'card:HLB', 'card:GHL']);
    expect(await columns('2026-11-24')).toEqual(['online', 'cash', 'cheque', 'card:HLB']);
    expect(await (await save(h, [{ accountCode: '310-0010', method: 'card:GHL', amountSen: 100_000 }])).json()).toEqual({ ok: true, created: 0, updated: 1, deleted: 0 });
    const elsewhere = await save(h, [{ accountCode: '310-0010', method: 'card:GHL', amountSen: 1 }], '2026-11-24');
    expect([elsewhere.status, (await elsewhere.json() as { error: string }).error]).toEqual([400, 'bad_method']);
    expect(await (await save(h, [{ accountCode: '310-0010', method: 'card:GHL', amountSen: 0 }])).json()).toEqual({ ok: true, created: 0, updated: 0, deleted: 1 });
    expect(await columns(TODAY)).toEqual(['online', 'cash', 'cheque', 'card:HLB']);
  });

  test('refused: a method not offered, a bank not on the cash book that day, a day to come, a negative or doubled cell, no write key', async () => {
    const h = withTerminals(harness());
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 0 });
    const cases: Array<[Row[], string, number, string]> = [
      [[{ accountCode: '310-0010', method: 'card:AEON', amountSen: 1 }], TODAY, 400, 'bad_method'],   // inactive terminal
      [[{ accountCode: '310-0010', method: 'card:CIMB', amountSen: 1 }], TODAY, 400, 'bad_method'],   // another company's
      [[{ accountCode: '310-0020', method: 'online', amountSen: 1 }], TODAY, 409, 'not_open'],        // no start
      [[{ accountCode: '310-0010', method: 'online', amountSen: 1 }], '2026-11-23', 409, 'not_open'], // before its start
      [[{ accountCode: '310-0010', method: 'online', amountSen: 1 }], '2026-11-26', 400, 'future_date'],
      [[{ accountCode: '310-0010', method: 'online', amountSen: -1 }], TODAY, 400, 'bad_amount'],
      [[{ accountCode: '310-0010', method: 'online', amountSen: 1 }, { accountCode: '310-0010', method: 'online', amountSen: 2 }], TODAY, 400, 'duplicate_cell'],
    ];
    for (const [cells, date, status, error] of cases) {
      const res = await save(h, cells, date);
      expect([res.status, (await res.json() as { error: string }).error], JSON.stringify(cells)).toEqual([status, error]);
    }
    expect(h.t.acc_daily_bank_receipts!.filter((r) => r.company_id === CO)).toEqual([]);
    const viewer = withTerminals(harness([]));
    expect((await save(viewer, [{ accountCode: '310-0010', method: 'online', amountSen: 1 }])).status).toBe(403);
  });
});

test('calendarDay accepts real days only', () => {
  expect(calendarDay('2026-11-25')).toBe('2026-11-25');
  expect(calendarDay('2026-02-29')).toBeNull();
  expect(calendarDay('2028-02-29')).toBe('2028-02-29');
  expect(calendarDay('25/11/2026')).toBeNull();
  expect(calendarDay(null)).toBeNull();
});
