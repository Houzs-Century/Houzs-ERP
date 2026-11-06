// The months the stock close has booked, as Books › Stock close lists them
// (batch 6 c4). Pinned: each month's ACTIVE closing entry, its value per bucket
// (customer, display, service, showroom, others) from the bucket accounts'
// debits, posted once or re-posted (an earlier closing entry reversed), the
// opening entry beside it, newest month first; another company's entries and
// a REV document never count as a month of their own.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { closeStockMonth } from './stock-close';
import { closedStockMonths, stockDocMonth } from './stock-close-months';

const CO = 2;
const acct = (code: string, parent: string | null): Row => ({
  account_code: code, account_name: code, account_type: code.startsWith('330') ? 'ASSET' : 'EXPENSE', parent_code: parent, is_active: true, company_id: CO,
});
const CHART: Row[] = ['330-0000', '600-0000', '620-0000'].flatMap((p) => [acct(p, null), ...['0001', '0002', '0003', '0004', '0005'].map((s) => acct(`${p.slice(0, 4)}${s}`, p))]);
const mv = (over: Row): Row => ({ company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 100_000, movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', ...over });

const world = (movements: Row[]) => fakeSb({
  accounts: CHART.map((r) => ({ ...r })),
  acc_account_roles: [],
  companies: [{ id: CO, code: '2990' }],
  warehouses: [
    { id: 'wh-main', company_id: CO, type: 'warehouse', stock_bucket: null },
    { id: 'wh-disp', company_id: CO, type: 'display', stock_bucket: null },
    { id: 'wh-show', company_id: CO, type: 'showroom', stock_bucket: null },
  ],
  inventory_movements: movements,
  journal_entries: [],
  journal_entry_lines: [],
  acc_stock_close_runs: [],
});

describe('stockDocMonth', () => {
  test('names the month and the leg of this company’s documents only', () => {
    expect(stockDocMonth(CO, 'STOCKADJ-2-2026-08')).toEqual({ month: '2026-08', leg: 'close' });
    expect(stockDocMonth(CO, 'STOCKADJ-REV-2-2026-08')).toEqual({ month: '2026-08', leg: 'open' });
    expect(stockDocMonth(CO, 'STOCKADJ-1-2026-08')).toBeNull();
    expect(stockDocMonth(CO, 'STOCKADJ-2-2026-8')).toBeNull();
  });
});

describe('closedStockMonths', () => {
  test('a month posted once: its buckets, its entries, booked the day it ran', async () => {
    const sb = world([mv({ warehouse_id: 'wh-main' }), mv({ warehouse_id: 'wh-disp', total_cost_sen: 40_000 }), mv({ warehouse_id: 'wh-show', total_cost_sen: 10_000 })]);
    expect((await closeStockMonth(sb, CO, '2026-08', 'cron')).action).toBe('posted');
    const r = await closedStockMonths(sb, CO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.months).toHaveLength(1);
    const aug = r.months[0]!;
    expect(aug).toMatchObject({ month: '2026-08', action: 'posted', totalSen: 150_000 });
    expect(aug.buckets).toEqual({ customer: 100_000, display: 40_000, service: 0, showroom: 10_000, others: 0 });
    const adj = sb.tables.journal_entries.find((j) => j.source_doc_no === `STOCKADJ-${CO}-2026-08` && !j.reversed)!;
    const rev = sb.tables.journal_entries.find((j) => j.source_doc_no === `STOCKADJ-REV-${CO}-2026-08` && !j.reversed)!;
    expect(aug.jeNo).toBe(adj.je_no);
    expect(aug.revJeNo).toBe(rev.je_no);
  });

  test('a month whose value moved is re-posted: the new entry and its split, newest month first', async () => {
    const sb = world([mv({ warehouse_id: 'wh-main', movement_date: '2026-07-10', created_at: '2026-07-10T02:00:00Z' })]);
    await closeStockMonth(sb, CO, '2026-07', 'cron');
    await closeStockMonth(sb, CO, '2026-08', 'cron');
    /* A late GRN dated in August: the August close re-posts. */
    sb.tables.inventory_movements.push(mv({ warehouse_id: 'wh-disp', total_cost_sen: 3_480, movement_date: '2026-08-29', created_at: '2026-09-12T02:00:00Z' }));
    expect((await closeStockMonth(sb, CO, '2026-08', 'manual')).action).toBe('reposted');
    const r = await closedStockMonths(sb, CO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.months.map((m) => [m.month, m.action, m.totalSen])).toEqual([['2026-08', 'reposted', 103_480], ['2026-07', 'posted', 100_000]]);
    expect(r.months[0]!.buckets).toMatchObject({ customer: 100_000, display: 3_480 });
    const active = sb.tables.journal_entries.find((j) => j.source_type === 'STOCKADJ' && j.source_doc_no === `STOCKADJ-${CO}-2026-08` && !j.reversed)!;
    expect(r.months[0]!.jeNo).toBe(active.je_no);
  });

  test('a company that never closed has no months', async () => {
    expect(await closedStockMonths(world([]), CO)).toEqual({ ok: true, months: [] });
  });
});
