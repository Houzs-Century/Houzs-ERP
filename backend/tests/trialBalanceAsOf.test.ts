/* The Trial balance as at a day (the owner's Finance redesign, batch 6 read
   c1): GET /accounting/balances?asOf=YYYY-MM-DD takes the lines the books count
   dated AFTER the day back off the all-time balances. Pinned on the real
   handler over fake PostgREST (fakeSb):
     • without asOf, the view's rows come back untouched — the answer every
       caller had before;
     • with asOf, a later line comes off its own account and side, a line ON
       the day stays, a reversed original with its contra moves nothing, and
       another company's later lines are not this company's;
     • a day not written YYYY-MM-DD is refused, never read as "no cut";
     • a later-lines read that fails is a 500, never all-time balances handed
       back as if they were the day's. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { balancesHandler } from '../src/scm/routes/accounting';

const CO = 2;
const OTHER = 3;

const balance = (code: string, type: string, dr: number, cr: number, companyId = CO): Row => ({
  company_id: companyId, account_code: code, account_name: code, account_type: type,
  total_debit_sen: dr, total_credit_sen: cr,
  balance_sen: type === 'ASSET' || type === 'EXPENSE' ? dr - cr : cr - dr,
});

const line = (date: string, code: string, dr: number, cr: number, extra: Row = {}): Row => ({
  company_id: CO, entry_date: date, account_code: code, debit_sen: dr, credit_sen: cr,
  reversed: false, reversed_by_je: null, ...extra,
});

/* August: RM 1,000 banked on the 31st. September: RM 300 more on the 5th, and
   an RM 500 sale keyed twice whose original was reversed on the 20th (the view
   counts neither side, so neither is in the all-time totals). Company 3 has an
   RM 9,000 September line on the same account code. */
const VIEW: Row[] = [
  balance('310-0010', 'ASSET', 130_000, 0),
  balance('501-0000', 'INCOME', 0, 130_000),
  balance('310-0010', 'ASSET', 900_000, 0, OTHER),
];
const LINES: Row[] = [
  line('2026-08-31', '310-0010', 100_000, 0),
  line('2026-08-31', '501-0000', 0, 100_000),
  line('2026-09-05', '310-0010', 30_000, 0),
  line('2026-09-05', '501-0000', 0, 30_000),
  line('2026-09-10', '310-0010', 50_000, 0, { reversed: true, reversed_by_je: 'je-contra' }),
  line('2026-09-10', '501-0000', 0, 50_000, { reversed: true, reversed_by_je: 'je-contra' }),
  line('2026-09-20', '501-0000', 50_000, 0, { reversed_by_je: 'je-original' }),
  line('2026-09-20', '310-0010', 0, 50_000, { reversed_by_je: 'je-original' }),
  line('2026-09-07', '310-0010', 900_000, 0, { company_id: OTHER }),
];

function harness(missing: Record<string, string[]> = {}) {
  const sb = fakeSb(
    { v_account_balances: VIEW.map((r) => ({ ...r })), v_gl_entries: LINES.map((r) => ({ ...r })) },
    missing,
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/balances', balancesHandler as never);
  return app;
}

type Body = { balances?: Row[]; asOf?: string; error?: string };
const byCode = (b: Body) => new Map((b.balances ?? []).map((r) => [r.account_code as string, r]));

describe('GET /accounting/balances — the Trial balance as at a day', () => {
  test('without asOf the active company’s all-time rows come back as they are', async () => {
    const res = await harness().request('/accounting/balances');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.asOf).toBeUndefined();
    expect(body.balances).toEqual(VIEW.filter((r) => r.company_id === CO));
  });

  test('as at 31 August the September lines come off, the 31st stays, and the reversal pair moves nothing', async () => {
    const res = await harness().request('/accounting/balances?asOf=2026-08-31');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.asOf).toBe('2026-08-31');
    const rows = byCode(body);
    expect(rows.get('310-0010')).toMatchObject({ total_debit_sen: 100_000, total_credit_sen: 0, balance_sen: 100_000 });
    expect(rows.get('501-0000')).toMatchObject({ total_debit_sen: 0, total_credit_sen: 100_000, balance_sen: 100_000 });
    /* Company 3's RM 9,000 is neither in the rows nor taken off company 2's bank. */
    expect(body.balances).toHaveLength(2);
  });

  test('as at the last day with lines, nothing comes off', async () => {
    const body = (await (await harness().request('/accounting/balances?asOf=2026-09-30')).json()) as Body;
    expect(body.balances).toEqual(VIEW.filter((r) => r.company_id === CO));
  });

  test('a day not written YYYY-MM-DD is refused, not read as all-time', async () => {
    for (const bad of ['31/08/2026', '2026-8-31', 'today']) {
      const res = await harness().request(`/accounting/balances?asOf=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Body).error).toBe('bad_request');
    }
  });

  test('a later-lines read that fails is a 500 — no all-time figures dressed as the day’s', async () => {
    const res = await harness({ v_gl_entries: ['reversed_by_je'] }).request('/accounting/balances?asOf=2026-08-31');
    expect(res.status).toBe(500);
    const body = (await res.json()) as Body;
    expect(body.error).toBe('load_failed');
    expect(body.balances).toBeUndefined();
  });
});
