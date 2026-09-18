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
//   • every outcome lands in acc_stock_close_runs.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { closeStockMonth, monthEdges, stockValueAsOf, sweepMonths } from './stock-close';

const CO = 2;

const CHART: Row[] = ['330-0000', '620-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: code === '330-0000' ? 'ASSET' : 'EXPENSE',
  parent_code: null, is_active: true, company_id: CO,
}));

const mv = (over: Row): Row => ({
  company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 100_000,
  movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', ...over,
});

const world = (over: Record<string, Row[]> = {}) => fakeSb({
  accounts: CHART.map((r) => ({ ...r })),
  acc_account_roles: [],
  companies: [{ id: CO, code: '2990' }],
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
    expect(lineOf(adj.id, '330-0000')).toMatchObject({ debit_sen: 100_000 });
    expect(lineOf(adj.id, '620-0000')).toMatchObject({ credit_sen: 100_000 });
    expect(lineOf(rev.id, '620-0000')).toMatchObject({ debit_sen: 100_000 });
    expect(lineOf(rev.id, '330-0000')).toMatchObject({ credit_sen: 100_000 });

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
