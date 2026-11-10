// GET  /accounting/receipts/rebank?from=YYYY-MM-DD&to=YYYY-MM-DD — the transfer
//      receipts in the range booked on another bank than the company's
//      Receive into (BANK_DEFAULT), each with why it cannot move, if it cannot.
// POST /accounting/receipts/rebank { items: [{ source, paymentId }] } — move
//      them: reverse on the original date, book again on Receive into.
// Rules in acc/receipt-rebank.ts. Registered by accounting.ts.

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { MAX_REBANK_PER_CALL, rebankCandidates, rebankReceipts } from '../../acc/receipt-rebank';
import { rebankTxFor } from '../../acc/rebank-transaction';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const NO_PERM = { error: "You don't have permission to write to the general ledger." };

export const rebankListHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '');
  const to = String(c.req.query('to') ?? '');
  if (!ISO.test(from) || !ISO.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'Give a from and to date, from on or before to.' }, 400);
  }
  const r = await rebankCandidates(c.get('supabase'), co.companyId, from, to);
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json({ target: r.target, rows: r.rows });
};

export const rebankMoveHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const raw: unknown[] = Array.isArray(body.items) ? (body.items as unknown[]) : [];
  const items = raw.flatMap((i) => {
    const o = (i && typeof i === 'object' ? i : {}) as Record<string, unknown>;
    const source: 'SOPAY' | 'SIPAY' | null = o.source === 'SOPAY' || o.source === 'SIPAY' ? o.source : null;
    const paymentId = typeof o.paymentId === 'string' && o.paymentId.trim() ? o.paymentId.trim() : null;
    return source && paymentId ? [{ source, paymentId }] : [];
  });
  if (items.length === 0 || items.length !== raw.length) {
    return c.json({ error: 'bad_items', message: 'Send the receipts to move as { source: SOPAY | SIPAY, paymentId }.' }, 400);
  }
  if (items.length > MAX_REBANK_PER_CALL) {
    return c.json({ error: 'too_many', message: `At most ${MAX_REBANK_PER_CALL} receipts per move.` }, 400);
  }
  /* Each receipt moves in its own transaction (RECEIPT_REBANK_MODE, acc/rebank-transaction.ts). */
  const r = await rebankReceipts(c.get('supabase'), co.companyId, items, rebankTxFor(c.env));
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json({ target: r.target, results: r.results });
};
