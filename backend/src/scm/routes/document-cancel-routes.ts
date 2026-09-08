/* ----------------------------------------------------------------------------
   document-cancel-routes — the request + two-signature approval in front of
   cancelling a Sales Order or a Purchase Order, and the guard that makes the
   two existing cancel endpoints wait for it.

   THE OWNER, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」.

   WHAT IT MOUNTS (routes/../index.ts):

     Sales Order   (rides the scm.sales.orders area guard + migratedSoReadonly)
       GET  /mfg-sales-orders/:docNo/cancel-request            open + history
       POST /mfg-sales-orders/:docNo/cancel-request            { reason }
       POST /mfg-sales-orders/:docNo/cancel-request/approve    level derived from the row
       POST /mfg-sales-orders/:docNo/cancel-request/reject     { reason }
       POST /mfg-sales-orders/:docNo/cancel-request/withdraw

     Purchase Order (rides the scm.procurement.po area guard) — same five under
       /mfg-purchase-orders/:id/cancel-request

     Inbox          GET /cancel-requests?scope=open|all — both documents, this
                    company, newest first (coarse scm.access only: an inbox
                    spanning two areas cannot pick one of them)

     THE GUARD   `cancelApprovalGuard('SO')` on PATCH /mfg-sales-orders/:docNo/status
                 (only when the body says CANCELLED) and `cancelApprovalGuard('PO')`
                 on PATCH /mfg-purchase-orders/:id/cancel. It refuses with
                 `cancel_approval_required` unless the document carries an
                 APPROVED request, lets the existing handler run, and on a 2xx
                 stamps the request EXECUTED. The two cancel handlers are NOT
                 edited: mfg-sales-orders.ts (11,947 lines) and
                 mfg-purchase-orders.ts (4,485) sit on their size ceilings, and
                 a middleware at the mount is the same position the write freeze
                 and the migrated-SO lock occupy — a document-level rule beside
                 the module-level ones, not buried in a route file.

   WHY THE APPROVE DOES NOT CANCEL. Level 2's approve marks the request
   APPROVED and answers `{ execute: true }`; the client then calls the
   document's own cancel route, exactly as the Cancel button always has. The
   cancel keeps every guard it had (downstream lock, version CAS, PWP vouchers,
   customer credit, AutoCount outbox) and this module never re-implements one
   of them. If that call is refused — a Delivery Order was raised while the
   request waited — the request stays APPROVED, the document says so, and
   "Cancel now" retries it. An approval that silently became a cancel with the
   guards skipped would be the worse design.

   IDENTITY. requested_by / l1_by / l2_by are public.users.id of the REAL caller
   (`houzsUser`), never c.get('user').id — the SCM bridge pins that to one
   system staff uuid for everybody, which is how mfg_so_audit_log came to name
   the same actor on every row. Two people have to sign here; the rows must be
   able to tell them apart.
   ---------------------------------------------------------------------------- */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { hasHouzsPerm, canViewAllSales } from '../lib/houzs-perms';
import { salesDocOutOfScope } from '../lib/salesScope';
import {
  NOT_THIS_COMPANY,
  activeCompanyId,
  requireActiveCompanyId,
  scopeToCompany,
  scopeToCompanyId,
} from '../lib/companyScope';
import { poHasDownstream, soHasDownstream } from '../lib/downstream-lock';
import { recordSoAudit } from '../lib/so-audit';
import { recordEntityAudit } from '../lib/entity-audit';
import { notifyCancelRequest } from '../../services/cancelRequestNotify';
import {
  OPEN_CANCEL_STATUSES,
  approvalRefusal,
  cancelNeedsApproval,
  cancelRequestRefusal,
  executionRefusal,
  isOpenCancelStatus,
  readReason,
  rejectRefusal,
  statusAfterApproval,
  withdrawRefusal,
  type CancelDocType,
  type CancelRequestLike,
  type Signer,
} from '../shared/document-cancel';

export const CANCEL_REQUESTS_TABLE = 'document_cancel_requests';

type DocConfig = {
  table: string;
  keyColumn: string;
  param: string;
  numberColumn: string;
  /** Extra columns the scope check needs (the SO's salesperson). */
  extraSelect: string;
};

const DOCS: Record<CancelDocType, DocConfig> = {
  SO: { table: 'mfg_sales_orders', keyColumn: 'doc_no', param: 'docNo', numberColumn: 'doc_no', extraSelect: ', salesperson_id' },
  PO: { table: 'purchase_orders', keyColumn: 'id', param: 'id', numberColumn: 'po_number', extraSelect: '' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM routers share one loosely-typed Hono context; see document-hold-route.ts
type AnyCtx = any;

const nowIso = () => new Date().toISOString();

const actorOf = (c: AnyCtx): { id: number | null; name: string | null } => {
  const hu = c.get('houzsUser');
  return { id: hu?.id ?? null, name: hu?.name ?? null };
};

const signerOf = (c: AnyCtx): Signer => ({
  userId: c.get('houzsUser')?.id ?? null,
  holds: (perm) => hasHouzsPerm(c, perm),
});

type DocRow = { key: string; number: string; status: string };

/** Read the document inside the active company, answering the reason it could
 *  not be read. A sales order also honours the salesperson row-scope the rest
 *  of its route family applies (a rep sees only their own orders). */
async function loadDoc(c: AnyCtx, docType: CancelDocType, key: string): Promise<{ ok: true; doc: DocRow; companyId: number } | { ok: false; res: Response }> {
  const cfg = DOCS[docType];
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, res: c.json(co.refusal, 409) };
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    sb.from(cfg.table).select(`${cfg.keyColumn}, ${cfg.numberColumn}, status${cfg.extraSelect}`).eq(cfg.keyColumn, key),
    co.companyId,
  ).maybeSingle();
  if (error) return { ok: false, res: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { ok: false, res: c.json(NOT_THIS_COMPANY, 404) };
  if (docType === 'SO' && !canViewAllSales(c)) {
    const sp = (data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, sp)) {
      return { ok: false, res: c.json(NOT_THIS_COMPANY, 404) };
    }
  }
  const row = data as Record<string, unknown>;
  return {
    ok: true,
    companyId: co.companyId,
    doc: { key: String(row[cfg.keyColumn]), number: String(row[cfg.numberColumn] ?? row[cfg.keyColumn]), status: String(row.status ?? '') },
  };
}

/** The columns the gates read off an open request, plus everything else the
 *  row carries for the audit / notice copy. */
type OpenRequestRow = CancelRequestLike & {
  id: string;
  reason?: string | null;
  requested_by_name?: string | null;
  [column: string]: unknown;
};

async function loadOpenRequest(sb: AnyCtx, docType: CancelDocType, key: string, companyId: number): Promise<OpenRequestRow | null> {
  const { data, error } = await sb
    .from(CANCEL_REQUESTS_TABLE)
    .select('*')
    .eq('company_id', companyId)
    .eq('doc_type', docType)
    .eq('doc_key', key)
    .in('status', [...OPEN_CANCEL_STATUSES])
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as OpenRequestRow | null;
}

/** One audit row per step, on the document's own history. The SO has its own
 *  log (mfg_so_audit_log) and the PO rides entity_audit_log; both are
 *  best-effort here — the request row is the record, the history is the echo. */
async function audit(c: AnyCtx, docType: CancelDocType, doc: DocRow, action: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REJECT' | 'WITHDRAW_FROM_APPROVAL', note: string) {
  const sb = c.get('supabase');
  const actor = actorOf(c);
  if (docType === 'SO') {
    await recordSoAudit(sb, {
      docNo: doc.key,
      action: `CANCEL_${action}`,
      actorId: c.get('user')?.id ?? null,
      actorName: actor.name,
      statusSnapshot: doc.status,
      note,
    });
    return;
  }
  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId: doc.key,
    entityDocNo: doc.number,
    action,
    actor: { id: actor.id, name: actor.name, email: c.get('houzsUser')?.email ?? null },
    companyId: activeCompanyId(c) ?? null,
    statusSnapshot: doc.status,
    note: `Cancellation: ${note}`,
  });
}

/* ── Handlers ────────────────────────────────────────────────────────────── */

export function getCancelRequestHandler(docType: CancelDocType) {
  return async (c: AnyCtx) => {
    const loaded = await loadDoc(c, docType, c.req.param(DOCS[docType].param));
    if (!loaded.ok) return loaded.res;
    const sb = c.get('supabase');
    const { data, error } = await sb
      .from(CANCEL_REQUESTS_TABLE)
      .select('*')
      .eq('company_id', loaded.companyId)
      .eq('doc_type', docType)
      .eq('doc_key', loaded.doc.key)
      .order('requested_at', { ascending: false })
      .limit(20);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const open = rows.find((r) => isOpenCancelStatus(String(r.status))) ?? null;
    return c.json({ open, history: rows, needsApproval: cancelNeedsApproval(docType, loaded.doc.status) });
  };
}

export function requestCancelHandler(docType: CancelDocType) {
  return async (c: AnyCtx) => {
    let body: { reason?: unknown } = {};
    try { body = (await c.req.json()) ?? {}; } catch { return c.json({ error: 'invalid_json' }, 400); }
    const reason = readReason(body.reason);
    if (!reason.ok) return c.json(reason.refusal, 400);

    const loaded = await loadDoc(c, docType, c.req.param(DOCS[docType].param));
    if (!loaded.ok) return loaded.res;
    const { doc, companyId } = loaded;

    const why = cancelRequestRefusal(docType, doc.status);
    if (why) return c.json(why, 409);

    /* Fail at the door, not after two people signed: a document that already
       has a live child cannot be cancelled, so there is nothing to approve. */
    const sb = c.get('supabase');
    const locked = docType === 'SO' ? await soHasDownstream(sb, doc.key) : await poHasDownstream(sb, doc.key);
    if (locked) return c.json(locked, 409);

    if (await loadOpenRequest(sb, docType, doc.key, companyId)) {
      return c.json({ error: 'cancel_request_open', message: 'A cancellation request is already open on this document.' }, 409);
    }

    const actor = actorOf(c);
    if (actor.id == null) return c.json({ error: 'caller_unknown', message: 'Could not identify who is raising this request.' }, 403);
    const { data: created, error } = await sb
      .from(CANCEL_REQUESTS_TABLE)
      .insert({
        company_id: companyId,
        doc_type: docType,
        doc_key: doc.key,
        doc_number: doc.number,
        doc_status_at_request: doc.status,
        status: 'REQUESTED',
        reason: reason.reason,
        requested_by: actor.id,
        requested_by_name: actor.name,
        requested_at: nowIso(),
      })
      .select('*')
      .single();
    if (error) {
      /* The partial unique index is the floor under the read above. */
      const dup = /uq_document_cancel_request_open|duplicate key/i.test(String(error.message ?? ''));
      return dup
        ? c.json({ error: 'cancel_request_open', message: 'A cancellation request is already open on this document.' }, 409)
        : c.json({ error: 'create_failed', reason: error.message }, 500);
    }

    await audit(c, docType, doc, 'SUBMIT_FOR_APPROVAL', reason.reason);
    await notifyCancelRequest(c.env, 'raised', {
      docType, docNumber: doc.number, reason: reason.reason, companyId,
      requesterUserId: actor.id, requesterName: actor.name, actorUserId: actor.id,
    });
    return c.json({ request: created }, 201);
  };
}

export function approveCancelHandler(docType: CancelDocType) {
  return async (c: AnyCtx) => {
    const loaded = await loadDoc(c, docType, c.req.param(DOCS[docType].param));
    if (!loaded.ok) return loaded.res;
    const { doc, companyId } = loaded;
    const sb = c.get('supabase');

    const open = await loadOpenRequest(sb, docType, doc.key, companyId);
    if (!open) return c.json({ error: 'no_open_request', message: 'There is no open cancellation request on this document.' }, 404);

    const verdict = approvalRefusal(open, signerOf(c));
    if ('refusal' in verdict) {
      const { httpStatus, ...refusal } = verdict.refusal;
      return c.json(refusal, httpStatus);
    }
    const { level } = verdict;
    const actor = actorOf(c);
    const at = nowIso();
    const patch: Record<string, unknown> = { status: statusAfterApproval(level), updated_at: at };
    patch[`l${level}_by`] = actor.id;
    patch[`l${level}_by_name`] = actor.name;
    patch[`l${level}_at`] = at;

    /* CAS on the status the decision was made against — two approvers pressing
       the same button land one signature, not two on one level. */
    const { data: updated, error } = await sb
      .from(CANCEL_REQUESTS_TABLE)
      .update(patch)
      .eq('id', open.id)
      .eq('status', open.status)
      .select('*')
      .maybeSingle();
    if (error) return c.json({ error: 'approve_failed', reason: error.message }, 500);
    if (!updated) return c.json({ error: 'stale', message: 'This request changed while you were looking at it — reload and try again.' }, 409);

    await audit(c, docType, doc, 'APPROVE', `level ${level} of 2 approved`);
    await notifyCancelRequest(c.env, level === 1 ? 'level1' : 'approved', {
      docType, docNumber: doc.number, reason: String(open.reason ?? ''), companyId,
      requesterUserId: Number(open.requested_by) || null, requesterName: (open.requested_by_name as string | null) ?? null,
      actorUserId: actor.id, actorName: actor.name,
    });
    return c.json({ request: updated, execute: level === 2 });
  };
}

export function rejectCancelHandler(docType: CancelDocType) {
  return async (c: AnyCtx) => {
    let body: { reason?: unknown } = {};
    try { body = (await c.req.json()) ?? {}; } catch { return c.json({ error: 'invalid_json' }, 400); }
    const reason = readReason(body.reason);
    if (!reason.ok) return c.json(reason.refusal, 400);

    const loaded = await loadDoc(c, docType, c.req.param(DOCS[docType].param));
    if (!loaded.ok) return loaded.res;
    const { doc, companyId } = loaded;
    const sb = c.get('supabase');

    const open = await loadOpenRequest(sb, docType, doc.key, companyId);
    if (!open) return c.json({ error: 'no_open_request', message: 'There is no open cancellation request on this document.' }, 404);
    const refusal = rejectRefusal(open, signerOf(c));
    if (refusal) { const { httpStatus, ...rest } = refusal; return c.json(rest, httpStatus); }

    const actor = actorOf(c);
    const at = nowIso();
    const { data: updated, error } = await sb
      .from(CANCEL_REQUESTS_TABLE)
      .update({ status: 'REJECTED', rejected_by: actor.id, rejected_by_name: actor.name, rejected_at: at, reject_reason: reason.reason, updated_at: at })
      .eq('id', open.id)
      .eq('status', open.status)
      .select('*')
      .maybeSingle();
    if (error) return c.json({ error: 'reject_failed', reason: error.message }, 500);
    if (!updated) return c.json({ error: 'stale', message: 'This request changed while you were looking at it — reload and try again.' }, 409);

    await audit(c, docType, doc, 'REJECT', reason.reason);
    await notifyCancelRequest(c.env, 'rejected', {
      docType, docNumber: doc.number, reason: reason.reason, companyId,
      requesterUserId: Number(open.requested_by) || null, requesterName: (open.requested_by_name as string | null) ?? null,
      actorUserId: actor.id, actorName: actor.name,
    });
    return c.json({ request: updated });
  };
}

export function withdrawCancelHandler(docType: CancelDocType) {
  return async (c: AnyCtx) => {
    const loaded = await loadDoc(c, docType, c.req.param(DOCS[docType].param));
    if (!loaded.ok) return loaded.res;
    const { doc, companyId } = loaded;
    const sb = c.get('supabase');

    const open = await loadOpenRequest(sb, docType, doc.key, companyId);
    if (!open) return c.json({ error: 'no_open_request', message: 'There is no open cancellation request on this document.' }, 404);
    const refusal = withdrawRefusal(open, signerOf(c));
    if (refusal) { const { httpStatus, ...rest } = refusal; return c.json(rest, httpStatus); }

    const at = nowIso();
    const { data: updated, error } = await sb
      .from(CANCEL_REQUESTS_TABLE)
      .update({ status: 'WITHDRAWN', updated_at: at })
      .eq('id', open.id)
      .eq('status', open.status)
      .select('*')
      .maybeSingle();
    if (error) return c.json({ error: 'withdraw_failed', reason: error.message }, 500);
    if (!updated) return c.json({ error: 'stale', message: 'This request changed while you were looking at it — reload and try again.' }, 409);

    await audit(c, docType, doc, 'WITHDRAW_FROM_APPROVAL', 'request withdrawn');
    /* Withdraw stays silent, as the amendment withdraw does: the requester
       pulling their own request back is not news to the people it was for. */
    return c.json({ request: updated });
  };
}

/** GET /cancel-requests?scope=open|all — the inbox, both documents. */
export const listCancelRequestsHandler = async (c: AnyCtx) => {
  const sb = c.get('supabase');
  const scope = String(c.req.query('scope') ?? 'open');
  let q = sb.from(CANCEL_REQUESTS_TABLE).select('*');
  if (scope !== 'all') q = q.in('status', [...OPEN_CANCEL_STATUSES]);
  const { data, error } = await scopeToCompany(q, c).order('requested_at', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ requests: data ?? [] });
};

/* ── Routers ─────────────────────────────────────────────────────────────── */

/* The two routers are written out route by route rather than built from a
   factory: scripts/generate-route-capability-matrix.mjs reads registrations
   STATICALLY (a literal path on an exported router identifier) and refuses a
   mounted router it cannot see into — the path family is the audit surface. */

/** Mounted at /mfg-sales-orders — same prefix, same area guard as the SO router. */
export const soCancelRequests = new Hono<{ Bindings: Env; Variables: Variables }>();
soCancelRequests.use('*', supabaseAuth);
soCancelRequests.get('/:docNo/cancel-request', getCancelRequestHandler('SO'));
soCancelRequests.post('/:docNo/cancel-request', requestCancelHandler('SO'));
soCancelRequests.post('/:docNo/cancel-request/approve', approveCancelHandler('SO'));
soCancelRequests.post('/:docNo/cancel-request/reject', rejectCancelHandler('SO'));
soCancelRequests.post('/:docNo/cancel-request/withdraw', withdrawCancelHandler('SO'));

/** Mounted at /mfg-purchase-orders — same prefix, same area guard as the PO router. */
export const poCancelRequests = new Hono<{ Bindings: Env; Variables: Variables }>();
poCancelRequests.use('*', supabaseAuth);
poCancelRequests.get('/:id/cancel-request', getCancelRequestHandler('PO'));
poCancelRequests.post('/:id/cancel-request', requestCancelHandler('PO'));
poCancelRequests.post('/:id/cancel-request/approve', approveCancelHandler('PO'));
poCancelRequests.post('/:id/cancel-request/reject', rejectCancelHandler('PO'));
poCancelRequests.post('/:id/cancel-request/withdraw', withdrawCancelHandler('PO'));

/** Mounted at /cancel-requests. */
export const cancelRequestsInbox = new Hono<{ Bindings: Env; Variables: Variables }>();
cancelRequestsInbox.use('*', supabaseAuth);
cancelRequestsInbox.get('/', listCancelRequestsHandler);

/* ── The guard in front of the cancel itself ─────────────────────────────── */

/**
 * Middleware for the two existing cancel endpoints. Passes everything that is
 * not a cancel straight through (the SO status route carries every other
 * transition too), passes a DRAFT through (discarded, never approved), and
 * otherwise refuses unless the document carries an APPROVED request. After the
 * handler answers 2xx the request is stamped EXECUTED — by the guard, because
 * the handler is the one file this feature deliberately does not edit.
 *
 * It answers nothing the handler would answer better: an unresolved company or
 * an unknown document falls through so the handler's own 409/404 stands.
 */
export function cancelApprovalGuard(docType: CancelDocType): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  const cfg = DOCS[docType];
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    if (c.req.method.toUpperCase() !== 'PATCH') return next();
    if (docType === 'SO') {
      /* Hono caches the parsed body, so the handler's own c.req.json() gets the
         same object back; a body that is not JSON is the handler's 400 to give. */
      let body: { status?: unknown } = {};
      try { body = ((await c.req.json()) as { status?: unknown } | null) ?? {}; } catch { return next(); }
      if (String(body.status ?? '').toUpperCase() !== 'CANCELLED') return next();
    }
    const key = (c.req.param() as Record<string, string | undefined>)[cfg.param];
    if (!key) return next();
    const co = requireActiveCompanyId(c as AnyCtx);
    if (!co.ok) return next();
    const sb = (c as AnyCtx).get('supabase');
    const { data: doc, error: docErr } = await scopeToCompanyId(sb.from(cfg.table).select('status').eq(cfg.keyColumn, key), co.companyId).maybeSingle();
    /* A read that FAILED is not "no such document": say so rather than let the
       cancel through on a blip (the swallowed-reads gate's whole point). */
    if (docErr) return c.json({ error: 'load_failed', reason: docErr.message }, 500);
    if (!doc) return next();
    if (!cancelNeedsApproval(docType, (doc as { status?: string }).status)) return next();

    const open = await loadOpenRequest(sb, docType, key, co.companyId);
    const refusal = executionRefusal(open);
    if (refusal) return c.json(refusal, 403);

    await next();

    if (c.res.ok && open) {
      const at = nowIso();
      await sb
        .from(CANCEL_REQUESTS_TABLE)
        .update({ status: 'EXECUTED', executed_at: at, executed_by: actorOf(c).id, updated_at: at })
        .eq('id', open.id)
        .eq('status', 'APPROVED');
    }
  };
}
