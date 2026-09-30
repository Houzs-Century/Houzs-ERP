/* ----------------------------------------------------------------------------
   so-payment-backdate-requests — a Sales Order payment whose slip date is more
   than 14 days old, keyed in as a REQUEST that an admin approves.

   THE OWNER, 2026-09-30: 「balance collection 需要 request key in 如果是超过14天
   from today - 只有 admin 可以看到 request」. Since #4240 (2026-09-23) such a
   payment was simply refused unless the caller held `scm.payment.backdate`. The
   money is real, so the refusal becomes a request: the collector keys the same
   payment plus a reason, and a holder of `scm.payment.backdate` ("admin" —
   Owner / IT Admin through `*`) approves it, which books it through the one write
   core (recordSoPaymentRow), or rejects it. Nothing counts toward the order's
   paid total until then — the request is its own table, never a payments row.

   WHAT IT MOUNTS (scm/index.ts):

     Sales Order  (rides the scm.sales.orders area guard + the migrated-SO lock)
       GET  /mfg-sales-orders/:docNo/payment-backdate-requests
              an admin reads every request on the order; anyone else only their own
       POST /mfg-sales-orders/:docNo/payment-backdate-requests
              the payment body POST /:docNo/payments takes, plus { reason }
       POST /mfg-sales-orders/:docNo/payment-backdate-requests/:id/withdraw
              the requester, or an admin

     Inbox        (admin only — scm.payment.backdate)
       GET  /payment-backdate-requests?scope=open|all
       GET  /payment-backdate-requests/pending-count  the sidebar badge; 0 for non-admins
       POST /payment-backdate-requests/:id/approve   { note? }
       POST /payment-backdate-requests/:id/reject    { note }

   ONLY THE TOO-OLD HALF IS REQUESTABLE. A future date is a typo, not a late
   slip, so it keeps its refusal; a date inside the window needs no request and
   is refused here so nobody parks money that should simply be recorded.

   IDENTITY. requested_by / decided_by are public.users.id of the REAL caller
   (`houzsUser`), never c.get('user').id — the SCM bridge pins that to one system
   staff uuid for everybody (see document-cancel-routes.ts).
   ---------------------------------------------------------------------------- */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { checkPaymentSlipDate } from '../shared/payment-slip-date';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { fmtSen } from '../shared/format';
import { recordSoPaymentRow } from '../lib/so-payment-row';
import { recordSoAudit } from '../lib/so-audit';
import { paymentMethodFieldRefusal } from '../lib/payment-method-fields';
import { SO_PAYMENT_BACKDATE } from '../../acc/payment-reconciled';
import { selfScopedSalesBlocked } from '../lib/so-self-scope';
import { notifyBackdateRequest } from '../../services/backdateRequestNotify';

export const BACKDATE_REQUESTS_TABLE = 'so_payment_backdate_requests';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM routers share one loosely-typed Hono context; see document-cancel-routes.ts
type AnyCtx = any;

const nowIso = () => new Date().toISOString();

const actorOf = (c: AnyCtx): { id: number | null; name: string | null } => {
  const hu = c.get('houzsUser');
  const id = Number(hu?.id);
  return Number.isInteger(id) && id > 0 ? { id, name: hu?.name ?? null } : { id: null, name: null };
};

const isAdmin = (c: AnyCtx): boolean => hasHouzsPerm(c, SO_PAYMENT_BACKDATE);

const requestSchema = z.object({
  paidAt:            z.string().min(1),
  method:            z.enum(PAYMENT_METHOD_CODES),
  merchantProvider:  z.string().trim().min(1).optional().nullable(),
  installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
  onlineType:        z.string().trim().min(1).optional().nullable(),
  approvalCode:      z.string().optional().nullable(),
  amountSen:         z.number().int().positive(),
  accountSheet:      z.string().optional().nullable(),
  collectedBy:       z.string().uuid().optional().nullable(),
  note:              z.string().optional().nullable(),
  uploadSessionId:   z.string().min(1).optional().nullable(),
  reason:            z.string().trim().min(5, 'Say why this slip is being keyed in late (at least 5 characters).').max(500),
});

const readNote = async (c: AnyCtx): Promise<string> => {
  try {
    const b = (await c.req.json()) as { note?: unknown } | null;
    return typeof b?.note === 'string' ? b.note.trim().slice(0, 500) : '';
  } catch { return ''; }
};

/* ── Per-order routes ─────────────────────────────────────────────────────── */

export const soPaymentBackdateRequests = new Hono<{ Bindings: Env; Variables: Variables }>();
soPaymentBackdateRequests.use('*', supabaseAuth);

soPaymentBackdateRequests.get('/:docNo/payment-backdate-requests', async (c: AnyCtx) => {
  const docNo = c.req.param('docNo');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const sb = c.get('supabase');
  let q = scopeToCompany(sb.from(BACKDATE_REQUESTS_TABLE).select('*').eq('so_doc_no', docNo), c);
  /* 「只有 admin 可以看到 request」 — everyone else sees only what they raised. */
  if (!isAdmin(c)) {
    const actor = actorOf(c);
    if (actor.id == null) return c.json({ requests: [], isAdmin: false });
    q = q.eq('requested_by', actor.id);
  }
  const { data, error } = await q.order('requested_at', { ascending: false }).limit(50);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ requests: data ?? [], isAdmin: isAdmin(c) });
});

soPaymentBackdateRequests.post('/:docNo/payment-backdate-requests', async (c: AnyCtx) => {
  const docNo = c.req.param('docNo');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find((i) => i.path[0] === 'reason');
    return reasonIssue
      ? c.json({ error: 'reason_required', reason: reasonIssue.message }, 400)
      : c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  const verdict = checkPaymentSlipDate(p.paidAt, todayMyt());
  if (verdict.ok) {
    return c.json({ error: 'no_request_needed', reason: 'This slip date is inside the 14-day window. Record the payment directly.' }, 409);
  }
  if (verdict.code !== 'too_old') return c.json({ error: 'slip_date_out_of_window', reason: verdict.reason }, 400);

  const methodRefusal = paymentMethodFieldRefusal(p);
  if (methodRefusal) return c.json(methodRefusal, 400);

  const actor = actorOf(c);
  if (actor.id == null) return c.json({ error: 'caller_unknown', message: 'Could not identify who is raising this request.' }, 403);

  const sb = c.get('supabase');
  let slipKey: string | null = null;
  if (p.uploadSessionId) {
    const { data: slipRow, error: slipErr } = await sb
      .from('pending_slip_uploads')
      .select('r2_key, status')
      .eq('upload_session_id', p.uploadSessionId)
      .maybeSingle();
    if (slipErr) return c.json({ error: 'lookup_failed', reason: slipErr.message }, 500);
    const s = slipRow as { r2_key: string | null; status: string } | null;
    if (!s || s.status !== 'uploaded' || !s.r2_key) {
      return c.json({
        error: 'slip_required',
        reason: "That payment slip hasn't finished uploading. Attach it again, or send the request without one.",
      }, 400);
    }
    slipKey = s.r2_key;
  }

  const merchantLike = p.method === 'merchant' || p.method === 'installment';
  const { data: created, error } = await sb
    .from(BACKDATE_REQUESTS_TABLE)
    .insert({
      company_id: co.companyId,
      so_doc_no: docNo,
      status: 'REQUESTED',
      reason: p.reason,
      paid_at: dateOrNull(p.paidAt.slice(0, 10)),
      method: p.method,
      merchant_provider: merchantLike ? (p.merchantProvider ?? null) : null,
      installment_months: merchantLike ? (p.installmentMonths ?? null) : null,
      online_type: p.method === 'transfer' ? (p.onlineType ?? null) : null,
      approval_code: p.approvalCode ?? null,
      amount_sen: p.amountSen,
      account_sheet: p.accountSheet ?? null,
      collected_by: p.collectedBy ?? null,
      note: p.note ?? null,
      slip_key: slipKey,
      requested_by: actor.id,
      requested_by_name: actor.name,
      requested_at: nowIso(),
    })
    .select('*')
    .single();
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);

  /* Promote the slip so the reaper leaves it for the approval — the same dance
     as the payments route; the request row already holds the key either way. */
  if (p.uploadSessionId) {
    const { error: promoteErr } = await sb
      .from('pending_slip_uploads')
      .update({ status: 'promoted', promoted_at: nowIso() })
      .eq('upload_session_id', p.uploadSessionId);
    // eslint-disable-next-line no-console
    if (promoteErr) console.error(`[backdate-request] slip promote FAILED for session ${p.uploadSessionId} on ${docNo}: ${promoteErr.message}`);
  }

  await recordSoAudit(sb, {
    docNo,
    action: 'PAYMENT_BACKDATE_REQUESTED',
    actorName: actor.name,
    note: `${fmtSen(p.amountSen)} dated ${p.paidAt.slice(0, 10)} — ${p.reason}`,
  });
  await notifyBackdateRequest(c.env, 'raised', {
    docNo, amount: fmtSen(p.amountSen), slipDate: p.paidAt.slice(0, 10), reason: p.reason,
    companyId: co.companyId, requesterUserId: actor.id, requesterName: actor.name, actorUserId: actor.id,
  });
  return c.json({ request: created }, 201);
});

/* ── Inbox (admin) ────────────────────────────────────────────────────────── */

export const paymentBackdateInbox = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentBackdateInbox.use('*', supabaseAuth);

const ADMIN_ONLY = { error: 'forbidden', reason: 'Only an admin can see payment backdate requests.' };

/* The red count on the sidebar entry (owner 2026-09-30: 「sidebar 红点」). An
   admin by the same rule as every handler here — `*` counts, deliberately (see
   services/backdateRequestNotify.ts) — and 0 for anyone else, so the badge
   never shows a number its reader cannot clear. */
paymentBackdateInbox.get('/pending-count', async (c: AnyCtx) => {
  if (!isAdmin(c)) return c.json({ count: 0 });
  const { count, error } = await scopeToCompany(
    c.get('supabase').from(BACKDATE_REQUESTS_TABLE).select('id', { count: 'exact', head: true }).eq('status', 'REQUESTED'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ count: count ?? 0 });
});

paymentBackdateInbox.get('/', async (c: AnyCtx) => {
  if (!isAdmin(c)) return c.json(ADMIN_ONLY, 403);
  const sb = c.get('supabase');
  let q = sb.from(BACKDATE_REQUESTS_TABLE).select('*');
  if (String(c.req.query('scope') ?? 'open') !== 'all') q = q.eq('status', 'REQUESTED');
  const { data, error } = await scopeToCompany(q, c).order('requested_at', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ requests: data ?? [] });
});

type RequestRow = {
  id: string; company_id: number; so_doc_no: string; status: string; reason: string; paid_at: string; method: string;
  merchant_provider: string | null; installment_months: number | null; online_type: string | null;
  approval_code: string | null; amount_sen: number; account_sheet: string | null; collected_by: string | null;
  note: string | null; slip_key: string | null; requested_by: number; requested_by_name: string | null;
};

async function loadRequest(c: AnyCtx): Promise<{ ok: true; row: RequestRow } | { ok: false; res: Response }> {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, res: c.json(co.refusal, 409) };
  const { data, error } = await scopeToCompanyId(
    c.get('supabase').from(BACKDATE_REQUESTS_TABLE).select('*').eq('id', c.req.param('id')),
    co.companyId,
  ).maybeSingle();
  if (error) return { ok: false, res: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { ok: false, res: c.json(NOT_THIS_COMPANY, 404) };
  return { ok: true, row: data as RequestRow };
}

const NOT_OPEN = { error: 'request_not_open', reason: 'This request has already been decided.' };

/** Move a REQUESTED row on, conditionally, so two admins cannot both decide it. */
async function claim(c: AnyCtx, r: Pick<RequestRow, 'id' | 'company_id'>, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await c.get('supabase')
    .from(BACKDATE_REQUESTS_TABLE)
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', r.id)
    .eq('company_id', r.company_id)
    .eq('status', 'REQUESTED')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data != null;
}

paymentBackdateInbox.post('/:id/approve', async (c: AnyCtx) => {
  if (!isAdmin(c)) return c.json(ADMIN_ONLY, 403);
  const loaded = await loadRequest(c);
  if (!loaded.ok) return loaded.res;
  const r = loaded.row;
  if (r.status !== 'REQUESTED') return c.json(NOT_OPEN, 409);
  const note = await readNote(c);
  const actor = actorOf(c);
  const decidedAt = nowIso();
  if (!(await claim(c, r, { status: 'APPROVED', decided_by: actor.id, decided_by_name: actor.name, decided_at: decidedAt, decision_note: note || null }))) {
    return c.json(NOT_OPEN, 409);
  }

  const sb = c.get('supabase');
  const user = c.get('user');
  const { payment, errorMessage } = await recordSoPaymentRow(sb, {
    docNo: r.so_doc_no,
    paidAt: String(r.paid_at).slice(0, 10),
    method: r.method as 'merchant' | 'transfer' | 'cash' | 'installment',
    merchantProvider: r.merchant_provider,
    installmentMonths: r.installment_months,
    onlineType: r.online_type,
    approvalCode: r.approval_code,
    amountSen: Number(r.amount_sen),
    accountSheet: r.account_sheet,
    slipKey: r.slip_key,
    collectedBy: r.collected_by,
    note: r.note,
    createdBy: user?.id ?? null,
    actorName: actor.name,
    allowOutOfWindowSlipDate: true,
    auditNote: `Backdated slip approved by ${actor.name ?? 'admin'} (requested by ${r.requested_by_name ?? 'staff'}): ${r.reason}`,
  });
  if (errorMessage || !payment) {
    /* Hand the row back so it can be approved again once the cause is fixed. */
    const { error: backErr } = await sb.from(BACKDATE_REQUESTS_TABLE)
      .update({ status: 'REQUESTED', decided_by: null, decided_by_name: null, decided_at: null, decision_note: null, updated_at: nowIso() })
      .eq('id', r.id).eq('company_id', r.company_id).eq('status', 'APPROVED');
    // eslint-disable-next-line no-console
    if (backErr) console.error(`[backdate-request] ${r.id} left APPROVED without a payment: ${backErr.message}`);
    return c.json({ error: 'insert_failed', reason: errorMessage ?? 'The payment could not be recorded.' }, 500);
  }
  const paymentId = (payment as { id?: string }).id ?? null;
  /* The payment is booked; a failed link is logged, never un-books it. */
  const { data: updated, error: linkErr } = await sb.from(BACKDATE_REQUESTS_TABLE)
    .update({ payment_id: paymentId, updated_at: nowIso() })
    .eq('id', r.id)
    .eq('company_id', r.company_id)
    .select('*')
    .maybeSingle();
  // eslint-disable-next-line no-console
  if (linkErr) console.error(`[backdate-request] ${r.id} booked payment ${paymentId} but not linked: ${linkErr.message}`);
  await notifyBackdateRequest(c.env, 'approved', {
    docNo: r.so_doc_no, amount: fmtSen(Number(r.amount_sen)), slipDate: String(r.paid_at).slice(0, 10),
    companyId: r.company_id, requesterUserId: Number(r.requested_by), actorUserId: actor.id, actorName: actor.name,
  });
  return c.json({ request: updated ?? { ...r, status: 'APPROVED', payment_id: paymentId }, payment });
});

paymentBackdateInbox.post('/:id/reject', async (c: AnyCtx) => {
  if (!isAdmin(c)) return c.json(ADMIN_ONLY, 403);
  const loaded = await loadRequest(c);
  if (!loaded.ok) return loaded.res;
  const r = loaded.row;
  if (r.status !== 'REQUESTED') return c.json(NOT_OPEN, 409);
  const note = await readNote(c);
  if (note.length < 3) return c.json({ error: 'reason_required', reason: 'Say why the request is rejected.' }, 400);
  const actor = actorOf(c);
  if (!(await claim(c, r, { status: 'REJECTED', decided_by: actor.id, decided_by_name: actor.name, decided_at: nowIso(), decision_note: note }))) {
    return c.json(NOT_OPEN, 409);
  }
  await recordSoAudit(c.get('supabase'), {
    docNo: r.so_doc_no, action: 'PAYMENT_BACKDATE_REJECTED', actorName: actor.name,
    note: `${fmtSen(Number(r.amount_sen))} dated ${String(r.paid_at).slice(0, 10)} — ${note}`,
  });
  await notifyBackdateRequest(c.env, 'rejected', {
    docNo: r.so_doc_no, amount: fmtSen(Number(r.amount_sen)), slipDate: String(r.paid_at).slice(0, 10), reason: note,
    companyId: r.company_id, requesterUserId: Number(r.requested_by), actorUserId: actor.id, actorName: actor.name,
  });
  return c.json({ ok: true });
});

/* On the order's own prefix, not the inbox: the requester who withdraws is
   usually not an admin, and this path already rides the Sales Order guards. */
soPaymentBackdateRequests.post('/:docNo/payment-backdate-requests/:id/withdraw', async (c: AnyCtx) => {
  const docNo = c.req.param('docNo');
  if (await selfScopedSalesBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  const loaded = await loadRequest(c);
  if (!loaded.ok) return loaded.res;
  const r = loaded.row;
  if (r.so_doc_no !== docNo) return c.json({ error: 'not_found' }, 404);
  const actor = actorOf(c);
  const own = actor.id != null && actor.id === Number(r.requested_by);
  if (!own && !isAdmin(c)) return c.json({ error: 'forbidden', reason: 'Only the person who raised this request can withdraw it.' }, 403);
  if (r.status !== 'REQUESTED') return c.json(NOT_OPEN, 409);
  if (!(await claim(c, r, { status: 'WITHDRAWN', decided_by: actor.id, decided_by_name: actor.name, decided_at: nowIso() }))) {
    return c.json(NOT_OPEN, 409);
  }
  return c.json({ ok: true });
});
