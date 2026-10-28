// ----------------------------------------------------------------------------
// GET /accounting/ar-aging, GET /accounting/ap-aging — the formal debtor and
// creditor aging (owner 2026-10-02: 「现在的 aging 没有那种正式 account 的
// debtor & creditor aging」; B4 「就 replace 旧的，名字可以 remain ar aging 和 ap
// aging」). The rules are acc/aging.ts; the reading is acc/aging-load.ts; this
// is the door. Registered in routes/accounting.ts, one path each, so they keep
// the accounting area guard and appear in the route-capability matrix.
//
// Query (every part optional):
//   asOf     YYYY-MM-DD, the day the aging is as at (default today, Malaysia)
//   basis    invoice | due — age by the invoice's date (default, B2a 「跟发票
//            的月份」) or its due date (a bill with none ages by its date)
//   buckets  month | day — 本月 · 1 · 2 · 3 · 4 个月以上 (default, B1a) or
//            0–30 · 31–60 · 61–90 · 91–120 · 120 天以上
//   control  all | trade | other — AR: 300-0000 trade debtors / 305-0000 other
//            debtors; AP: 400-0000 trade creditors / 405-0000 other creditors
//            (each company's own role accounts)
// Answer: { asOf, basis, buckets, control, rows, totals, controls,
//           differenceSen, outside, paidBeforeErp }. Each row is a debtor or creditor: its
// balance, its open bills in the five columns, its 未冲 (B3a), and both lists.
// `controls` are the control accounts' balances as at the date and
// `differenceSen` what the rows miss of them — zero, by construction.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { resolveRoles } from '../../acc/rules';
import { ageEntries, agingTotals, type AgingBasis, type AgingBuckets } from '../../acc/aging';
import { loadApAging, loadArAging, type AgingLoad } from '../../acc/aging-load';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Control = 'all' | 'trade' | 'other';

function readQuery(c: Ctx): { asOf: string; basis: AgingBasis; buckets: AgingBuckets; control: Control } | { error: string } {
  const asOfQ = c.req.query('asOf') ?? '';
  if (asOfQ && !DAY.test(asOfQ)) return { error: 'The date must be YYYY-MM-DD.' };
  const basis = c.req.query('basis') === 'due' ? 'due' : 'invoice';
  const buckets = c.req.query('buckets') === 'day' ? 'day' : 'month';
  const controlQ = c.req.query('control');
  const control: Control = controlQ === 'trade' || controlQ === 'other' ? controlQ : 'all';
  return { asOf: asOfQ || todayMyt(), basis, buckets, control };
}

async function agingHandler(c: Ctx, side: 'AR' | 'AP'): Promise<Response> {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const q = readQuery(c);
  if ('error' in q) return c.json({ error: 'bad_date', message: q.error }, 400);
  const sb = c.get('supabase');
  const roles = await resolveRoles(sb, co.companyId);
  const trade = side === 'AR' ? roles.AR : roles.AP;
  const other = side === 'AR' ? roles.AR_OTHER : roles.AP_OTHER;
  const codes = q.control === 'trade' ? [trade] : q.control === 'other' ? [other] : [trade, other];

  const loaded: AgingLoad = side === 'AR'
    ? await loadArAging(sb, co.companyId, codes, q.asOf)
    : await loadApAging(sb, co.companyId, codes, q.asOf);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);

  const rows = ageEntries(loaded.entries, { asOf: q.asOf, basis: q.basis, buckets: q.buckets });
  const totals = agingTotals(rows);
  /* AR: orders that owe here although AutoCount took their deposit — the
     smaller of what the order still owes and what was paid before the ERP. */
  const owedByOrder = new Map<string, number>();
  for (const r of rows) for (const i of r.items) if (i.group.startsWith('SO:')) owedByOrder.set(i.group.slice(3), (owedByOrder.get(i.group.slice(3)) ?? 0) + i.openSen);
  let paidOrders = 0;
  let paidSen = 0;
  for (const [so, owed] of owedByOrder) {
    const before = loaded.paidBeforeErp?.[so] ?? 0;
    if (before <= 0) continue;
    paidOrders += 1;
    paidSen += Math.min(owed, before);
  }
  const booksSen = loaded.controls.reduce((n, k) => n + k.balanceSen, 0);
  return c.json({
    ...q,
    rows,
    totals,
    controls: loaded.controls,
    differenceSen: totals.balanceSen - booksSen,
    outside: loaded.outside,
    paidBeforeErp: { orders: paidOrders, sen: paidSen },
  });
}

export const arAgingHandler = (c: Ctx): Promise<Response> => agingHandler(c, 'AR');
export const apAgingHandler = (c: Ctx): Promise<Response> => agingHandler(c, 'AP');
