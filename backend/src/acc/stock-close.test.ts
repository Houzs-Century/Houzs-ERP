// Month-end stock close (GL redesign item 4). What is pinned:
//   • the replay counts on the BUSINESS date — a GRN keyed in September for
//     goods received Aug 30 belongs to August, and a row with no
//     movement_date (the migration window) still counts by its keyed time;
//   • the close posts the PAIR: closing at the month's last day, the opening
//     reversal at the 1st of the next — both active, so the month-end TB
//     carries the stock and the months stay independent;
//   • a value that MOVED (the late GRN) reverses the old pair and re-posts —
//     never edits, never doubles; an unchanged value writes only a log row;
//   • zero and negative values refuse to pretend: zero posts nothing,
//     negative fails loudly;
//   • every outcome lands in acc_stock_close_runs;
//   • 2026-09-21: the value splits into three closing stocks by the warehouse's
//     bucket (its override, else its type), each pair on the bucket's own
//     child accounts, the opening on 600-000x; consignment goods never count;
//     a month on the old one-account shape re-posts the first time it is seen.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { closeStockMonth, monthEdges, stockValueAsOf, stockValueByBucketAsOf, sweepMonths } from './stock-close';
import { postJournal } from './engine';

const CO = 2;

const acct = (code: string, parent: string | null): Row => ({
  account_code: code, account_name: code, account_type: code.startsWith('330') ? 'ASSET' : 'EXPENSE',
  parent_code: parent, is_active: true, company_id: CO,
});
/* The three parents and their bucket children (owner 2026-09-21): the close posts to the children only. */
const CHART: Row[] = ['330-0000', '600-0000', '620-0000'].flatMap((p) => [acct(p, null), ...['0001', '0002', '0003'].map((s) => acct(`${p.slice(0, 4)}${s}`, p))]);

/* The warehouses a movement stands in: the bucket is the type's default, or the row's override. */
const WAREHOUSES: Row[] = [
  { id: 'wh-main', company_id: CO, type: 'warehouse', stock_bucket: null },
  { id: 'wh-show', company_id: CO, type: 'showroom', stock_bucket: null },
  { id: 'wh-svc', company_id: CO, type: 'service', stock_bucket: null },
  { id: 'wh-cc', company_id: CO, type: 'display', stock_bucket: 'customer' },
];

const mv = (over: Row): Row => ({
  company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 100_000,
  movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', ...over,
});

const world = (over: Record<string, Row[]> = {}) => fakeSb({
  accounts: CHART.map((r) => ({ ...r })),
  acc_account_roles: [],
  companies: [{ id: CO, code: '2990' }],
  warehouses: WAREHOUSES.map((r) => ({ ...r })),
  inventory_movements: [],
  journal_entries: [],
  journal_entry_lines: [],
  acc_stock_close_runs: [],
  ...over,
});

describe('the pure helpers', () => {
  test('monthEdges spans month ends and December', () => {
    expect(monthEdges('2026-08')).toEqual({ ok: true, lastDay: '2026-08-31', nextFirst: '2026-09-01' });
    expect(monthEdges('2026-12')).toEqual({ ok: true, lastDay: '2026-12-31', nextFirst: '2027-01-01' });
    expect(monthEdges('2026-13').ok).toBe(false);
  });

  test('sweepMonths names the two most recent CLOSED months in MYT', () => {
    // 2026-09-05 02:00 MYT (= 2026-09-04 18:00 UTC).
    expect(sweepMonths(Date.UTC(2026, 8, 4, 18, 0, 0))).toEqual(['2026-08', '2026-07']);
    // Jan 1st just after midnight MYT: last month is December of last year.
    expect(sweepMonths(Date.UTC(2025, 11, 31, 16, 30, 0))).toEqual(['2025-12', '2025-11']);
  });
});

describe('stockValueAsOf — the business-date replay', () => {
  test('IN adds, OUT subtracts, ADJUSTMENT follows its qty sign; the date filter is the BUSINESS date', async () => {
    const sb = world({
      inventory_movements: [
        mv({}),                                                                     // +1000.00 in Aug
        mv({ movement_type: 'OUT', total_cost_sen: 30_000, movement_date: '2026-08-20' }),  // -300.00
        mv({ movement_type: 'ADJUSTMENT', qty: -1, total_cost_sen: 20_000, movement_date: '2026-08-25' }), // -200.00 write-off
        // Keyed in September FOR September — outside an Aug-31 replay.
        mv({ movement_date: '2026-09-02', total_cost_sen: 999_999 }),
      ],
    });
    const r = await stockValueAsOf(sb, CO, '2026-08-31');
    expect(r).toEqual({ ok: true, valueSen: 50_000 });
  });

  test('a late-keyed GRN with an August received date counts in August; a dateless migration-window row counts by its keyed time', async () => {
    const sb = world({
      inventory_movements: [
        // Keyed Sep 2, received Aug 30 — the owner's exact worry.
        mv({ movement_date: '2026-08-30', created_at: '2026-09-02T01:00:00Z', total_cost_sen: 70_000 }),
        // Written by the not-yet-redeployed worker: no movement_date at all.
        mv({ movement_date: null, created_at: '2026-08-15T09:00:00Z', total_cost_sen: 5_000 }),
      ],
    });
    const r = await stockValueAsOf(sb, CO, '2026-08-31');
    expect(r).toEqual({ ok: true, valueSen: 75_000 });
  });
});

describe('stockBreakdownAsOf — the per-item photograph', () => {
  test('groups by item with the same signs and date rules as the value replay', async () => {
    const { stockBreakdownAsOf } = await import('./stock-close');
    const sb = world({
      inventory_movements: [
        mv({ item_code: 'SOFA-1' }),
        mv({ item_code: 'SOFA-1', movement_type: 'OUT', qty: 1, total_cost_sen: 30_000, movement_date: '2026-08-20' }),
        mv({ item_code: 'MAT-1', total_cost_sen: 20_000, movement_date: '2026-08-30', created_at: '2026-09-02T01:00:00Z' }), // keyed late, Aug business date
        mv({ item_code: 'MAT-1', movement_date: '2026-09-02', total_cost_sen: 999_999 }), // September — outside
      ],
    });
    const r = await stockBreakdownAsOf(sb, CO, '2026-08-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.get('SOFA-1')).toEqual({ qty: 0, valueSen: 70_000 });
    expect(r.items.get('MAT-1')).toEqual({ qty: 1, valueSen: 20_000 });
  });
});

describe('closeStockMonth — the pair, the heal, the log', () => {
  test('first close posts the pair: closing dated the last day, the reversal the 1st of next', async () => {
    const sb = world({ inventory_movements: [mv({})] });
    const o = await closeStockMonth(sb, CO, '2026-08', 'manual');
    expect(o).toMatchObject({ action: 'posted', valueSen: 100_000 });

    const jes = sb.tables.journal_entries;
    expect(jes).toHaveLength(2);
    const adj = jes.find((j) => j.source_doc_no === `STOCKADJ-${CO}-2026-08`)!;
    const rev = jes.find((j) => j.source_doc_no === `STOCKADJ-REV-${CO}-2026-08`)!;
    expect(adj.entry_date).toBe('2026-08-31');
    expect(rev.entry_date).toBe('2026-09-01');

    const lineOf = (jeId: unknown, code: string) =>
      sb.tables.journal_entry_lines.find((l) => l.journal_entry_id === jeId && l.account_code === code)!;
    /* No warehouse on the row reads as customer stock; the opening lands on 600-0001, never back on the closing account. */
    expect(lineOf(adj.id, '330-0001')).toMatchObject({ debit_sen: 100_000 });
    expect(lineOf(adj.id, '620-0001')).toMatchObject({ credit_sen: 100_000 });
    expect(lineOf(rev.id, '600-0001')).toMatchObject({ debit_sen: 100_000 });
    expect(lineOf(rev.id, '330-0001')).toMatchObject({ credit_sen: 100_000 });
    expect(o.buckets).toEqual({ customer: 100_000, display: 0, service: 0 });

    expect(sb.tables.acc_stock_close_runs).toHaveLength(1);
    expect(sb.tables.acc_stock_close_runs[0]).toMatchObject({ month: '2026-08', action: 'posted', trigger: 'manual' });
  });

  test('a re-run with the same value is quiet: one log row, no new entries', async () => {
    const sb = world({ inventory_movements: [mv({})] });
    await closeStockMonth(sb, CO, '2026-08', 'manual');
    const o2 = await closeStockMonth(sb, CO, '2026-08', 'cron');
    expect(o2.action).toBe('unchanged');
    expect(sb.tables.journal_entries).toHaveLength(2);
    expect(sb.tables.acc_stock_close_runs).toHaveLength(2);
  });

  test('a late GRN changes the value: the old pair is REVERSED (never edited) and a new pair posts', async () => {
    const sb = world({ inventory_movements: [mv({})] });
    await closeStockMonth(sb, CO, '2026-08', 'manual');
    // The late GRN arrives: keyed in September, received in August.
    sb.tables.inventory_movements.push(mv({ movement_date: '2026-08-30', created_at: '2026-09-03T01:00:00Z', total_cost_sen: 50_000 }));

    const o = await closeStockMonth(sb, CO, '2026-08', 'cron');
    expect(o).toMatchObject({ action: 'reposted', valueSen: 150_000 });

    const jes = sb.tables.journal_entries;
    // The contra carries the SAME doc number under source_type STOCKADJ_REVERSAL,
    // so "the active closing entry" is type + doc + not-reversed.
    const activeAdj = jes.filter((j) => j.source_type === 'STOCKADJ' && j.source_doc_no === `STOCKADJ-${CO}-2026-08` && !j.reversed);
    expect(activeAdj).toHaveLength(1);
    expect(Number(activeAdj[0].total_debit_sen)).toBe(150_000);
    // The first pair survives, reversed, with its contras on the record.
    expect(jes.filter((j) => j.reversed).length).toBe(2);
    expect(jes.filter((j) => String(j.source_type) === 'STOCKADJ_REVERSAL').length).toBe(2);
  });

  test('zero posts nothing; a negative replay fails loudly', async () => {
    const zero = world();
    const oz = await closeStockMonth(zero, CO, '2026-08', 'manual');
    expect(oz.action).toBe('unchanged');
    expect(zero.tables.journal_entries).toHaveLength(0);

    const neg = world({ inventory_movements: [mv({ movement_type: 'OUT' })] });
    const on = await closeStockMonth(neg, CO, '2026-08', 'manual');
    expect(on.action).toBe('failed');
    expect(String(on.note)).toContain('negative');
    expect(neg.tables.journal_entries).toHaveLength(0);
  });
});

describe('three closing stocks (owner 2026-09-21: closing stock - customer / display / service)', () => {
  const lineOf = (sb: ReturnType<typeof world>, jeId: unknown, code: string) =>
    sb.tables.journal_entry_lines.find((l) => l.journal_entry_id === jeId && l.account_code === code);
  const activeAdj = (sb: ReturnType<typeof world>) =>
    sb.tables.journal_entries.find((j) => j.source_type === 'STOCKADJ' && j.source_doc_no === `STOCKADJ-${CO}-2026-08` && !j.reversed)!;
  const activeRev = (sb: ReturnType<typeof world>) =>
    sb.tables.journal_entries.find((j) => j.source_type === 'STOCKADJ' && j.source_doc_no === `STOCKADJ-REV-${CO}-2026-08` && !j.reversed)!;

  test('the value splits by the warehouse bucket — the type by default, the override first — and consignment goods never count', async () => {
    const sb = world({
      inventory_movements: [
        mv({ item_code: 'SOFA-1', warehouse_id: 'wh-main' }),                                                  // customer 1,000.00
        mv({ item_code: 'SOFA-1', warehouse_id: 'wh-show', total_cost_sen: 30_000 }),                         // display   300.00
        mv({ item_code: 'SOFA-1', warehouse_id: 'wh-svc', total_cost_sen: 5_000 }),                           // service    50.00
        mv({ item_code: 'SOFA-1', warehouse_id: 'wh-cc', total_cost_sen: 20_000 }),                           // typed display, bucket customer → customer 200.00
        mv({ item_code: 'SOFA-1', warehouse_id: 'wh-show', total_cost_sen: 99_900, source_doc_type: 'PC_RECEIVE', source_doc_no: '2990-PCR-2608-001' }), // the supplier's
      ],
    });
    const split = await stockValueByBucketAsOf(sb, CO, '2026-08-31');
    expect(split).toEqual({ ok: true, buckets: { customer: 120_000, display: 30_000, service: 5_000 }, totalSen: 155_000 });
    expect(await stockValueAsOf(sb, CO, '2026-08-31')).toEqual({ ok: true, valueSen: 155_000 });

    const o = await closeStockMonth(sb, CO, '2026-08', 'manual');
    expect(o).toMatchObject({ action: 'posted', valueSen: 155_000, buckets: { customer: 120_000, display: 30_000, service: 5_000 } });
    const adj = activeAdj(sb);
    const rev = activeRev(sb);
    expect(lineOf(sb, adj.id, '330-0001')).toMatchObject({ debit_sen: 120_000 });
    expect(lineOf(sb, adj.id, '620-0001')).toMatchObject({ credit_sen: 120_000 });
    expect(lineOf(sb, adj.id, '330-0002')).toMatchObject({ debit_sen: 30_000 });
    expect(lineOf(sb, adj.id, '620-0002')).toMatchObject({ credit_sen: 30_000 });
    expect(lineOf(sb, adj.id, '330-0003')).toMatchObject({ debit_sen: 5_000 });
    expect(lineOf(sb, adj.id, '620-0003')).toMatchObject({ credit_sen: 5_000 });
    expect(lineOf(sb, rev.id, '600-0001')).toMatchObject({ debit_sen: 120_000 });
    expect(lineOf(sb, rev.id, '600-0002')).toMatchObject({ debit_sen: 30_000 });
    expect(lineOf(sb, rev.id, '600-0003')).toMatchObject({ debit_sen: 5_000 });
    expect(lineOf(sb, rev.id, '330-0002')).toMatchObject({ credit_sen: 30_000 });
    /* The parents take no money. */
    expect(sb.tables.journal_entry_lines.some((l) => ['330-0000', '600-0000', '620-0000'].includes(String(l.account_code)))).toBe(false);
    /* The run log names the split. */
    const run = sb.tables.acc_stock_close_runs[0]!;
    expect(String(run.note)).toContain('customer');
    expect(String(run.note)).toContain('display');
    expect(String(run.note)).toContain('service');
    /* And the per-item photograph leaves the supplier's goods out too. */
    const { stockBreakdownAsOf } = await import('./stock-close');
    const br = await stockBreakdownAsOf(sb, CO, '2026-08-31');
    expect(br.ok && [...br.items.values()].reduce((s, v) => s + v.valueSen, 0)).toBe(155_000);
  });

  test('a warehouse re-bucketed re-posts the month: the same money on other accounts is a changed entry', async () => {
    const sb = world({ inventory_movements: [mv({ item_code: 'SOFA-1', warehouse_id: 'wh-cc' })] });
    const first = await closeStockMonth(sb, CO, '2026-08', 'manual');
    expect(first).toMatchObject({ action: 'posted', buckets: { customer: 100_000, display: 0, service: 0 } });
    /* Finance clears the override: the display-typed location reads display again. */
    sb.tables.warehouses.find((w) => w.id === 'wh-cc')!.stock_bucket = null;
    const second = await closeStockMonth(sb, CO, '2026-08', 'cron');
    expect(second).toMatchObject({ action: 'reposted', valueSen: 100_000, buckets: { customer: 0, display: 100_000, service: 0 } });
    expect(lineOf(sb, activeAdj(sb).id, '330-0002')).toMatchObject({ debit_sen: 100_000 });
    expect(lineOf(sb, activeAdj(sb).id, '330-0001')).toBeUndefined();
    expect(sb.tables.journal_entries.filter((j) => j.reversed)).toHaveLength(2);
    /* And a third look is quiet. */
    expect((await closeStockMonth(sb, CO, '2026-08', 'cron')).action).toBe('unchanged');
  });

  test('a month closed on the old one-account shape is re-posted on the children the first time the sweep sees it', async () => {
    const sb = world({ inventory_movements: [mv({ item_code: 'SOFA-1', warehouse_id: 'wh-main' })] });
    /* The pair as the close wrote it before 2026-09-21: STOCK / STOCKS AT THE END, the reversal back on the closing account. */
    sb.tables.accounts.push(acct('330-0000', null) /* a second row is harmless in the fake */);
    const legacy = (docNo: string, entryDate: string, dr: string, cr: string) => postJournal(sb, {
      companyId: CO, entryDate, sourceType: 'STOCKADJ', sourceDocNo: docNo, narration: 'legacy pair',
      lines: [
        { accountCode: dr, debitSen: 100_000, creditSen: 0, notes: 'legacy' },
        { accountCode: cr, debitSen: 0, creditSen: 100_000, notes: 'legacy' },
      ],
    });
    /* The parents were leaves then: strip the children for the legacy post, put them back for the close. */
    const children = sb.tables.accounts.filter((a) => a.parent_code != null);
    for (const c of children) sb.tables.accounts.splice(sb.tables.accounts.indexOf(c), 1);
    expect((await legacy(`STOCKADJ-${CO}-2026-08`, '2026-08-31', '330-0000', '620-0000')).ok).toBe(true);
    expect((await legacy(`STOCKADJ-REV-${CO}-2026-08`, '2026-09-01', '620-0000', '330-0000')).ok).toBe(true);
    sb.tables.accounts.push(...children);

    const o = await closeStockMonth(sb, CO, '2026-08', 'cron');
    expect(o).toMatchObject({ action: 'reposted', valueSen: 100_000 });
    expect(lineOf(sb, activeAdj(sb).id, '330-0001')).toMatchObject({ debit_sen: 100_000 });
    expect(lineOf(sb, activeRev(sb).id, '600-0001')).toMatchObject({ debit_sen: 100_000 });
    expect(sb.tables.journal_entries.filter((j) => j.reversed)).toHaveLength(2);
  });
});
