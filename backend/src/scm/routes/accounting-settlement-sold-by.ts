// ----------------------------------------------------------------------------
// accounting-settlement-sold-by — a merchant report line that is another
// company's sale (owner 2026-11-17: 2990's swipes on Houzs's AEON terminal,
// 「houzs 那边的报表要确定这些和refund给2990 contra 掉」). Two doors:
//
//   GET  /accounting/settlement/other-companies — the companies this one keeps
//        an account for (scm.acc_company_links), each with that account;
//   POST /accounting/settlement/rows/:id/sold-by { companyId, note? } — the line
//        confirmed as that company's sale: one SETTLEFOR journal onto the
//        account (acc/settlement-sold-by), the report's statement charge, and
//        the bank side following as after any confirm.
//
// Undo is the ordinary Undo of a confirmed line (settlementRowUnconfirm), which
// reverses the SETTLEFOR journal for such a line.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { loadCompanyLinks, markSoldBy } from '../../acc/settlement-sold-by';
import { bankFollows, settlementGuard } from './accounting-settlement';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const actorOf = (c: Ctx): string | null => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

/** Refusals a person can act on — the line, the choice or the setup — answer 409. */
const PERSON_CAN_FIX = new Set(['already_confirmed', 'ignored', 'qr_line', 'not_a_sale', 'linked', 'no_link', 'link_account_unusable']);

/* ── GET /settlement/other-companies ─────────────────────────────────────── */

export const settlementOtherCompanies = settlementGuard(async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const got = await loadCompanyLinks(c.get('supabase'), co.companyId);
  if (!got.ok) return c.json({ error: got.status, message: got.reason }, 500);
  return c.json({ companies: got.links });
});

/* ── POST /settlement/rows/:id/sold-by ───────────────────────────────────── */

export const settlementRowSoldBy = settlementGuard(async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const rowId = Number(c.req.param('id'));
  if (!Number.isInteger(rowId)) return c.json({ error: 'bad_id' }, 400);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const body: Record<string, unknown> = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const otherCompanyId = Number(body.companyId);
  if (!Number.isInteger(otherCompanyId) || otherCompanyId <= 0) {
    return c.json({ error: 'no_company', message: 'Say which company sold it.' }, 400);
  }
  if (otherCompanyId === co.companyId) {
    return c.json({ error: 'own_company', message: 'This company\'s own sale is confirmed against its payment, not here.' }, 400);
  }
  const note = typeof body.note === 'string' ? body.note : null;

  const sb = c.get('supabase');
  const actor = actorOf(c);
  const r = await markSoldBy(sb, { companyId: co.companyId, rowId, otherCompanyId, note, userName: actor });
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404 : PERSON_CAN_FIX.has(r.status) ? 409 : 500;
    return c.json({ error: r.status, message: r.reason }, status);
  }
  /* The report may now be wholly confirmed, so its payout can match itself (owner: 我只要对一边). */
  return c.json({ ...r, bank: await bankFollows(sb, co.companyId, [r.batchId], actor) });
});
