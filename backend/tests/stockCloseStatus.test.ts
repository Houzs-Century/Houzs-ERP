/* Books › Stock close reads (the owner's Claude Design, batch 6 c4). Pinned:
     • GET /accounting/stock-close returns the live value WITH its five
       buckets, the two months the nightly run re-checks, every month the
       close has booked (split by bucket, its entries), and the runs of the
       last 90 days only — an older run is left out;
     • it needs the posting right, as before.
   Real handler, fake PostgREST (fakeSb). Reads only. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { closeStockMonth, sweepMonths } from '../src/acc/stock-close';
import { RUN_DAYS, stockCloseStatus } from '../src/scm/routes/accounting-stock-close';

const CO = 2;
const acct = (code: string, parent: string | null): Row => ({
  account_code: code, account_name: code, account_type: code.startsWith('330') ? 'ASSET' : 'EXPENSE', parent_code: parent, is_active: true, company_id: CO,
});
const CHART: Row[] = ['330-0000', '600-0000', '620-0000'].flatMap((p) => [acct(p, null), ...['0001', '0002', '0003', '0004', '0005'].map((s) => acct(`${p.slice(0, 4)}${s}`, p))]);
const mv = (over: Row): Row => ({ company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 100_000, movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', ...over });

const world = () => fakeSb({
  accounts: CHART.map((r) => ({ ...r })),
  acc_account_roles: [],
  companies: [{ id: CO, code: '2990' }],
  warehouses: [
    { id: 'wh-main', company_id: CO, type: 'warehouse', stock_bucket: null },
    { id: 'wh-disp', company_id: CO, type: 'display', stock_bucket: null },
  ],
  inventory_movements: [mv({ warehouse_id: 'wh-main' }), mv({ warehouse_id: 'wh-disp', total_cost_sen: 40_000 })],
  journal_entries: [],
  journal_entry_lines: [],
  acc_stock_close_runs: [],
});

function harness(perms: string[] = ['scm.payment_voucher.post']) {
  const sb = world();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Mei Ling', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/stock-close', stockCloseStatus as never);
  return { app, sb };
}

describe('GET /accounting/stock-close', () => {
  test('the live buckets, the re-checked months, the closed months and the last 90 days of runs', async () => {
    const { app, sb } = harness();
    expect((await closeStockMonth(sb, CO, '2026-08', 'cron')).action).toBe('posted');
    const now = Date.now();
    /* The table stamps ran_at itself; the fake does not. */
    for (const r of sb.tables.acc_stock_close_runs) r.ran_at ??= new Date(now - 3_600_000).toISOString();
    sb.tables.acc_stock_close_runs.push({
      company_id: CO, month: '2026-03', trigger: 'cron', stock_value_sen: 1, action: 'unchanged', je_no: null, rev_je_no: null, note: null,
      ran_at: new Date(now - (RUN_DAYS + 10) * 86_400_000).toISOString(),
    });

    const res = await app.request('/accounting/stock-close');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as {
      liveValueSen: number; liveBuckets: Record<string, number>; defaultMonth: string; sweepMonths: string[];
      runs: Array<{ month: string; action: string }>; months: Array<{ month: string; buckets: Record<string, number>; totalSen: number; action: string; jeNo: string; revJeNo: string | null }>;
    };
    expect(body.liveValueSen).toBe(140_000);
    expect(body.liveBuckets).toEqual({ customer: 100_000, display: 40_000, service: 0, showroom: 0, others: 0 });
    expect(body.sweepMonths).toEqual(sweepMonths());
    expect(body.defaultMonth).toBe(sweepMonths()[0]);
    expect(body.runs.map((r) => [r.month, r.action])).toEqual([['2026-08', 'posted']]);
    expect(body.months).toHaveLength(1);
    expect(body.months[0]).toMatchObject({ month: '2026-08', action: 'posted', totalSen: 140_000, buckets: { customer: 100_000, display: 40_000, service: 0, showroom: 0, others: 0 } });
    const adj = sb.tables.journal_entries.find((j) => j.source_type === 'STOCKADJ' && !j.reversed)!;
    expect(body.months[0]!.jeNo).toBe(adj.je_no);
  });

  test('needs the posting right', async () => {
    const { app } = harness([]);
    expect((await app.request('/accounting/stock-close')).status).toBe(403);
  });
});
