// ----------------------------------------------------------------------------
// accounting-receipts — the Official Receipts surface (GL redesign item 9).
// The receipts themselves are born inside the payment writers and formalised
// by the money-confirmation hooks (acc/receipts.ts); this file is the screen's
// three doors: list them, fetch-or-heal one for a payment (the print button's
// path), and the MANUAL confirm — the owner's 客户催收据 route: he verified
// the slip himself, the receipt goes formal now, recon links up later.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { ensureReceiptForPayment, formaliseReceipt } from '../../acc/receipts';
import { resolveRoles } from '../../acc/rules';
import { companyCodeById } from '../lib/doc-no';

/* Receipts are a sales-side paper: the writer key covers recording payments,
   so it covers handing over the receipt for one. */
const requirePerm = (c: any): boolean =>
  hasHouzsPerm(c, 'scm.payment_voucher.post') || hasHouzsPerm(c, 'scm.sales_order.write');

/* ── GET /accounting/receipts?status=&limit= ─────────────────────────────── */
export const receiptsList = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to see receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const status = String(c.req.query('status') ?? '').trim().toUpperCase();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));

  let q = sb.from('acc_receipts')
    .select('id, or_number, status, payment_source, payment_id, doc_no, customer_name, method, amount_sen, paid_at, channel_account_code, issued_at, issued_by, created_at')
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status === 'DRAFT' || status === 'FORMAL') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ receipts: data ?? [] });
};

/* ── POST /accounting/receipts/ensure — {source, paymentId} ──────────────── */
export const receiptEnsure = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to issue receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const source = String(body.source ?? '').trim().toUpperCase();
  const paymentId = String(body.paymentId ?? '').trim();
  if ((source !== 'SOPAY' && source !== 'SIPAY') || !paymentId) {
    return c.json({ error: 'bad_key', message: 'source (SOPAY/SIPAY) and paymentId are required.' }, 400);
  }
  const sb = c.get('supabase');
  const r = await ensureReceiptForPayment(sb, source as 'SOPAY' | 'SIPAY', paymentId);
  if (!r.ok) return c.json({ error: 'ensure_failed', reason: r.reason }, 500);
  /* The caller is about to PRINT: hand back the whole row (customer, method,
     amounts, issued-by), not just the number — one round trip, server truth. */
  const { data: row, error: rowErr } = await sb.from('acc_receipts').select('*').eq('id', r.id).maybeSingle();
  if (rowErr || !row) return c.json({ error: 'ensure_failed', reason: rowErr?.message ?? 'receipt vanished after ensure' }, 500);
  return c.json({ receipt: row });
};

/* ── POST /accounting/receipts/:id/formalise — {accountCode?} ─────────────
   The human said the money is real. accountCode names where it landed; left
   out, the company's default bank answers (transfers into the main account —
   the common case the owner described). */
export const receiptFormalise = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to confirm receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400);
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body = default bank */ }
  const sb = c.get('supabase');

  const roles = await resolveRoles(sb, co.companyId);
  const accountCode = String(body?.accountCode ?? '').trim() || roles.BANK_DEFAULT;
  const code = await companyCodeById(sb, co.companyId);
  if (!code) return c.json({ error: 'load_failed', reason: `company ${co.companyId} has no code` }, 500);

  const actor = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  const r = await formaliseReceipt(sb, { companyId: co.companyId, companyCode: code, receiptId: id, accountCode, actor });
  if (!r.ok) {
    return c.json({ error: r.status, message: r.reason }, r.status === 'bank_letter_missing' ? 409 : r.status === 'not_found' ? 404 : 500);
  }
  return c.json({ ok: true, orNumber: r.orNumber, already: r.already === true });
};
