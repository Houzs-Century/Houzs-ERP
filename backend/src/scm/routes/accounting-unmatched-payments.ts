// ----------------------------------------------------------------------------
// GET /accounting/unmatched-payments?from=&to= — every card and transfer
// payment dated in the window that is not matched yet, on one list (owner
// 2026-09-30: 我有没有一个表是显示全部还没 match 的 → 做). The rules are
// acc/unmatched-payments; this is the door. Registered in routes/accounting.ts
// so it inherits supabaseAuth and appears in the route-capability matrix.
//
// Gated like the two reconciliation screens it summarises (the settlement
// guard): scm.payment_voucher.post, read as well as write.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { loadUnmatchedPayments } from '../../acc/unmatched-payments';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How far back the list reaches when the screen names no From — the
    in-transit list's reach, so the two agree on what "recent" means. */
export const UNMATCHED_DEFAULT_DAYS = 180;

const shiftDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const unmatchedPaymentsHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to see the reconciliation lists." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const toQ = c.req.query('to') ?? '';
  const fromQ = c.req.query('from') ?? '';
  const to = DAY.test(toQ) ? toQ : today;
  const from = DAY.test(fromQ) ? fromQ : shiftDays(to, -UNMATCHED_DEFAULT_DAYS);
  if (from > to) return c.json({ error: 'bad_window', message: 'The From date is after the To date.' }, 400);

  const got = await loadUnmatchedPayments(c.get('supabase'), co.companyId, { from, to, today });
  if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
  return c.json({ from, to, rows: got.rows });
};
