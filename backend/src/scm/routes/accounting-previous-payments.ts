// ----------------------------------------------------------------------------
// The previous system's payment records (owner 2026-11-11: 我检查确定后，就直接说
// 这个是之前record，我哪里都不会take-in). The rule is acc/previous-payments; these
// are the doors, registered in routes/accounting.ts (supabaseAuth, the route
// matrix), gated like Payments not matched yet, whose page marks and lists them:
//
//   GET  /accounting/previous-payments        every marked payment, its list
//   POST /accounting/previous-payments        { payments: [{ source, id }] } —
//        mark them; the ones the rule refuses come back with their reason
//   POST /accounting/previous-payments/undo   { payments: [...] } — put back
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { listPrevious, markPrevious, undoPrevious, type PaymentRef } from '../../acc/previous-payments';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** A press marks or puts back at most this many at once. */
export const MAX_PREVIOUS_PER_PRESS = 500;

const gate = (c: Ctx): { ok: true; companyId: number } | { ok: false; response: Response } => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return { ok: false, response: c.json({ error: "You don't have permission to mark payment records." }, 403) };
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, response: c.json(co.refusal, 409) };
  return { ok: true, companyId: co.companyId };
};

/** The body's payments, each a known source and an id — or why not. */
async function refsOf(c: Ctx): Promise<{ ok: true; refs: PaymentRef[] } | { ok: false; response: Response }> {
  let body: unknown;
  try { body = await c.req.json(); } catch { body = null; }
  const list = (body as { payments?: unknown } | null)?.payments;
  const bad = (message: string) => ({ ok: false as const, response: c.json({ error: 'bad_payments', message }, 400) });
  if (!Array.isArray(list) || list.length === 0) return bad('Choose at least one payment.');
  if (list.length > MAX_PREVIOUS_PER_PRESS) return bad(`At most ${MAX_PREVIOUS_PER_PRESS} payments at a time.`);
  const refs: PaymentRef[] = [];
  for (const p of list) {
    const source = (p as { source?: unknown } | null)?.source;
    const id = String((p as { id?: unknown } | null)?.id ?? '').trim();
    if ((source !== 'SOPAY' && source !== 'SIPAY') || id === '' || id.length > 64) return bad('Each payment needs its source (SOPAY or SIPAY) and its id.');
    refs.push({ source, id });
  }
  return { ok: true, refs };
}

const userName = (c: Ctx): string | null => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

export const previousPaymentsList = async (c: Ctx): Promise<Response> => {
  const at = gate(c);
  if (!at.ok) return at.response;
  const got = await listPrevious(c.get('supabase'), at.companyId);
  if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
  return c.json({ rows: got.rows });
};

export const previousPaymentsMark = async (c: Ctx): Promise<Response> => {
  const at = gate(c);
  if (!at.ok) return at.response;
  const body = await refsOf(c);
  if (!body.ok) return body.response;
  const got = await markPrevious(c.get('supabase'), at.companyId, body.refs, userName(c));
  if (!got.ok) return c.json({ error: 'save_failed', reason: got.reason }, 500);
  return c.json({ ok: true, marked: got.marked.length, refused: got.refused });
};

export const previousPaymentsUndo = async (c: Ctx): Promise<Response> => {
  const at = gate(c);
  if (!at.ok) return at.response;
  const body = await refsOf(c);
  if (!body.ok) return body.response;
  const got = await undoPrevious(c.get('supabase'), at.companyId, body.refs);
  if (!got.ok) return c.json({ error: 'save_failed', reason: got.reason }, 500);
  return c.json({ ok: true, undone: got.undone });
};
