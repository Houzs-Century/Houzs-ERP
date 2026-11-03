// ---------------------------------------------------------------------------
// connect-payments.ts — HOUZS CONNECT → ERP confirmed-payment push.
//
// Connect (the WhatsApp CRM at chat.houzscentury.com) reads a customer's payment
// slip with OCR, an admin confirms it, and Connect PUSHES the confirmed payment
// here. This endpoint books it onto the matching Sales Order exactly as the
// backend Payments panel does — through the ONE writer, scm/lib/so-payment-row
// recordSoPaymentRow, which also fires the accounting posting, the official
// receipt, the deposit invoice, the AutoCount BALANCE enqueue and the invoice
// re-roll. Nothing accounting-specific is called here; recordSoPaymentRow owns
// all of it (see its body).
//
// AUTH. The MAIN /api auth middleware (middleware/auth.ts) already accepts
// `Bearer <CONNECT_SERVICE_TOKEN>` as the service user — the SAME credential
// Connect's org sync at /api/companies uses. So this router is mounted BELOW
// `app.use("/api/*", auth)` (unlike chatCallback, which carries its own shared
// secret and mounts pre-auth), and requirePermission('*') keeps it to the
// service tier (and owner / IT admin). No new auth mechanism.
//
// WHAT IT DELIBERATELY DOES NOT DO: book blind. A push whose order_ref does not
// resolve to exactly one Sales Order, whose slip date is outside the 14-day
// window, whose currency is not RM, or whose bank / online sub-type is not in
// the live so_dropdown_options is NOT booked — it is QUEUED at status
// 'needs_manual' in scm.connect_payment_pushes (the slip already stored in R2)
// for a human to link. That table is also the IDEMPOTENCY ledger: a repeat of
// the same connect_payment_id returns the first outcome, never a second row.
//
// CONTRACT: see docs in the PR / the request+response shapes below.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { getSupabaseService, isSupabaseConfigured } from '../db/supabase';
import { requirePermission } from '../middleware/auth';
import { loadPaymentOptions, snapPaymentOption } from '../scm/lib/payment-vocab';
import { mapConnectMethod, rmToSen, isSupportedCurrency, classifySoMatch, type SoMatchRow } from '../scm/lib/connect-payment-map';
import { recordSoPaymentRow } from '../scm/lib/so-payment-row';
import { checkPaymentSlipDate } from '../scm/shared/payment-slip-date';
import { todayMyt } from '../scm/lib/my-time';
import { buildSlipKey } from '../scm/lib/r2';
import { slipBindings } from '../scm/lib/slip';
import { ALLOWED_SLIP_MIMES } from '../scm/shared/schemas/slip.schema';

const app = new Hono<{ Bindings: Env }>();

// Service tier only — Connect's CONNECT_SERVICE_TOKEN (and owner / IT admin, who
// hold '*') reach this; a plain staff session is 403'd. hasPermission('*') is
// the whole check (see middleware/auth SERVICE_USER.permissions = ['*']).
app.use('*', requirePermission('*'));

const MAX_SLIP_BYTES = 20 * 1024 * 1024;

/* The push Connect sends. snake_case to match Connect's own payload style and
   chatCallback's. The slip rides as base64 in the body (one call: Connect already
   holds the bytes it OCR'd, and the ERP stores them straight to the R2 SLIPS
   bucket — no separate upload round-trip, no pending_slip_uploads session, which
   that table's staff_id / showroom_id FKs make meaningless for a service caller).
   amount is RM; the ledger stores sen. installment_months 0 = One Shot. */
const pushSchema = z.object({
  connect_payment_id: z.string().trim().min(1).max(200),
  erp_company_id:     z.number().int().positive(),
  customer_phone:     z.string().trim().max(60).optional().nullable(),
  customer_name:      z.string().trim().max(200).optional().nullable(),
  order_ref:          z.string().trim().min(1).max(64),
  amount:             z.number().positive(),
  currency:           z.string().trim().max(10).optional().nullable(),
  method:             z.string().trim().min(1).max(40),
  bank:               z.string().trim().max(120).optional().nullable(),
  online_type:        z.string().trim().max(120).optional().nullable(),
  installment_months: z.number().int().min(0).max(60).optional().nullable(),
  approval_code:      z.string().trim().max(120).optional().nullable(),
  reference:          z.string().trim().max(200).optional().nullable(),
  paid_at:            z.string().trim().min(1).max(32),
  slip_base64:        z.string().min(1),
  // Reuse the ONE shared slip-mime vocabulary (scm/shared/schemas/slip.schema)
  // rather than re-listing the four values here — no new "home" for that set.
  slip_mime:          z.enum(ALLOWED_SLIP_MIMES),
});
type Push = z.infer<typeof pushSchema>;

type PushRow = {
  status: 'processing' | 'recorded' | 'needs_manual' | 'failed';
  so_doc_no: string | null;
  erp_payment_id: string | null;
  error: string | null;
};

/** Decode base64 (tolerating a `data:...;base64,` prefix) to bytes, bounded.
 *  null on bad base64 or an over-size payload — a 400, never a stored row. */
function decodeSlip(b64: string): Uint8Array | null {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  let binary: string;
  try { binary = atob(clean.trim()); } catch { return null; }
  if (binary.length > MAX_SLIP_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

app.post('/', async (c) => {
  if (!isSupabaseConfigured(c.env)) {
    return c.json({ ok: false, error: 'not_configured', reason: 'Supabase is not configured' }, 503);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'invalid_json' }, 400); }
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const p: Push = parsed.data;

  // ── 400-class checks (Connect bugs — never persisted, won't pass on retry) ──
  const methodCode = mapConnectMethod(p.method);
  if (!methodCode) {
    return c.json({ ok: false, error: 'unknown_method', reason: `method must be Card, Online or Cash (got "${p.method}")` }, 400);
  }
  if (!isSupportedCurrency(p.currency)) {
    return c.json({ ok: false, error: 'unsupported_currency', reason: `only MYR is booked (got "${p.currency}")` }, 400);
  }
  const amountSen = rmToSen(p.amount);
  if (amountSen == null || amountSen <= 0) {
    return c.json({ ok: false, error: 'bad_amount', reason: 'amount must be a positive RM value' }, 400);
  }
  // slip_mime is already constrained to the four accepted types by the zod enum
  // above — no second runtime check (and no second copy of that mime set).
  const slipBytes = decodeSlip(p.slip_base64);
  if (!slipBytes) {
    return c.json({ ok: false, error: 'bad_slip', reason: 'slip_base64 is not valid base64, or the slip exceeds 20MB' }, 400);
  }

  const sb = getSupabaseService(c.env);

  // The response for a connect_payment_id that already reached a terminal state —
  // an idempotent replay. 'failed' is NOT terminal: the caller re-processes it.
  const replay = (row: PushRow) => {
    if (row.status === 'recorded') {
      return c.json({ ok: true, status: 'recorded', erp_payment_ref: row.erp_payment_id, so_no: row.so_doc_no, idempotent: true }, 200);
    }
    if (row.status === 'needs_manual') {
      return c.json({ ok: true, status: 'needs_manual', erp_payment_ref: null, so_no: null, reason: row.error ?? 'queued for manual linking', idempotent: true }, 202);
    }
    // 'processing' — a concurrent push with this id is in flight; retry later.
    return c.json({ ok: false, status: 'processing', error: 'processing', reason: 'a push with this connect_payment_id is being processed' }, 409);
  };

  // ── Idempotency: claim the connect_payment_id ───────────────────────────────
  const { data: existing, error: exErr } = await sb
    .from('connect_payment_pushes')
    .select('status, so_doc_no, erp_payment_id, error')
    .eq('connect_payment_id', p.connect_payment_id)
    .maybeSingle();
  if (exErr) return c.json({ ok: false, error: 'lookup_failed', reason: exErr.message }, 502);

  if (existing && (existing as PushRow).status !== 'failed') {
    return replay(existing as PushRow);
  }

  // Everything the push carries, MINUS the base64 bytes (the slip lives in R2 by
  // key — a 20MB blob has no business in a jsonb column).
  const { slip_base64: _omitBytes, ...payloadMeta } = p;
  if (!existing) {
    const { error: insErr } = await sb.from('connect_payment_pushes').insert({
      connect_payment_id: p.connect_payment_id,
      company_id:         p.erp_company_id,
      status:             'processing',
      order_ref:          p.order_ref,
      customer_phone:     p.customer_phone ?? null,
      customer_name:      p.customer_name ?? null,
      amount_sen:         amountSen,
      currency:           p.currency ?? null,
      method:             p.method,
      bank:               p.bank ?? null,
      online_type:        p.online_type ?? null,
      installment_months: p.installment_months ?? null,
      approval_code:      p.approval_code ?? null,
      reference:          p.reference ?? null,
      paid_at:            p.paid_at,
      payload:            payloadMeta,
    });
    if (insErr) {
      // Unique violation = a concurrent request claimed it first. Re-read and
      // return its state; a raced 'failed' (or an unreadable re-read) is a 502
      // so a later retry re-processes it rather than double-booking now.
      const { data: raced, error: racedErr } = await sb
        .from('connect_payment_pushes')
        .select('status, so_doc_no, erp_payment_id, error')
        .eq('connect_payment_id', p.connect_payment_id)
        .maybeSingle();
      if (racedErr) return c.json({ ok: false, error: 'lookup_failed', reason: racedErr.message }, 502);
      if (raced && (raced as PushRow).status !== 'failed') return replay(raced as PushRow);
      return c.json({ ok: false, error: 'insert_failed', reason: insErr.message }, 502);
    }
  } else {
    // Retrying a prior 'failed' row — reclaim it as processing.
    await sb.from('connect_payment_pushes')
      .update({ status: 'processing', error: null, updated_at: new Date().toISOString() })
      .eq('connect_payment_id', p.connect_payment_id);
  }

  // Settle the claimed row to its outcome and answer Connect. Best-effort update:
  // a booked payment must still be reported even if the ledger write hiccups
  // (the row then reads 'processing' — a stale push-ledger row, not a lost
  // payment; logged for ops).
  const settle = async (
    status: 'recorded' | 'needs_manual' | 'failed',
    extra: { soNo?: string | null; erpPaymentId?: string | null; slipKey?: string | null; reason?: string | null },
  ) => {
    const { error: upErr } = await sb.from('connect_payment_pushes').update({
      status,
      ...(extra.soNo !== undefined ? { so_doc_no: extra.soNo } : {}),
      ...(extra.erpPaymentId !== undefined ? { erp_payment_id: extra.erpPaymentId } : {}),
      ...(extra.slipKey !== undefined ? { slip_key: extra.slipKey } : {}),
      ...(extra.reason !== undefined ? { error: extra.reason } : {}),
      updated_at: new Date().toISOString(),
    }).eq('connect_payment_id', p.connect_payment_id);
    if (upErr) {
      // eslint-disable-next-line no-console
      console.error('[connect-payments] push-ledger update failed:', p.connect_payment_id, status, upErr.message);
    }
    if (status === 'recorded') {
      return c.json({ ok: true, status, erp_payment_ref: extra.erpPaymentId ?? null, so_no: extra.soNo ?? null }, 200);
    }
    if (status === 'needs_manual') {
      return c.json({ ok: true, status, erp_payment_ref: null, so_no: null, reason: extra.reason ?? null }, 202);
    }
    return c.json({ ok: false, status, error: 'record_failed', reason: extra.reason ?? null }, 502);
  };

  // ── Store the slip to the R2 SLIPS bucket (same bucket + key shape as the
  // interactive slip flow). Its key rides onto the payment row, OR onto the
  // needs_manual queue row so a human linking it later has the proof. ──────────
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch { return settle('failed', { reason: 'R2 SLIPS binding not configured' }); }
  const slipKey = buildSlipKey(crypto.randomUUID(), p.slip_mime);
  try {
    await bindings.bucket.put(slipKey, slipBytes, { httpMetadata: { contentType: p.slip_mime } });
  } catch (e) {
    return settle('failed', { reason: `slip store failed: ${(e as Error).message}` });
  }

  // ── Resolve the Sales Order (doc_no OR AutoCount number, scoped to the pushed
  // company). Two parameterised .eq reads (never string-interpolated into .or),
  // merged + deduped by doc_no, then classified: exactly one wins. ────────────
  const sel = 'doc_no, linked_ac_docno';
  const [byDocRes, byLinkedRes] = await Promise.all([
    sb.from('mfg_sales_orders').select(sel).eq('company_id', p.erp_company_id).eq('doc_no', p.order_ref).limit(5),
    sb.from('mfg_sales_orders').select(sel).eq('company_id', p.erp_company_id).eq('linked_ac_docno', p.order_ref).limit(5),
  ]);
  if (byDocRes.error) return settle('failed', { slipKey, reason: `SO lookup failed: ${byDocRes.error.message}` });
  if (byLinkedRes.error) return settle('failed', { slipKey, reason: `SO lookup failed: ${byLinkedRes.error.message}` });
  const seen = new Set<string>();
  const hits: SoMatchRow[] = [];
  // Both reads succeeded (the error guards above returned otherwise), so each
  // `.data` is a row array, never null.
  for (const r of [...byDocRes.data, ...byLinkedRes.data] as SoMatchRow[]) {
    if (!seen.has(r.doc_no)) { seen.add(r.doc_no); hits.push(r); }
  }
  const match = classifySoMatch(hits, p.order_ref);
  if (!match.ok) return settle('needs_manual', { slipKey, reason: match.reason });

  // ── Snap bank / online sub-type to the live active vocabulary (never invent).
  // A merchant payment needs a bank, an online payment needs a sub-type
  // (lib/payment-method-fields) — a missing or off-list value is a human's to
  // resolve, not ours to guess. ──────────────────────────────────────────────
  let merchantProvider: string | null = null;
  let onlineType: string | null = null;
  if (methodCode === 'merchant' || methodCode === 'transfer') {
    const { options, error: vocabErr } = await loadPaymentOptions(sb, p.erp_company_id);
    if (vocabErr) return settle('failed', { slipKey, reason: `payment vocabulary read failed: ${vocabErr.message}` });
    if (methodCode === 'merchant') {
      merchantProvider = snapPaymentOption(options.payment_merchant, p.bank);
      if (!merchantProvider) {
        return settle('needs_manual', { slipKey, reason: `bank "${p.bank ?? ''}" is not in the live merchant list for this company` });
      }
    } else {
      onlineType = snapPaymentOption(options.online_type, p.online_type);
      if (!onlineType) {
        return settle('needs_manual', { slipKey, reason: `online_type "${p.online_type ?? ''}" is not in the live online sub-type list for this company` });
      }
    }
  }

  // ── Slip-date window (owner's 14-day rule, both ends). Connect's paid_at is
  // the slip's printed date and may be in the past; a date outside the window
  // (or in the future) goes to a human with the backdate right, exactly as a
  // keyed payment would — this endpoint does not hold that right. ─────────────
  const dateVerdict = checkPaymentSlipDate(p.paid_at, todayMyt());
  if (!dateVerdict.ok) return settle('needs_manual', { slipKey, reason: dateVerdict.reason });

  // ── Book it through the ONE writer. recordSoPaymentRow resolves the order's
  // company, inserts the row, and fans out to posting / receipt / deposit
  // invoice / AutoCount / invoice-roll — the whole Payments-panel save. ───────
  const { payment, errorMessage } = await recordSoPaymentRow(sb, {
    docNo:             match.docNo,
    paidAt:            p.paid_at,
    method:            methodCode,
    merchantProvider,
    installmentMonths: methodCode === 'merchant' ? (p.installment_months ?? null) : null,
    onlineType,
    approvalCode:      p.approval_code ?? null,
    amountSen,
    slipKey,
    collectedBy:       null,
    note:              `Recorded from Houzs Connect (connect_payment_id=${p.connect_payment_id}${p.reference ? `; ref ${p.reference}` : ''})`,
    createdBy:         null,
    actorName:         'Houzs Connect',
    auditSource:       'connect',
    auditNote:         `Payment pushed from Houzs Connect; order_ref ${p.order_ref}`,
  });
  if (errorMessage) return settle('failed', { slipKey, reason: errorMessage });

  const erpPaymentId = String((payment as { id?: unknown } | null)?.id ?? '') || null;
  return settle('recorded', { soNo: match.docNo, erpPaymentId, slipKey });
});

export default app;
