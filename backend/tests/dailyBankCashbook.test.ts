/* Daily Bank's cash book (owner 2026-11-23: 先做一个daily bank的一开始直接，但不需要
   列实际差额。然后我每天会手动输入收到的金额; 付款就根据pv), pinned on the real
   handlers over fake PostgREST:
     • an account with a start reads the start + the receipts typed for it − the
       approved (POSTED) vouchers paying out of it, on their voucher date and from
       the start date on; a deleted receipt, a draft or cancelled voucher and
       another company's rows never count; an account without a start keeps the
       ledger;
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
import {
  calendarDay, cashbookGet, cashbookReceiptCreate, cashbookReceiptDelete, cashbookReceiptUpdate,
  cashbookStartDelete, cashbookStartPut,
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
      pv({ id: 'pv-1', pv_number: 'HPV-101', payee_name: 'UNICOM', credit_account_code: '310-0010', voucher_date: '2026-11-24', total_sen: 40_000, bank_charge_sen: 100 }),
      pv({ id: 'pv-2', pv_number: 'HPV-102', payee_name: 'TAN YONG HONG', notes: 'Truck rental', credit_account_code: '310-0010', voucher_date: TODAY, total_sen: 25_000 }),
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
  app.get('/accounting/daily-bank/cashbook', cashbookGet as never);
  app.put('/accounting/daily-bank/starts/:accountCode', cashbookStartPut as never);
  app.delete('/accounting/daily-bank/starts/:accountCode', cashbookStartDelete as never);
  app.post('/accounting/daily-bank/receipts', cashbookReceiptCreate as never);
  app.patch('/accounting/daily-bank/receipts/:id', cashbookReceiptUpdate as never);
  app.delete('/accounting/daily-bank/receipts/:id', cashbookReceiptDelete as never);
  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { app, t, send };
}

type Block = {
  accountCode: string; source: string; start: { date: string; balanceSen: number } | null;
  openingSen: number; inSen: number; outSen: number; closingSen: number; pendingSen: number; availableSen: number;
  receipts: Array<{ sourceType: string; note: string; amountSen: number; typedBy?: string | null }>;
  payouts: Array<{ docNo: string; party: string | null; note: string; amountSen: number }>;
};
const board = async (h: ReturnType<typeof harness>, date = TODAY) => {
  const res = await h.app.request(`/accounting/daily-bank?date=${date}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as { blocks: Block[]; totalClosingSen: number; availableSen: number; note: string };
};
const blockOf = (b: { blocks: Block[] }, code: string): Block => b.blocks.find((x) => x.accountCode === code)!;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${TODAY}T04:00:00Z`)); });
afterEach(() => { vi.useRealTimers(); });

describe('Daily Bank cash book — the board', () => {
  test('no start anywhere: every account keeps the ledger board', async () => {
    const h = harness();
    const b = await board(h);
    expect(blockOf(b, '310-0010')).toMatchObject({ source: 'ledger', start: null, closingSen: 52_943_781 + 1_000 });
    expect(blockOf(b, '310-0020')).toMatchObject({ source: 'ledger', closingSen: -81_164_858 });
  });

  test('set a start, type receipts, and the approved vouchers come off on their voucher date', async () => {
    const h = harness();
    expect((await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 77_408_649 })).status).toBe(200);
    const typed = await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: '2026-11-24', amountSen: 300_000, note: 'Hookka deposit' });
    expect(typed.status, await typed.clone().text()).toBe(201);
    expect((await h.send('POST', '/accounting/daily-bank/receipts', { accountCode: '310-0010', date: TODAY, amountSen: 120_050, note: '  Cash   sales showroom ' })).status).toBe(201);

    const b = await board(h);
    const may = blockOf(b, '310-0010');
    expect(may.source).toBe('cashbook');
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
    /* HLBB has no start: the ledger, untouched. */
    expect(blockOf(b, '310-0020')).toMatchObject({ source: 'ledger', closingSen: -81_164_858 });
    expect(b.totalClosingSen).toBe(may.closingSen - 81_164_858);
    expect(b.note).toMatch(/cash book/);

    /* The day before the start still reads the ledger, and says when the cash book starts. */
    const before = blockOf(await board(h, '2026-11-23'), '310-0010');
    expect(before).toMatchObject({ source: 'ledger', start: { date: '2026-11-24', balanceSen: 77_408_649 }, closingSen: 52_943_781 });
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

  test('removing the start puts the account back on the ledger', async () => {
    const h = harness();
    await h.send('PUT', '/accounting/daily-bank/starts/310-0010', { startDate: '2026-11-24', balanceSen: 1_000_000 });
    expect(blockOf(await board(h), '310-0010').source).toBe('cashbook');
    expect((await h.send('DELETE', '/accounting/daily-bank/starts/310-0010')).status).toBe(200);
    expect(blockOf(await board(h), '310-0010')).toMatchObject({ source: 'ledger', start: null, closingSen: 52_943_781 + 1_000 });
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

test('calendarDay accepts real days only', () => {
  expect(calendarDay('2026-11-25')).toBe('2026-11-25');
  expect(calendarDay('2026-02-29')).toBeNull();
  expect(calendarDay('2028-02-29')).toBe('2028-02-29');
  expect(calendarDay('25/11/2026')).toBeNull();
  expect(calendarDay(null)).toBeNull();
});
