// /po-amendments — Purchase Order amendment / revision workflow.
//
// The PO-side sibling of routes/so-amendments.ts, built to the owner's SIMPLIFIED
// model: an amendment is one request and one approval. A purchaser raises a
// change against a Purchase Order (line qty / cost / spec / delivery, add or
// remove a line, or the header supplier / delivery / notes); an authorized
// approver either APPROVES it — which snapshots the current PO into po_revisions,
// applies the diffs in place, bumps purchase_orders.revision, and writes an
// AMENDMENT_PO_APPROVED audit row (lib/po-revision.ts applyPoAmendment) — or
// closes it REJECTED. The requester may WITHDRAW their own still-open request.
//
// There is deliberately NO supplier-confirm / two-gate / send chain here (unlike
// the SO amendment): the whole point of this module is the single-approver gate.
// The pure state machine lives in ../shared/po-amendment.ts.
//
// Gates (hasHouzsPerm against the REAL Houzs caller — the SCM bridge pins
// c.get('user') to one system row, so every finer decision keys off houzsUser):
//   • create  → scm.po_amendment.create
//   • approve → scm.po_amendment.approve
//   • reject  → scm.po_amendment.approve (an approver's refusal)
//   • withdraw→ the requester themselves, or scm.po_amendment.approve
//
// PO amendments are Houzs-NATIVE — there is no 2990 mirror / command dispatch
// here (that machinery is SO-specific), so every handler applies locally.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import type { Context } from 'hono';
import { canTransition, nextStatus, type PoAmendStatus, type PoAmendAction } from '../shared/po-amendment';
import { applyPoAmendment, ReceivedFloorError } from '../lib/po-revision';
import { recomputePoReceived } from './grns';
import { planStockRelease, type AllocationRow } from '../lib/po-allocations';
/* Two-lane rework: a follow-up row's approve re-derives its PO from the SO's
   current truth. po-revision re-exports so-revision's ReceivedFloorError (same
   class), so the one imported above already covers both engines. */
import { reviseBoundPo } from '../lib/so-revision';
import { enqueueEdit } from '../lib/autocount-outbox';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { resolveCallerStaffId, resolveUserIdByStaffId } from '../lib/salesScope';
import {
  notifyPoAmendmentRaised,
  notifyPoAmendmentResolved,
} from '../../services/amendmentNotify';
import {
  recordEntityAudit,
  assertAuditWritable,
  auditUnavailableBody,
} from '../lib/entity-audit';
import {
  scopeToCompany,
  activeCompanyId,
  requireActiveCompanyId,
  stampCompany,
} from '../lib/companyScope';
import { deferScmAfterCommit, runScmPgCommand } from '../lib/pg-supabase-transaction';
import { dateOrNull } from '../lib/date-coerce';

export const poAmendments = new Hono<{ Bindings: Env; Variables: Variables }>();
poAmendments.use('*', supabaseAuth);

/* The gate columns (approved_by / rejected_by) are scm.staff FKs the UI renders
   as "who did this". c.get('user').id is the bridge's pinned system row shared by
   EVERY caller, so stamping it makes them all read as one identity. Resolve the
   caller's real mig-0066 staff row; fall back to the pinned row so the FK stays
   valid when the sync row is missing (identical to so-amendments.gateActorStaffId). */
async function gateActorStaffId(sb: any, houzsUserId: number | null | undefined, fallbackStaffId: string): Promise<string> {
  return (await resolveCallerStaffId(sb, houzsUserId)) ?? fallbackStaffId;
}

type AmendmentForWrite = {
  id: string;
  po_id: string;
  po_number: string;
  amendment_no: string | null;
  status: PoAmendStatus;
  version: number;
  requested_by: string | null;
  /* Two-lane rework (2026-07-27): set on a FOLLOW-UP row auto-raised by an SO
     amendment's LINES-lane apply. Its approve re-derives the PO from the SO's
     CURRENT truth (reviseBoundPo, scoped to this po) instead of applying the
     preview lines; see lib/amendment-po-followup.ts. */
  source_so_amendment_id: string | null;
  source_so_amendment_no: string | null;
};

async function loadAmendmentForWrite(
  sb: any,
  id: string,
  c: Context<any>,
): Promise<{ ok: true; amendment: AmendmentForWrite } | { ok: false }> {
  const { data } = await scopeToCompany(
    sb.from('po_amendments')
      .select('id, po_id, po_number, amendment_no, status, version, requested_by, source_so_amendment_id, source_so_amendment_no')
      .eq('id', id),
    c,
  ).maybeSingle();
  if (!data) return { ok: false };
  return { ok: true, amendment: data as AmendmentForWrite };
}

/* ── GET / — amendment list (newest first) ─────────────────────────────────
   Company-scoped (mig 0192 company_id); a PO is not salesperson-owned, so there
   is no per-rep row scope like the SO amendment list carries. .limit(500) bounds
   the result below PostgREST's default cap (SO/DO/GRN list convention). */
poAmendments.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('po_amendments')
    .select('id, po_id, po_number, amendment_no, status, reason, requested_by, resolution, source_so_amendment_id, source_so_amendment_no, created_at, updated_at'), c)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ amendments: data ?? [] });
});

/* ── GET /:id — amendment detail ───────────────────────────────────────────
   Returns the amendment row + its po_amendment_lines + a light PO header summary
   (po_number, status, revision). */
poAmendments.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [amdRes, lineRes] = await Promise.all([
    scopeToCompany(sb.from('po_amendments')
      .select('id, po_id, po_number, amendment_no, status, reason, requested_by, ' +
        'approved_by, approved_at, rejected_by, rejected_at, rejection_reason, resolution, ' +
        'source_so_amendment_id, source_so_amendment_no, ' +
        'header_changes, old_header_snapshot, edited_at, edit_count, created_at, updated_at')
      .eq('id', id), c).maybeSingle(),
    sb.from('po_amendment_lines')
      .select('id, amendment_id, purchase_order_item_id, change_type, new_item_code, ' +
        'new_material_name, new_variants, new_qty, new_unit_price_sen, new_delivery_date, old_snapshot')
      .eq('amendment_id', id),
  ]);
  if (amdRes.error) return c.json({ error: 'load_failed', reason: amdRes.error.message }, 500);
  if (!amdRes.data) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRes.data as unknown as { po_id: string } & Record<string, unknown>;
  const lines = (lineRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  const { data: poRow } = await sb.from('purchase_orders')
    .select('id, po_number, status, revision, supplier_id, expected_at')
    .eq('id', amendment.po_id).maybeSingle();

  return c.json({ amendment, lines, purchaseOrder: poRow ?? null });
});

/* ── POST / — raise a PO amendment ─────────────────────────────────────────
   Guards, in order:
     1. body has a poId + at least one change (line or header) → else 400
     2. PO exists (company-scoped)                             → else 404
     3. PO is not cancelled                                    → else 409
     4. no OPEN (REQUESTED) amendment on this PO               → else 409
        (the partial unique index uq_po_amendment_open is the DB backstop) */
poAmendments.post('/', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.po_amendment.create')) {
    return c.json({ error: 'po_amendment_create_forbidden', message: 'You do not have permission to raise a Purchase Order amendment.' }, 403);
  }

  let body: {
    poId?: string;
    reason?: string;
    headerChanges?: Record<string, unknown> | null;
    lines?: Array<{
      purchaseOrderItemId?: string | null;
      changeType?: string;
      newMaterialCode?: string | null;
      newMaterialName?: string | null;
      newVariants?: unknown;
      newQty?: number | null;
      newUnitPriceSen?: number | null;
      newDeliveryDate?: string | null;
      oldSnapshot?: unknown;
    }>;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const poId = typeof body.poId === 'string' ? body.poId.trim() : '';
  if (!poId) return c.json({ error: 'po_required', reason: 'A purchase order id is required.' }, 400);

  const rawHeaderChanges = (body.headerChanges ?? null) as Record<string, unknown> | null;
  // Trust boundary — only these header columns may be requested (an unlisted key
  // would otherwise be written straight to the PO on approve).
  const AMENDABLE_HEADER: Record<string, true> = { supplier_id: true, expected_at: true, notes: true };
  const headerChanges: Record<string, string | null> = {};
  if (rawHeaderChanges && typeof rawHeaderChanges === 'object') {
    const unknownKeys = Object.keys(rawHeaderChanges).filter((k) => !Object.prototype.hasOwnProperty.call(AMENDABLE_HEADER, k));
    if (unknownKeys.length > 0) {
      return c.json({ error: 'header_field_not_amendable', reason: `These fields cannot be changed by an amendment: ${unknownKeys.join(', ')}.` }, 400);
    }
    for (const [k, v] of Object.entries(rawHeaderChanges)) {
      if (v !== null && typeof v !== 'string') return c.json({ error: 'header_field_invalid', reason: `The requested value for ${k} is not valid.` }, 400);
      const val = v === null ? null : String(v).trim();
      headerChanges[k] = val === '' ? null : val;
    }
  }
  const hasHeaderChanges = Object.keys(headerChanges).length > 0;
  const submittedLines = Array.isArray(body.lines) ? body.lines : [];
  if (!hasHeaderChanges && submittedLines.length === 0) {
    return c.json({ error: 'amendment_empty', reason: 'There are no changes to request — change a line, a cost or the delivery date first, then submit the amendment.' }, 400);
  }

  // Guard 2/3 — PO exists (company-scoped) and is not cancelled.
  const { data: poRow } = await scopeToCompany(sb.from('purchase_orders')
    .select('id, po_number, status, supplier_id, expected_at, notes')
    .eq('id', poId), c).maybeSingle();
  if (!poRow) return c.json({ error: 'not_found' }, 404);
  const po = poRow as { id: string; po_number: string; status: string; supplier_id: string; expected_at: string | null; notes: string | null };
  if (String(po.status).toUpperCase() === 'CANCELLED') {
    return c.json({ error: 'po_cancelled', reason: 'This Purchase Order is cancelled — it cannot be amended.' }, 409);
  }

  // Guard 4 — one OPEN (REQUESTED) amendment per PO. The partial unique index is
  // the backstop; pre-check here for a clean 409 + the amendment_no counter.
  const { data: priorRows } = await scopeToCompany(sb.from('po_amendments')
    .select('id, status').eq('po_id', poId), c);
  const prior = (priorRows ?? []) as Array<{ id: string; status: string }>;
  if (prior.some((a) => a.status === 'REQUESTED')) {
    return c.json({ error: 'amendment_already_open', reason: 'An amendment is already open on this Purchase Order — resolve it before raising another.' }, 409);
  }

  const amendmentNo = `${po.po_number}/A${prior.length + 1}`;

  // Header before-snapshot — only the keys actually being changed, read off the
  // PO row we already hold (mirror so_amendments.old_header_snapshot).
  const oldHeaderSnapshot: Record<string, string | null> = {};
  if (hasHeaderChanges) {
    const cur = po as unknown as Record<string, unknown>;
    for (const key of Object.keys(headerChanges)) {
      const v = cur[key];
      oldHeaderSnapshot[key] = v == null ? null : String(v);
    }
  }

  const requesterStaffId = (await resolveCallerStaffId(sb, c.get('houzsUser')?.id)) ?? user.id;

  const { data: created, error: insErr } = await sb.from('po_amendments').insert({
    po_id:        poId,
    po_number:    po.po_number,
    amendment_no: amendmentNo,
    status:       'REQUESTED',
    reason:       body.reason ?? null,
    requested_by: requesterStaffId,
    company_id:   activeCompanyId(c),
    header_changes:      hasHeaderChanges ? headerChanges : null,
    old_header_snapshot: hasHeaderChanges ? oldHeaderSnapshot : null,
  }).select('id, po_id, po_number, amendment_no, status, reason, requested_by, created_at').single();
  if (insErr) {
    // The partial unique index raced us — a clean 409, not a 500.
    if (/uq_po_amendment_open|duplicate key/i.test(insErr.message)) {
      return c.json({ error: 'amendment_already_open', reason: 'An amendment is already open on this Purchase Order.' }, 409);
    }
    return c.json({ error: 'create_failed', reason: insErr.message }, 500);
  }
  const amendment = created as { id: string; po_number: string; amendment_no: string };

  if (submittedLines.length > 0) {
    const lineRows = submittedLines.map((l) => ({
      amendment_id:           amendment.id,
      purchase_order_item_id: l.purchaseOrderItemId ?? null,
      change_type:            String(l.changeType ?? '').toUpperCase(),
      new_item_code:      l.newMaterialCode ?? null,
      new_material_name:      l.newMaterialName ?? null,
      new_variants:           (l.newVariants ?? null) as Record<string, unknown> | null,
      new_qty:                l.newQty ?? null,
      new_unit_price_sen:   l.newUnitPriceSen ?? null,
      // `??` is nullish — a blank <input type="date"> posts "" and would reach
      // po_amendment_lines.new_delivery_date (DATE, mig 0194:87), 500ing the
      // insert and rolling the header amendment back at :268.
      new_delivery_date:      dateOrNull(l.newDeliveryDate),
      old_snapshot:           (l.oldSnapshot ?? null) as Record<string, unknown> | null,
    }));
    const { error: lineErr } = await sb.from('po_amendment_lines').insert(stampCompany(lineRows, c));
    if (lineErr) {
      // Roll back the header so a half-written amendment can't wedge the one-open gate.
      await sb.from('po_amendments').delete().eq('id', amendment.id);
      return c.json({ error: 'create_failed', reason: lineErr.message }, 500);
    }
  }

  /* Tell the desk that has to confirm it (owner 2026-09-02) — a PO amendment
     used to appear in the module and wait for somebody to look. Best-effort:
     notifyPoAmendmentRaised never throws, so a notify outage cannot 500 a
     created amendment. */
  await notifyPoAmendmentRaised(c.env, {
    amendmentNo: amendment.amendment_no,
    poNumber: amendment.po_number,
    companyId: activeCompanyId(c),
    reason: body.reason ?? null,
    requesterName: c.get('houzsUser')?.name ?? null,
    requesterUserId: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ amendment: created }, 201);
});

/* ── PATCH /:id/approve ────────────────────────────────────────────────────
   The single hard gate. Guard the transition (REQUESTED → APPROVED), then apply:
   applyPoAmendment snapshots the current PO to po_revisions, applies the line +
   header diffs in place, recomputes totals, bumps purchase_orders.revision, and
   writes an AMENDMENT_PO_APPROVED audit row. Runs inside runScmPgCommand so the
   claim + snapshot + mutations + audit + status flip are ONE transaction.

   Received floor: applyPoAmendment throws ReceivedFloorError BEFORE mutating if a
   revised qty would drop below that PO line's already-received_qty → 409. */
export async function approvePoAmendmentHandler(c: any, sb: any): Promise<Response> {
  const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.po_amendment.approve')) {
    return c.json({ error: 'approve_forbidden', message: 'You do not have permission to approve a Purchase Order amendment.' }, 403);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const { amendment } = loaded;

  const action: PoAmendAction = 'approve';
  if (!canTransition(amendment.status, action)) {
    return c.json({ error: 'bad_transition', reason: `Cannot approve a Purchase Order amendment from status ${amendment.status}.` }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  /* Audit pre-flight (the owner's ruling — a change must never look saved when
     its history row did not write). Ask the audit sink up front; if it refuses,
     nothing has been mutated and "please try again" is true. */
  const pre = await assertAuditWritable(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId: amendment.po_id,
    action: 'AMENDMENT_PO_APPROVED',
    companyId: activeCompanyId(c) ?? null,
  });
  if (!pre.ok) return c.json(auditUnavailableBody(), 503);

  /* Optimistic claim + apply-lease so a concurrent approve cannot double-apply.
     The version predicate detects the conflict; the lease is released on a failed
     apply so the operator can retry (snapshotPo is idempotent on (po_id, revision)). */
  const applyToken = crypto.randomUUID();
  const applyVersion = Number(amendment.version ?? 1);
  const claimNow = new Date().toISOString();
  const claimExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const { data: claimed, error: claimError } = await sb.from('po_amendments').update({
    version: applyVersion + 1,
    apply_lease_token: applyToken,
    apply_lease_expires_at: claimExpiry,
    updated_at: claimNow,
  }).eq('id', id)
    .eq('status', amendment.status)
    .eq('version', applyVersion)
    .or(`apply_lease_token.is.null,apply_lease_expires_at.lt.${claimNow}`)
    .select('id')
    .maybeSingle();
  if (claimError) return c.json({ error: 'update_failed', reason: claimError.message }, 500);
  if (!claimed) return c.json({ error: 'amendment_version_conflict' }, 409);

  /* Two-lane rework — a FOLLOW-UP row (source_so_amendment_id set) is the
     purchaser's SECOND signature on an SO amendment: its lines are a preview,
     and the real apply is reviseBoundPo scoped to THIS po — the same engine the
     legacy approve-po gate ran — so the PO is re-derived from the Sales Order's
     CURRENT truth at confirm time (a later product amendment approved in
     between is picked up, never lost). A manual row keeps applyPoAmendment. */
  let appliedRevision: number;
  let appliedWarnings: string[];
  try {
    if (amendment.source_so_amendment_id) {
      const revised = await reviseBoundPo(sb, amendment.source_so_amendment_id, user.id, c, { onlyPoId: amendment.po_id });
      const mine = revised.perPo.find((p) => p.poId === amendment.po_id);
      appliedRevision = mine?.revision ?? 0;
      appliedWarnings = revised.warnings;
      if (!mine) {
        appliedWarnings = [...appliedWarnings,
          'This purchase order no longer carries lines bound to that sales order, so there was nothing to re-derive.'];
      }
    } else {
      const applied = await applyPoAmendment(sb, id, user.id, c);
      appliedRevision = applied.revision;
      appliedWarnings = applied.warnings;
    }
  } catch (e) {
    // Release the lease so a retry is clean.
    await sb.from('po_amendments').update({ apply_lease_token: null, apply_lease_expires_at: null })
      .eq('id', id).eq('version', applyVersion + 1).eq('apply_lease_token', applyToken);
    if (e instanceof ReceivedFloorError) {
      return c.json({
        error: 'received_floor', code: e.code, poItemId: e.poItemId,
        revisedQty: e.revisedQty, receivedQty: e.receivedQty, reason: e.message,
      }, 409);
    }
    // eslint-disable-next-line no-console
    console.error('[po-amendment] approve apply failed:', e);
    return c.json({ error: 'apply_failed', reason: e instanceof Error ? e.message : 'Failed to apply the Purchase Order revision.' }, 500);
  }

  /* The apply moves line QUANTITIES; the received status is a derived cache
     (grns.ts recomputePoReceived) and nothing above re-derives it. Without this,
     a fully-received PO amended UPWARD stays RECEIVED — and the whole GRN
     surface gates on isReceivablePoStatus, so the added quantity cannot be
     received through any path; amended DOWN to the received qty, it sits at
     PARTIALLY_RECEIVED in the outstanding bucket with nothing receivable behind
     it. Best-effort like the recount's other callers: the amendment applied, so
     a recount hiccup is a warning, never a rollback. */
  {
    const { data: poLines, error: plErr } = await sb.from('purchase_order_items')
      .select('id').eq('purchase_order_id', amendment.po_id);
    const recount = plErr
      ? { ok: false as const, reason: plErr.message }
      : await recomputePoReceived(sb, ((poLines ?? []) as Array<{ id: string }>).map((r) => r.id));
    if (!recount.ok) {
      appliedWarnings = [...appliedWarnings,
        'The received-status recount failed — the PO may show a stale received state until its next receipt or return.'];
    }
  }

  const { data: updated, error: updErr } = await sb.from('po_amendments').update({
    status:      to,
    version:     applyVersion + 2,
    apply_lease_token: null,
    apply_lease_expires_at: null,
    approved_by: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    approved_at: new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  }).eq('id', id)
    .eq('status', amendment.status)
    .eq('version', applyVersion + 1)
    .eq('apply_lease_token', applyToken)
    .select('id, po_id, po_number, amendment_no, status, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  /* Sourced confirms audit here (applyPoAmendment writes its own audit on the
     manual path; reviseBoundPo audits on the SO trail, so the PO's own history
     needs this row to show the second signature). */
  if (amendment.source_so_amendment_id) {
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_ORDER',
      entityId:   amendment.po_id,
      entityDocNo: amendment.po_number,
      action:     'AMENDMENT_PO_APPROVED',
      actor:      { id: c.get('houzsUser')?.id ?? null, name: c.get('houzsUser')?.name ?? null },
      companyId:  activeCompanyId(c) ?? null,
      fieldChanges: [
        { field: 'amendment_no', to: amendment.amendment_no },
        { field: 'source_so_amendment', to: amendment.source_so_amendment_no },
        { field: 'po_revision', to: appliedRevision },
      ],
      note: `Follow-up confirmed — PO re-derived from the revised Sales Order (${amendment.source_so_amendment_no ?? 'SO amendment'}), now revision ${appliedRevision}.`,
    });
  }

  /* ERP -> AutoCount edit. The PO mirror of the SO amendment leg: both apply
     engines (applyPoAmendment on the manual path, reviseBoundPo on the SO-sourced
     one) rewrite the PO's header and lines in place, and neither told AutoCount.
     Queued after the amendment's own optimistic-lock flip won, so one edit per
     applied amendment. `enqueueEdit` swallows its own failures by design — an
     approval that has already committed must not fail on a write-back. */
  await enqueueEdit(sb, {
    companyId: activeCompanyId(c),
    docType: 'PO',
    docId: amendment.po_id,
    docNo: amendment.po_number,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  /* Notice AFTER COMMIT — the requester learns their PO revision went through
     (owner 2026-09-02). The staff -> user lookup runs here, inside the
     transaction, because `sb` does not outlive the deferred callback. */
  {
    const requesterUserId = await resolveUserIdByStaffId(sb, amendment.requested_by);
    const actorUserId = c.get('houzsUser')?.id ?? null;
    const actorLabel = c.get('houzsUser')?.name ?? null;
    deferScmAfterCommit(c, async () => {
      await notifyPoAmendmentResolved(c.env, {
        amendmentNo: amendment.amendment_no ?? '',
        poNumber: amendment.po_number,
        outcome: 'approved',
        actorName: actorLabel,
        actorUserId,
        requesterUserId,
      });
    });
  }

  return c.json({ amendment: updated, revision: appliedRevision, warnings: appliedWarnings });
}
poAmendments.patch('/:id/approve', (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  return runScmPgCommand(c, (sb) => approvePoAmendmentHandler(c, sb));
});

/* ── PATCH /:id/reject ─────────────────────────────────────────────────────
   An approver refusing the request. NO document changes — the PO is untouched,
   the amendment simply closes REJECTED (freeing uq_po_amendment_open). The reason
   is REQUIRED and persisted so the requester can see WHY (mirror so-amendments). */
poAmendments.patch('/:id/reject', async (c) => {
  // WRITE: the company must RESOLVE (companyScope.ts strict rule).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.po_amendment.approve')) {
    return c.json({ error: 'reject_forbidden', message: 'You do not have permission to reject a Purchase Order amendment.' }, 403);
  }

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* validated below */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return c.json({ error: 'reason_required', message: 'Give a reason for rejecting this amendment — the person who raised it needs to know what to change.' }, 400);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const { amendment } = loaded;

  const action: PoAmendAction = 'reject';
  if (!canTransition(amendment.status, action)) {
    return c.json({ error: 'bad_transition', reason: `Cannot reject a Purchase Order amendment from status ${amendment.status}.` }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('po_amendments').update({
    status:           to,
    version:          Number(amendment.version ?? 1) + 1,
    resolution:       'REJECTED',
    rejection_reason: reason,
    rejected_by:      await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    rejected_at:      new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }).eq('id', id)
    /* loadAmendmentForWrite scoped the LOAD; the predicate is repeated on the
       WRITE because nothing re-checks between two PostgREST round trips - the
       SCM client is service-role, so RLS never sees this statement. */
    .eq('company_id', co.companyId)
    .eq('status', amendment.status)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, po_id, po_number, amendment_no, status, resolution, rejection_reason, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId:   amendment.po_id,
    entityDocNo: amendment.po_number,
    action:     'UPDATE',
    actor:      { id: c.get('houzsUser')?.id ?? null, name: c.get('houzsUser')?.name ?? null },
    companyId:  activeCompanyId(c) ?? null,
    fieldChanges: [
      { field: 'amendment_status', from: amendment.status, to },
      { field: 'amendment_rejected', to: amendment.po_number },
      { field: 'rejection_reason', to: reason },
    ],
    note: `PO amendment rejected: ${reason}`,
  });

  /* ── Auto-release to STOCK on a rejected FOLLOW-UP ─────────────────────────
     A follow-up (source_so_amendment_id set) exists because the SO was revised;
     rejecting it means the supplier will NOT follow the revision, so the goods
     will arrive as ORIGINALLY ordered — for the revised SO line they are simply
     no longer its goods. Owner's rule (2026-08-06): that mismatch is a fact,
     not a decision — "SO amendment 了之后,我那张 PO 就直接废了…他就变了". So the
     un-allocated remainder of every affected line is re-pointed to STOCK
     automatically; MRP then re-shows the shortage on the corrected spec and a
     fresh PO can be raised. Existing slices (someone's deliberate split) are
     never touched, and a failure here never un-rejects the amendment — the
     release is reported, retryable via the allocation editor. */
  const releasedToStock: Array<{ poItemId: string; itemCode: string; qty: number }> = [];
  const releaseWarnings: string[] = [];
  if (amendment.source_so_amendment_id) {
    try {
      const { data: amdLines } = await sb.from('po_amendment_lines')
        .select('purchase_order_item_id')
        .eq('amendment_id', id);
      const itemIds = [...new Set(((amdLines ?? []) as Array<{ purchase_order_item_id: string | null }>)
        .map((l) => l.purchase_order_item_id).filter((v): v is string => !!v))];
      if (itemIds.length > 0) {
        const { data: items } = await sb.from('purchase_order_items')
          .select('id, qty, item_code')
          .in('id', itemIds);
        const { data: allocRows } = await sb.from('purchase_order_item_allocations')
          .select('id, purchase_order_item_id, seq, qty, so_item_id')
          .in('purchase_order_item_id', itemIds);
        const byItem = new Map<string, AllocationRow[]>();
        for (const a of (allocRows ?? []) as Array<AllocationRow & { purchase_order_item_id: string }>) {
          const arr = byItem.get(a.purchase_order_item_id) ?? [];
          arr.push(a); byItem.set(a.purchase_order_item_id, arr);
        }
        for (const it of (items ?? []) as Array<{ id: string; qty: number; item_code: string }>) {
          const plan = planStockRelease(Number(it.qty ?? 0), byItem.get(it.id) ?? []);
          if (!plan) continue;
          const { error: insErr } = await sb.from('purchase_order_item_allocations').insert({
            company_id: activeCompanyId(c),
            purchase_order_item_id: it.id,
            seq: plan.seq,
            qty: plan.qty,
            so_item_id: null,
            created_by: user.id,
          });
          if (insErr) { releaseWarnings.push(`${it.item_code}: ${insErr.message}`); continue; }
          releasedToStock.push({ poItemId: it.id, itemCode: it.item_code, qty: plan.qty });
        }
        if (releasedToStock.length > 0) {
          await recordEntityAudit(sb, {
            entityType: 'PURCHASE_ORDER',
            entityId:   amendment.po_id,
            entityDocNo: amendment.po_number,
            action:     'UPDATE',
            actor:      { id: c.get('houzsUser')?.id ?? null, name: c.get('houzsUser')?.name ?? null },
            companyId:  activeCompanyId(c) ?? null,
            fieldChanges: releasedToStock.map((r) => (
              { field: 'allocationTarget', from: 'SO (revised away)', to: `STOCK · ${r.itemCode} × ${r.qty}` }
            )),
            note: `Supplier cannot follow SO revision ${amendment.source_so_amendment_no ?? ''} — un-allocated qty released to STOCK; MRP will re-show the corrected spec as shortage.`.replace('  ', ' '),
          });
        }
      }
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[po-amendment] stock release after reject failed:', e);
      releaseWarnings.push(e instanceof Error ? e.message : 'stock release failed');
    }
  }

  /* The reason is required precisely so the requester knows what to change —
     carry it to them instead of leaving it on a screen they have no reason to
     reopen (owner 2026-09-02). Plain route, so this fires inline; it never
     throws. */
  {
    const requesterUserId = await resolveUserIdByStaffId(sb, amendment.requested_by);
    await notifyPoAmendmentResolved(c.env, {
      amendmentNo: amendment.amendment_no ?? '',
      poNumber: amendment.po_number,
      outcome: 'rejected',
      reason,
      actorName: c.get('houzsUser')?.name ?? null,
      actorUserId: c.get('houzsUser')?.id ?? null,
      requesterUserId,
    });
  }

  return c.json({
    amendment: updated,
    ...(releasedToStock.length > 0 ? { releasedToStock } : {}),
    ...(releaseWarnings.length > 0 ? { releaseWarnings } : {}),
  });
});

/* ── PATCH /:id/withdraw ───────────────────────────────────────────────────
   The REQUESTER pulling their own request back (as distinct from an approver
   refusing it). Lands on the same terminal REJECTED (resolution = 'WITHDRAWN'),
   which releases uq_po_amendment_open so a corrected request can be raised.
   REQUESTED only — the state machine enforces it. */
poAmendments.patch('/:id/withdraw', async (c) => {
  // WRITE: the company must RESOLVE (companyScope.ts strict rule).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* reason optional */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const { amendment } = loaded;

  // Only the person who raised it, or someone who could reject it anyway. Checked
  // against the caller's REAL scm.staff uuid — the bridge pins user.id to one
  // shared system row, so comparing that would let ANY caller withdraw ANY one.
  const callerStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  const isRequester = callerStaffId != null && amendment.requested_by != null && callerStaffId === amendment.requested_by;
  if (!isRequester && !hasHouzsPerm(c, 'scm.po_amendment.approve')) {
    return c.json({ error: 'withdraw_forbidden', message: 'Only the person who raised this amendment can withdraw it.' }, 403);
  }

  const action: PoAmendAction = 'withdraw';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: amendment.status === 'REQUESTED'
        ? `Cannot withdraw a Purchase Order amendment from status ${amendment.status}.`
        : 'This amendment has already been acted on, so it can no longer be withdrawn. Ask an approver to reject it instead.',
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('po_amendments').update({
    status:           to,
    version:          Number(amendment.version ?? 1) + 1,
    resolution:       'WITHDRAWN',
    rejection_reason: reason || 'Withdrawn by the person who raised it.',
    rejected_by:      callerStaffId ?? user.id,
    rejected_at:      new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }).eq('id', id)
    /* loadAmendmentForWrite scoped the LOAD; the predicate is repeated on the
       WRITE because nothing re-checks between two PostgREST round trips - the
       SCM client is service-role, so RLS never sees this statement. */
    .eq('company_id', co.companyId)
    .eq('status', amendment.status)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, po_id, po_number, amendment_no, status, resolution, rejection_reason, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId:   amendment.po_id,
    entityDocNo: amendment.po_number,
    action:     'UPDATE',
    actor:      { id: c.get('houzsUser')?.id ?? null, name: c.get('houzsUser')?.name ?? null },
    companyId:  activeCompanyId(c) ?? null,
    fieldChanges: [
      { field: 'amendment_status', from: amendment.status, to },
      { field: 'amendment_withdrawn', to: amendment.po_number },
    ],
    note: reason || 'Withdrawn by the person who raised it.',
  });

  return c.json({ amendment: updated });
});
