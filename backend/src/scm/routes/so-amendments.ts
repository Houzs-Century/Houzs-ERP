// /so-amendments — SO amendment / revision workflow (port of 2990 so-amendments.ts).
//
// An amendment lets a salesperson change a PROCESSING-LOCKED Sales Order through a
// supplier-confirmed, two-gate state machine (REQUESTED → SUPPLIER_PENDING →
// SO_APPROVED → PO_APPROVED → SENT / REJECTED). The pure state machine + transition
// guards live in ../shared (so-amendment.ts) — this router imports canTransition /
// nextStatus, it does NOT redefine them.
//
// The CREATE endpoint (POST /mfg-sales-orders/:docNo/amendments) is NOT here: it
// lives on the mfgSalesOrders router so its URL nests under the SO mount and it can
// reuse that file's private SO guards (soProcessingLocked / soHasDownstream). This
// module carries list + detail + supplier-confirm + approve-so / approve-po / send
// / reject.
//
// Houzs gate adaptation: 2990's scm.staff.role gates are DEAD here (the SCM bridge
// pins every caller to one super_admin row — see scm/middleware/auth.ts), so every
// gate is `hasHouzsPerm(c, '<flat key>')` against the REAL Houzs caller. Audit rows
// route through recordSoAudit (resolves the NOT-NULL mfg_so_audit_log.company_id).

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import {
  canTransition, nextStatus, type AmendStatus, type AmendAction,
  canLaneTransition, LANE_APPROVE_KEY, LANE_LABEL, type AmendmentLane,
} from '../shared';
import { applySoAmendment, reviseBoundPo, ReceivedFloorError } from '../lib/so-revision';
import { raisePoFollowUps } from '../lib/amendment-po-followup';
import { hasHouzsPerm, canViewAllSales, canWriteScmConfig } from '../lib/houzs-perms';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId, resolveUserIdByStaffId } from '../lib/salesScope';
import {
  notifySoAmendmentResolved,
  notifyPoAmendmentRaised,
} from '../../services/amendmentNotify';
import { collectProcessingGateProblems } from '../shared/so-save-problems';
import { canonicaliseSoHeaderChanges, soDatePairRefusal } from '../shared/so-processing-date';
import { recordSoAudit } from '../lib/so-audit';
import { scopeToCompany, isMirroredDocNo, houzsOwns2990, MIRRORED_SO_READONLY, activeCompanyId, requireActiveCompanyId } from '../lib/companyScope';
import {
  enqueueAmendmentCommand,
  commandsEnabled,
  dispatchOne,
} from '../lib/amendment-command';
import { readBridgeCommandConfig, probeBridge } from '../lib/bridge-2990-command';
import { enqueueEdit } from '../lib/autocount-outbox';
import type { Context } from 'hono';
import { deferScmAfterCommit, runScmPgCommand } from '../lib/pg-supabase-transaction';
import { scheduleStockAllocationAfterCommand } from '../lib/stock-allocation-job';

export const soAmendments = new Hono<{ Bindings: Env; Variables: Variables }>();
soAmendments.use('*', supabaseAuth);

/* Real-caller display name for audit attribution (the scm.staff `user.id` is the
   pinned system row; user_metadata.name is the real Houzs caller). */
function actorName(user: { user_metadata?: { name?: string } } | undefined): string | null {
  return user?.user_metadata?.name ?? null;
}

/* The gate columns (supplier_confirmed_by / so_approved_by / po_approved_by)
   are scm.staff FKs the UI renders as "who did this". `user.id` is the bridge's
   pinned system row shared by EVERY caller, so stamping it made all three read
   as one system identity — the same defect the salesperson_id / requested_by
   stamps carried. Resolve the caller's real mig-0066 staff row; fall back to
   the pinned row when the sync row is missing so the FK stays valid. */
async function gateActorStaffId(
  sb: any,
  houzsUserId: number | null | undefined,
  fallbackStaffId: string,
): Promise<string> {
  return (await resolveCallerStaffId(sb, houzsUserId)) ?? fallbackStaffId;
}

type AmendmentForWrite = {
  id: string;
  so_doc_no: string;
  amendment_no?: string | null;
  status: AmendStatus;
  version: number;
  /* Two-lane rework (2026-07-27): 'LINES' | 'DELIVERY' on post-rework rows,
     NULL on legacy rows — which keep the original supplier-confirmed two-gate
     chain and its original keys. */
  lane?: string | null;
  reason?: string | null;
  apply_lease_token?: string | null;
  apply_lease_expires_at?: string | null;
  /* Needed by the approve-time date-pair re-check (owner 2026-07-28). */
  header_changes?: Record<string, unknown> | null;
  /* scm.staff uuid of whoever raised it — the audience of the approved /
     rejected notice (services/amendmentNotify.ts). */
  requested_by?: string | null;
};

/** Lane of a loaded row — narrowed to the two known values, else legacy. */
const laneOf = (a: AmendmentForWrite): AmendmentLane | null =>
  a.lane === 'LINES' || a.lane === 'DELIVERY' ? a.lane : null;

/* People a RESOLVED amendment is news to (owner 2026-09-02): the person who
   raised it, and the salesperson whose Sales Order it changes. Both are
   scm.staff uuids on the documents; the announcements machinery addresses
   integer public.users ids, so they are translated here — inside the command
   transaction, because the deferred notice runs after `sb` is gone.

   Fail-soft by construction: an unlinked staff row (AutoCount-imported, no
   user_id) simply drops out and the notice goes to whoever is left. */
async function resolvedAmendmentAudience(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM client and Hono context are untyped across this router (dispatchMirroredCommand, approveSoCommandHandler); one typed signature here would not make the rest true.
  sb: any, c: Context<any>,
  amendment: AmendmentForWrite,
): Promise<{ requesterUserId: number | null; salespersonUserId: number | null }> {
  const { data: soRow, error: soErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('salesperson_id').eq('doc_no', amendment.so_doc_no),
    c,
  ).maybeSingle();
  /* A FAILED read is not "this order has no salesperson" — supabase-js does not
     throw, so an unbound error would silently narrow the audience to one person
     and look exactly like an order sold by nobody. Say so, and still tell the
     REQUESTER: their id comes off the amendment row we already hold, so the
     half of the audience this read cannot reach is the only half we lose. */
  if (soErr) {
    console.error(
      `[amendment-notify] salesperson lookup failed for ${amendment.so_doc_no}: ${soErr.message}`,
    );
  }
  return {
    requesterUserId: await resolveUserIdByStaffId(sb, amendment.requested_by),
    salespersonUserId: soErr
      ? null
      : await resolveUserIdByStaffId(
          sb,
          (soRow as { salesperson_id?: string | null } | null)?.salesperson_id,
        ),
  };
}

/* The refusal every legacy-only gate answers when pointed at a lane row. */
const NOT_IN_LANE_FLOW = (what: string) => ({
  error: 'not_in_lane_flow',
  reason: `This amendment uses the two-lane flow — ${what}`,
});
type AmendmentWriteLoad =
  // A Houzs-NATIVE amendment: apply locally, exactly as before.
  | { ok: true; mirrored: false; amendment: AmendmentForWrite }
  // A MIRRORED (2990-) amendment: the intent is dispatched as a command to
  // 2990's own API, never applied here (see dispatchMirroredCommand).
  | { ok: true; mirrored: true; amendment: AmendmentForWrite }
  | { ok: false; reason: 'not_found' };

/* ── loadAmendmentForWrite — the guard load every mutation gate shares ──────
   The list (GET /) and detail (GET /:id) reads above are company-scoped; the
   five mutation gates below used to load with a bare `.eq('id', id)`, so a
   caller whose active company was HOUZS could drive a 2990 amendment through
   its whole state machine by id alone. approve-so / approve-po are not status
   flips — they re-derive the SO's lines and the bound PO's lines and totals —
   so the unscoped load handed one company's user a financial rewrite of the
   other's document. Scope the mutation the way the reads are scoped, and 404
   rather than 403 so an out-of-company id is indistinguishable from a
   nonexistent one (the convention salesDocOutOfScope already set).

   Second axis: a MIRRORED (2990-) amendment is NOT applied here. Houzs is not
   the writer of 2990's records — applySoAmendment would rewrite a mirrored SO
   that the next 2990 drain silently reverts (F2). Previously this refused with
   409 MIRRORED_SO_READONLY. Now the refusal is REPLACED by intent-dispatch
   (design §3.2/D2): the gate hands the action to dispatchMirroredCommand, which
   calls 2990's OWN API so 2990 applies it with 2990's logic, and the result
   flows back down the existing mirror. When the feature is dark (flag off /
   bridge unconfigured), dispatchMirroredCommand restores the exact 409 refusal —
   so read-only-in-Houzs stays the default until the command channel is enabled. */
async function loadAmendmentForWrite(
  sb: any,
  id: string,
  c: Context<any>,
): Promise<AmendmentWriteLoad> {
  const { data } = await scopeToCompany(
    sb.from('so_amendments')
      .select('id, so_doc_no, amendment_no, status, version, lane, reason, apply_lease_token, apply_lease_expires_at, header_changes, requested_by')
      .eq('id', id),
    c,
  ).maybeSingle();
  if (!data) return { ok: false, reason: 'not_found' };
  const amendment = data as AmendmentForWrite;
  // Flip-gated (task #15): post-flip (HOUZS_OWNS_2990) a 2990- SO is native to
  // Houzs, so it is no longer "mirrored" — every downstream `loaded.mirrored`
  // gate lets the amendment apply LOCALLY instead of refusing / dispatching to
  // the (retired) 2990.
  return { ok: true, mirrored: isMirroredDocNo(amendment.so_doc_no) && !houzsOwns2990(c.env), amendment };
}

/* ── dispatchMirroredCommand — turn an approve/reject INTENT on a 2990
   amendment into a command, instead of a local write (design §3.2/D2).

   Enqueue-then-drain, so the user is never blocked on a cross-system call: we
   write the durable sync_command row, fire ONE inline attempt on waitUntil, and
   return 202. The state change appears when the existing mirror delivers 2990's
   new status back down. A failed dispatch stays retryable and the every-5-min cron drain
   finishes it — nothing is fire-and-forget.

   Ships dark: with the flag off OR the bridge unconfigured, the mirrored
   amendment is refused read-only exactly as it was before this build. */
async function dispatchMirroredCommand(
  c: Context<any>,
  sb: any,
  amendment: AmendmentForWrite,
  action: AmendAction,
  payload: Record<string, unknown>,
) {
  if (!(await commandsEnabled(sb))) {
    // Feature dark — mirrored amendments remain read-only in Houzs.
    return c.json(MIRRORED_SO_READONLY, 409);
  }
  const cfg = readBridgeCommandConfig(c.env);
  if (!cfg.ok) {
    // The bridge is not set up, so this could never be delivered. Refuse rather
    // than queue a command that can only ever fail — and say so plainly.
    return c.json({
      error: 'bridge_not_configured',
      message: 'The connection to 2990 is not set up yet, so this change cannot be sent to 2990. Nothing was queued.',
      missing: cfg.missing,
    }, 503);
  }

  let enq;
  try {
    enq = await enqueueAmendmentCommand(sb, {
      // The mirrored row's id IS 2990's uuid (D4, verbatim) — it addresses the
      // right 2990 row with no translation.
      entityKey: amendment.id,
      action,
      payload,
      // The REAL Houzs caller — the authoritative approver (§3.5, requirement 3).
      // NEVER the pinned SCM system `user` (the pos-cart leak #633 class).
      requestedBy: c.get('houzsUser')?.id ?? null,
      companyId: activeCompanyId(c) ?? null,
    });
  } catch {
    return c.json({
      error: 'command_enqueue_failed',
      message: 'Could not queue the change for 2990. Please try again.',
    }, 500);
  }

  // One inline, non-blocking attempt for the happy path (sub-second). Only when
  // still PENDING — a duplicate decision that is already in-flight or resolved
  // (idempotency key) must not be re-fired.
  if (enq.row.status === 'PENDING') {
    const dispatch = () => {
      // The command adapter is valid only until commit. Use the request's
      // normal service client after the durable enqueue and audit commit.
      const p = dispatchOne(c.get('supabase'), cfg.config, enq.row);
      try { c.executionCtx.waitUntil(p); } catch { void p; }
      return Promise.resolve();
    };
    if (sb?.__atomicCommand === true) deferScmAfterCommit(c, dispatch);
    else dispatch();
  }

  // Houzs-side audit of WHO dispatched — the real caller by name (requirement 3).
  // The authoritative id is sync_command.requested_by; the name is snapshotted
  // here. actorId is left null so nothing implies the pinned system row acted.
  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: `AMENDMENT_CMD_${action.toUpperCase().replace(/-/g, '_')}`,
    actorId: null,
    actorName: c.get('houzsUser')?.name ?? null,
    fieldChanges: [{ field: 'command', to: action }],
    note: `Dispatched to 2990 as command ${enq.row.id} (requested by Houzs user ${c.get('houzsUser')?.id ?? 'unknown'}).`,
  });

  return c.json({
    pending: true,
    command: { id: enq.row.id, action, status: enq.row.status },
    message: 'Sent to 2990. The updated status will appear here shortly.',
  }, 202);
}

/* ── GET / — amendment list (newest first) ─────────────────────────────────
   .limit(500) bounds the result so PostgREST's default 1000-row cap can't
   silently truncate — matches the SO/DO/GRN list convention.

   Row-level scope (Owner 2026-07-16) — a salesperson must see the amendments
   for THEIR OWN Sales Orders (they raise them), so the area guard admits them
   (scmAreaGuard scm.sales.orders has an isSalesStaff bypass). But an amendment
   carries no salesperson_id of its own, so without scoping a rep would see
   EVERY rep's amendments. Filter the loaded amendments down to those whose
   bound SO falls in the caller's own+downline sales scope — the SAME
   self+downline tiering the SO list/detail uses. View-all callers (directors /
   office / `*`) are unrestricted (resolveSalesScopeIds → null). */
soAmendments.get('/', async (c) => {
  const sb = c.get('supabase');
  // scopeToCompany: isolate the list to the active company (mig 0080 company_id);
  // no-op pre-activation so single-company Houzs is unchanged.
  const { data, error } = await scopeToCompany(sb.from('so_amendments')
    .select('id, so_doc_no, amendment_no, status, lane, reason, requested_by, created_at, updated_at'), c)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  let rows = (data ?? []) as Array<{ so_doc_no?: string | null }>;
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  if (scopeIds && rows.length > 0) {
    // Resolve which of the listed amendments' SOs the caller may see — a single
    // bounded query over the ≤500 doc_nos on the page (salesperson_id ∈ scope).
    const docNos = [...new Set(rows.map((r) => r.so_doc_no).filter((x): x is string => !!x))];
    const { data: soRows } = await scopeToCompany(sb.from('mfg_sales_orders')
      .select('doc_no')
      .in('doc_no', docNos)
      .in('salesperson_id', scopeIds), c);
    const allowed = new Set(((soRows ?? []) as Array<{ doc_no: string }>).map((r) => r.doc_no));
    rows = rows.filter((r) => r.so_doc_no != null && allowed.has(r.so_doc_no));
  }

  /* Bound-PO enrichment (owner 2026-07-27 — "这个应该出现在 PO Amendment"): each
     row carries the PO(s) its SO's lines were purchased on, the SAME linkage the
     detail's light bound-PO summary resolves (purchase_order_items.so_item_id →
     mfg_sales_order_items.id). The PO Amendments inbox merges the SO amendments
     that revise a bound PO alongside the direct po_amendments, so the purchasing
     team sees the whole revision queue in one place. Three bounded queries over
     the ≤500-row page, never per-row. Fail-soft: enrichment errors leave
     bound_pos empty rather than failing the list. */
  const boundBySo = new Map<string, Array<{ id: string; po_number: string; status: string }>>();
  const allDocNos = [...new Set(rows.map((r) => r.so_doc_no).filter((x): x is string => !!x))];
  if (allDocNos.length > 0) {
    const { data: soItemRows } = await sb.from('mfg_sales_order_items')
      .select('id, doc_no').in('doc_no', allDocNos);
    const soItemToDoc = new Map<string, string>();
    for (const r of (soItemRows ?? []) as Array<{ id: string; doc_no: string }>) soItemToDoc.set(r.id, r.doc_no);
    const soItemIds = [...soItemToDoc.keys()];
    if (soItemIds.length > 0) {
      const { data: poItemRows } = await sb.from('purchase_order_items')
        .select('purchase_order_id, so_item_id').in('so_item_id', soItemIds);
      const poToDocs = new Map<string, Set<string>>();
      for (const r of (poItemRows ?? []) as Array<{ purchase_order_id: string | null; so_item_id: string | null }>) {
        const doc = r.so_item_id ? soItemToDoc.get(r.so_item_id) : undefined;
        if (!r.purchase_order_id || !doc) continue;
        const set = poToDocs.get(r.purchase_order_id) ?? new Set<string>();
        set.add(doc);
        poToDocs.set(r.purchase_order_id, set);
      }
      const poIds = [...poToDocs.keys()];
      if (poIds.length > 0) {
        const { data: poRows } = await sb.from('purchase_orders')
          .select('id, po_number, status').in('id', poIds);
        for (const po of (poRows ?? []) as Array<{ id: string; po_number: string; status: string }>) {
          for (const doc of poToDocs.get(po.id) ?? []) {
            const list = boundBySo.get(doc) ?? [];
            list.push(po);
            boundBySo.set(doc, list);
          }
        }
      }
    }
  }
  const amendments = rows.map((r) => ({
    ...r,
    bound_pos: r.so_doc_no ? (boundBySo.get(r.so_doc_no) ?? []) : [],
  }));
  return c.json({ amendments });
});

/* ── GET /command-diag — the owner's dry-run for the write-back channel ─────
   Cannot be verified without a live 2990 bridge account, so this is how the
   owner checks it once the account exists (same idea as the mirror probes). It
   reports: the DB kill-switch state, which bridge secrets are set, and — with
   ?probe=true — an end-to-end read-only check (sign in as the bridge user, then
   GET 2990's amendment list with that JWT). It NEVER dispatches a command and
   NEVER mutates anything on either side. Registered BEFORE GET /:id so the
   static path wins over the :id param. Gated to scm.config.write (owner-level),
   like maintenance-push/diff, because it exercises the 2990 connection. */
soAmendments.get('/command-diag', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', message: 'You do not have permission to view the 2990 connection diagnostics.' }, 403);
  }
  const sb = c.get('supabase');
  const enabled = await commandsEnabled(sb);
  const cfg = readBridgeCommandConfig(c.env);

  const base: Record<string, unknown> = {
    commandsEnabled: enabled,
    bridgeConfigured: cfg.ok,
    missingSecrets: cfg.ok ? [] : cfg.missing,
    note: 'commandsEnabled is the scm.sync_config row mirror_commands_enabled = true. Both must be true (and the probe green) before Houzs can drive a 2990 amendment.',
  };

  if (c.req.query('probe') !== 'true' || !cfg.ok) {
    return c.json(base);
  }
  const probe = await probeBridge(cfg.config);
  return c.json({ ...base, probe });
});

/* ── GET /:id — amendment detail ───────────────────────────────────────────
   Returns: the amendment row + its so_amendment_lines + the SO header summary
   (doc_no, status, revision) + a light bound-PO summary (po_number, status). */
soAmendments.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [amdRes, lineRes] = await Promise.all([
    // scopeToCompany: detail read isolated to the active company (mig 0080); no-op pre-activation.
    scopeToCompany(sb.from('so_amendments')
      .select('id, so_doc_no, amendment_no, status, lane, reason, requested_by, ' +
        'supplier_confirmed_by, supplier_confirmation_ref, supplier_confirmation_note, ' +
        'supplier_confirmation_attachment_key, so_approved_by, so_approved_at, ' +
        'po_approved_by, po_approved_at, sent_at, created_at, updated_at, ' +
      // mig 0149 — how the amendment was CLOSED (rejected by an approver vs
      // withdrawn by its requester) and WHY, plus the in-place-edit counter.
      // Without rejection_reason the requester could not see why their request
      // was refused without someone opening the SO's history drawer for them.
      'rejected_by, rejected_at, rejection_reason, resolution, edited_at, edit_count, ' +
        // mig 0119 — the HEADER half of the request (Delivery Date / Processing
        // Date / State / Postcode) + its before-snapshot. NULL on a line-only
        // amendment. Without these the approver could not SEE a requested date
        // change, only line diffs.
        'header_changes, old_header_snapshot')
      .eq('id', id), c).maybeSingle(),
    sb.from('so_amendment_lines')
      .select('id, amendment_id, sales_order_item_id, change_type, new_item_code, ' +
        // mig 0280 — new_remark is the free-text instruction the requester typed
        // onto the line. Omitting it here would leave the approver signing off a
        // line whose whole point (a service line's job description) is invisible.
        /* mig 0317 — new_discount_sen. The write path shipped WITHOUT this read:
           the card computed every stored line as delta-free and told the
           approver "No line changes recorded" about a money change it was
           holding. A channel is not done until every reader returns it. */
        'new_variants, new_qty, new_unit_price_sen, new_remark, new_discount_sen, old_snapshot')
      .eq('amendment_id', id),
  ]);
  if (amdRes.error) return c.json({ error: 'load_failed', reason: amdRes.error.message }, 500);
  if (!amdRes.data) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRes.data as unknown as { so_doc_no: string } & Record<string, unknown>;
  const lines = (lineRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  // SO header summary — doc_no, status, revision (+ salesperson_id for the scope
  // check below).
  const { data: soRow } = await sb.from('mfg_sales_orders')
    .select('doc_no, status, revision, salesperson_id')
    .eq('doc_no', amendment.so_doc_no).maybeSingle();
  const salesOrder = (soRow ?? null) as
    { doc_no: string; status: string; revision: number; salesperson_id?: number | string | null } | null;

  /* Row-level scope (Owner 2026-07-16) — a scoped salesperson may open only an
     amendment for a Sales Order in their own+downline scope; anything else 404s
     (indistinguishable from a nonexistent id), mirroring the SO detail read.
     View-all callers pass. */
  if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), salesOrder?.salesperson_id)) {
    return c.json({ error: 'not_found' }, 404);
  }

  /* Light bound-PO summary — the PO(s) whose lines were derived from this SO's
     lines (purchase_order_items.so_item_id → mfg_sales_order_items.id). */
  let purchaseOrders: Array<{ id: string; po_number: string; status: string }> = [];
  const { data: soItemRows } = await sb.from('mfg_sales_order_items')
    .select('id').eq('doc_no', amendment.so_doc_no);
  const soItemIds = ((soItemRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (soItemIds.length > 0) {
    const { data: poItemRows } = await sb.from('purchase_order_items')
      .select('purchase_order_id').in('so_item_id', soItemIds);
    const poIds = [...new Set(((poItemRows ?? []) as Array<{ purchase_order_id: string | null }>)
      .map((r) => r.purchase_order_id).filter((x): x is string => Boolean(x)))];
    if (poIds.length > 0) {
      const { data: poRows } = await sb.from('purchase_orders')
        .select('id, po_number, status').in('id', poIds);
      purchaseOrders = (poRows ?? []) as Array<{ id: string; po_number: string; status: string }>;
    }
  }

  /* Two-lane rework — the follow-up PO Amendments this amendment auto-raised
     when its LINES lane applied. A REJECTED follow-up is the "PO not followed
     up" flag the SO/amendment detail surfaces; an APPROVED one is the
     purchaser's second signature done. Empty for DELIVERY-lane + legacy rows. */
  let poFollowUps: Array<Record<string, unknown>> = [];
  {
    const { data: fuRows } = await sb.from('po_amendments')
      .select('id, po_id, po_number, amendment_no, status, resolution, approved_at, rejected_at, created_at')
      .eq('source_so_amendment_id', id)
      .order('created_at', { ascending: true });
    poFollowUps = (fuRows ?? []) as Array<Record<string, unknown>>;
  }

  return c.json({ amendment, lines, salesOrder, purchaseOrders, poFollowUps });
});

/* ── PATCH /:id/supplier-confirm ───────────────────────────────────────────
   Record the supplier's acknowledgement of the requested change. Body:
   { ref, note?, attachmentKey? }. Gated to scm.amendment.supplier_confirm.
   Transition REQUESTED → SUPPLIER_PENDING via the shared state machine. */
soAmendments.patch('/:id/supplier-confirm', async (c) => {
  // WRITE: the company must RESOLVE. companyScope.ts's strict rule - an
  // unresolvable company is a condition to surface, never one to guess past.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.supplier_confirm')) {
    return c.json({
      error: 'supplier_confirm_forbidden',
      message: 'You do not have permission to record a supplier confirmation.',
    }, 403);
  }

  let body: { ref?: string; note?: string; attachmentKey?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!ref) return c.json({ error: 'ref_required', reason: 'A supplier confirmation reference is required.' }, 400);

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) {
    return dispatchMirroredCommand(c, sb, loaded.amendment, 'supplier-confirm', {
      ref, note: body.note, attachmentKey: body.attachmentKey,
    });
  }
  const { amendment } = loaded;

  /* Two-lane rework: there is NO supplier-confirmation gate on a lane row —
     the purchaser checks with the supplier BEFORE signing (their signature is
     the confirmation). Only legacy (lane NULL) rows keep this step. */
  if (laneOf(amendment)) {
    return c.json(NOT_IN_LANE_FLOW('there is no supplier-confirmation step. Approve or reject it directly.'), 409);
  }

  const action: AmendAction = 'supplier-confirm';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot record a supplier confirmation from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:                               to,
    version:                              Number(amendment.version ?? 1) + 1,
    supplier_confirmed_by:                await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    supplier_confirmation_ref:            ref,
    supplier_confirmation_note:           body.note ?? null,
    supplier_confirmation_attachment_key: body.attachmentKey ?? null,
    updated_at:                           new Date().toISOString(),
  }).eq('id', id)
    /* loadAmendmentForWrite already scoped the LOAD; the predicate is repeated on
       the WRITE because nothing re-checks between two PostgREST round trips - the
       SCM client is service-role, so RLS never sees this statement. */
    .eq('company_id', co.companyId)
    .eq('status', amendment.status)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, so_doc_no, amendment_no, status, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_SUPPLIER_CONFIRMED',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [{ field: 'amendment_status', from: amendment.status, to }],
    note: ref,
  });

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/approve-so ─────────────────────────────────────────────────
   The first hard gate. Guard the transition (SUPPLIER_PENDING / REQUESTED →
   SO_APPROVED — the light no-supplier path may skip supplier-confirm), then
   RE-DERIVE the SO: snapshot the current version to so_revisions, apply the line
   diffs to mfg_sales_order_items, RE-RUN the honest-pricing recompute
   (applySoAmendment), bump mfg_sales_orders.revision, and audit.

   If the SO has NO bound PO this is the TERMINAL step — the amendment rests at
   SO_APPROVED. */
export async function approveSoCommandHandler(c: any, sb: any): Promise<Response> {
  const id = c.req.param('id'); const user = c.get('user');

  /* Two-lane rework: the gate key depends on WHICH row this is, so load first.
     LINES → scm.amendment.approve_lines (purchasing), DELIVERY →
     scm.amendment.approve_delivery (logistics), legacy NULL-lane rows keep the
     original scm.amendment.approve_so. */
  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const lane = laneOf(loaded.amendment);
  const approveKey = lane ? LANE_APPROVE_KEY[lane] : 'scm.amendment.approve_so';
  if (!hasHouzsPerm(c, approveKey)) {
    return c.json({
      error: 'approve_so_forbidden',
      message: lane
        ? `You do not have permission to approve the ${LANE_LABEL[lane]} lane of an SO amendment.`
        : 'You do not have permission to approve a Sales Order revision.',
    }, 403);
  }
  if (loaded.mirrored) return dispatchMirroredCommand(c, sb, loaded.amendment, 'approve-so', {});
  const { amendment } = loaded;

  const action: AmendAction = 'approve-so';
  const legal = lane ? canLaneTransition(amendment.status, action) : canTransition(amendment.status, action);
  if (!legal) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot approve the SO revision from status ${amendment.status}.`,
    }, 409);
  }
  const to = lane ? ('SO_APPROVED' as AmendStatus) : nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  /* ── Approve-time date-pair re-check (owner 2026-07-28) ────────────────────
     The submit-time pair guard (mfg-sales-orders.ts, amendment_dates_order)
     validates proc ≤ delivery on the COMBINED request, but the two-lane split
     then turns a both-dates reschedule into two one-signature documents with
     independent lives. If the sibling lane was rejected — or the SO's other
     date moved by any other route — between submit and approve, applying this
     half alone would invert the pair, and nothing downstream re-checks it.
     Re-validate against the SO's CURRENT other date at the moment of
     approval: the last write that can still say no. Fail-open on a missing SO
     row — the apply path right below owns that refusal. */
  /* CANONICALISE FIRST. `canonicaliseSoHeaderChanges` was imported into this
     file and never called: every `'processingDate' in headerChanges` test below
     read the RAW stored jsonb, so a Processing-Date amendment submitted under
     the pre-rename key (`internalExpectedDd`) walked past this whole block —
     the date-order re-check, the pair re-check and the deposit / completeness
     gate — and was applied by so-revision.ts, which DOES canonicalise. The gate
     and the write must read the same shape or the gate is decoration. */
  const headerChanges = canonicaliseSoHeaderChanges(amendment.header_changes ?? null);
  if (headerChanges && ('processingDate' in headerChanges || 'customerDeliveryDate' in headerChanges)) {
    const { data: soDates } = await sb.from('mfg_sales_orders')
      .select('processing_date, customer_delivery_date, debtor_name, address1, postcode')
      .eq('doc_no', amendment.so_doc_no)
      .maybeSingle();
    const cur = (soDates ?? {}) as { processing_date?: string | null; customer_delivery_date?: string | null };
    const ymd = (v: unknown): string => (v == null ? '' : String(v).slice(0, 10));
    const nextProc = 'processingDate' in headerChanges
      ? ymd(headerChanges['processingDate'])
      : ymd(cur.processing_date);
    const nextDeliv = 'customerDeliveryDate' in headerChanges
      ? ymd(headerChanges['customerDeliveryDate'])
      : ymd(cur.customer_delivery_date);
    /* THE PAIR RE-CHECK, which this path did not have. The submit-time XOR
       (mfg-sales-orders.ts, amendment_dates_xor) validates the COMBINED request,
       and the two-lane split then turns a both-dates reschedule into two
       one-signature documents — so by the time this half is approved the SO's
       other date may have been cleared, or the sibling lane rejected, and
       applying this one alone leaves the order holding exactly one date. Nothing
       downstream re-checks it: applySoAmendment writes what it is given. Same
       predicate as every other write path; the CURRENT stored pair is the
       original, so approving an amendment that changes neither date on a legacy
       unpaired order is still allowed. */
    const stalePair = soDatePairRefusal({
      nextProc, nextDeliv,
      origProc: ymd(cur.processing_date),
      origDeliv: ymd(cur.customer_delivery_date),
    });
    if (stalePair) {
      return c.json({
        error: 'amendment_dates_pair_stale',
        reason:
          `Approving this would leave the order with only one of the two dates ` +
          `(Processing ${nextProc || '—'}, Delivery ${nextDeliv || '—'}). ` +
          'The other half of the paired reschedule was rejected, or the order\'s dates have moved since this ' +
          'was requested — reject this amendment and re-request both dates together.',
      }, 409);
    }
    if (nextProc !== '' && nextDeliv !== '' && nextProc > nextDeliv) {
      return c.json({
        error: 'amendment_dates_order_stale',
        reason:
          `Approving this would put the Processing Date (${nextProc}) after the Delivery Date (${nextDeliv}). ` +
          'The other half of the paired reschedule was rejected, or the order\'s dates have moved since this ' +
          'was requested — reject this amendment and re-request both dates together.',
      }, 409);
    }

    /* ── The gate this path used to skip entirely (2026-07-31) ───────────────
       Approving an amendment can SET processing_date through
       header_changes, and until now the only thing checked here was the date
       ORDER above. So an order could acquire a Processing Date — production's
       go-ahead — with no deposit and no delivery address, simply by routing the
       change through the amendment queue instead of the SO screen. That is how
       10 HOUZS orders came to hold a Processing Date at 0% paid.

       Same predicate the SO create + edit paths run (collectProcessingGateProblems),
       so the three cannot drift, and deliberately in the SAME block as the
       date-pair re-check: its comment already calls this "the last write that
       can still say no", which is exactly what this is.

       Only when the amendment SETS a non-empty date. Clearing it, or an
       amendment that touches only the delivery date, is untouched — a gate that
       blocks REMOVING a date would trap an order it was meant to protect. */
    if (nextProc !== '' && 'processingDate' in headerChanges) {
      const soRow = (soDates ?? {}) as {
        debtor_name?: string | null; address1?: string | null;
        postcode?: string | null;
      };
      /* NO DEPOSIT TERM — owner ruling 2026-08-20, 「以电脑为准 —— 两边都不查」.
         This read summed `mfg_sales_order_payments` to weigh the money before
         approving an amendment that sets a Processing Date. Approving such an
         amendment is the same act as setting the date on the header, so leaving
         the condition here would have kept the rule surface-dependent — the
         exact defect the ruling closes — one screen further along. The payments
         read went with it; nothing else on this path used it. */
      const gateProblems = collectProcessingGateProblems({
        procDate: nextProc,
        delivDate: nextDeliv || null,
        todayMY: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
        /* The date already exists on the order or in this amendment; the
           past-date rules are the submit path's business, not the approver's —
           passing the effective values as their own originals grandfathers them
           so approving a legitimately-old reschedule cannot be blocked here. */
        origProcDate: nextProc,
        origDelivDate: nextDeliv || null,
        completeness: {
          hasCustomerName: !!String(soRow.debtor_name ?? '').trim(),
          hasAddress: !!String(soRow.address1 ?? '').trim(),
          hasPostcode: !!String(soRow.postcode ?? '').trim(),
        },
      });
      if (gateProblems.length > 0) {
        return c.json({
          error: 'validation_failed',
          reason: 'Approving this would set a Processing Date the order does not yet qualify for.',
          problems: gateProblems,
        }, 422);
      }
    }
  }

  /* Claim BOTH the amendment and its SO before the first apply write. The
     version predicates detect conflicts while runScmPgCommand keeps the claim,
     snapshot, line mutations, totals, audit, and final status in one database
     transaction. */
  const applyToken = crypto.randomUUID();
  const applyVersion = Number(amendment.version ?? 1);
  const claimNow = new Date().toISOString();
  const claimExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const { data: claimed, error: claimError } = await sb.from('so_amendments').update({
    version: applyVersion + 1,
    apply_lease_token: applyToken,
    apply_lease_expires_at: claimExpiry,
    updated_at: claimNow,
  }).eq('id', id)
    .eq('status', amendment.status)
    .eq('version', applyVersion)
    .or(`apply_lease_token.is.null,apply_lease_expires_at.lt.${claimNow}`)
    .select('id, version')
    .maybeSingle();
  if (claimError) return c.json({ error: 'update_failed', reason: claimError.message }, 500);
  if (!claimed) return c.json({ error: 'amendment_version_conflict' }, 409);

  const releaseAmendmentClaim = async () => {
    await sb.from('so_amendments').update({
      apply_lease_token: null,
      apply_lease_expires_at: null,
    }).eq('id', id).eq('version', applyVersion + 1).eq('apply_lease_token', applyToken);
  };

  const { data: soGeneration, error: soGenerationError } = await sb.from('mfg_sales_orders')
    .select('version, edit_lease_token, edit_lease_expires_at')
    .eq('doc_no', amendment.so_doc_no)
    .maybeSingle();
  if (soGenerationError || !soGeneration) {
    await releaseAmendmentClaim();
    return c.json({
      error: soGenerationError ? 'load_failed' : 'not_found',
      reason: soGenerationError?.message,
    }, soGenerationError ? 500 : 404);
  }
  const soVersion = Number((soGeneration as { version?: number | string }).version ?? 1);
  const { data: soClaimed, error: soClaimError } = await sb.from('mfg_sales_orders').update({
    edit_lease_token: applyToken,
    edit_lease_expires_at: claimExpiry,
  }).eq('doc_no', amendment.so_doc_no)
    .eq('version', soVersion)
    .or(`edit_lease_token.is.null,edit_lease_expires_at.lt.${claimNow}`)
    .select('doc_no')
    .maybeSingle();
  if (soClaimError || !soClaimed) {
    await releaseAmendmentClaim();
    if (soClaimError) return c.json({ error: 'update_failed', reason: soClaimError.message }, 500);
    return c.json({ error: 'so_edit_lease_conflict' }, 409);
  }

  /* Apply the revision. A hard failure leaves the amendment status unchanged (we
     only advance status AFTER a clean apply) so the operator can retry — the
     snapshot upsert is idempotent on (so_doc_no, revision). */
  let applied: { soDocNo: string; revision: number };
  try {
    /* The sixth argument is this gate's RECEIPT, and it is what lets the apply
       persist the unit prices the amendment requested instead of re-pricing them
       to the catalogue (owner 2026-08-16 — the amendment is the sanctioned road
       for money on a locked SO). It is constructed HERE and nowhere else,
       AFTER `hasHouzsPerm(c, approveKey)` above and the transition check: a
       requested price is client-authored and unvalidated, so what makes it
       payable is this signature, never the payload. Any other caller of
       applySoAmendment must pass `null` and gets the catalogue behaviour. */
    applied = await applySoAmendment(sb, id, user.id, c, { soVersion, leaseToken: applyToken }, {
      approvedByUserId: String(user.id),
      approvalPermission: approveKey,
    });
  } catch (e) {
    await sb.from('mfg_sales_orders').update({
      edit_lease_token: null,
      edit_lease_expires_at: null,
    }).eq('doc_no', amendment.so_doc_no).eq('version', soVersion).eq('edit_lease_token', applyToken);
    await sb.from('so_amendments').update({
      apply_lease_token: null,
      apply_lease_expires_at: null,
    }).eq('id', id).eq('version', applyVersion + 1).eq('apply_lease_token', applyToken);
    // eslint-disable-next-line no-console
    console.error('[so-amendment] approve-so apply failed:', e);
    return c.json({
      error: 'apply_failed',
      reason: e instanceof Error ? e.message : 'Failed to apply the SO revision.',
    }, 500);
  }

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:         to,
    version:        applyVersion + 2,
    apply_lease_token: null,
    apply_lease_expires_at: null,
    so_approved_by: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    so_approved_at: new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  }).eq('id', id)
    .eq('status', amendment.status)
    .eq('version', applyVersion + 1)
    .eq('apply_lease_token', applyToken)
    .select('id, so_doc_no, amendment_no, status, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  /* Two-lane rework — the LINES lane's PO leg: raise the follow-up PO
     Amendment(s) INSIDE this same transaction (runScmPgCommand), so the SO
     revision and the purchaser's to-do commit or roll back together. The
     purchaser confirms them in PO Amendments (their second signature), where
     the apply is reviseBoundPo scoped to that one PO. DELIVERY lane and legacy
     rows never reach this: DELIVERY never touches a PO, legacy uses approve-po. */
  let poFollowUps: Awaited<ReturnType<typeof raisePoFollowUps>> = { followUps: [], warnings: [] };
  if (lane === 'LINES') {
    poFollowUps = await raisePoFollowUps(sb, c, {
      soAmendmentId: amendment.id,
      soAmendmentNo: amendment.amendment_no ?? '',
      soDocNo: amendment.so_doc_no,
      reason: amendment.reason ?? null,
      requesterStaffId: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    });
    await recordSoAudit(sb, {
      docNo: amendment.so_doc_no,
      action: 'AMENDMENT_PO_FOLLOWUP_RAISED',
      actorId: user.id,
      actorName: actorName(user),
      fieldChanges: [
        { field: 'po_follow_ups', to: poFollowUps.followUps.map((f) => f.amendmentNo).join(', ') || 'none' },
        ...(poFollowUps.warnings.length ? [{ field: 'needs_attention', to: poFollowUps.warnings.join(' | ') }] : []),
      ],
      note: poFollowUps.followUps.length
        ? `Follow-up PO amendment(s) raised for purchasing to confirm: ${poFollowUps.followUps.map((f) => `${f.amendmentNo} (${f.poNumber})`).join('; ')}`
        : 'No PO follow-up needed for this amendment.',
    });
  }

  /* ERP -> AutoCount edit. THE SANCTIONED WAY TO CHANGE A CONFIRMED SO, and
     until now the one that told AutoCount nothing. applySoAmendment rewrites the
     header and the lines of an SO that is already PROCESSING-locked — which is
     precisely the SO most likely to exist in the account book — so the amendment
     path is where the two sides drifted furthest, fastest, and most officially.

     Queued AFTER the amendment's own status flip won its optimistic-lock race
     (`updated` is null on a loser, and that branch returned above), so exactly
     one edit is queued per applied amendment. Queued outside runScmPgCommand for
     the same reason queueAcSoEditAfter is: a write-back must never be able to
     roll back a revision the operator has already been told succeeded. */
  await enqueueEdit(sb, {
    companyId: activeCompanyId(c),
    docType: 'SO',
    docNo: amendment.so_doc_no,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  /* Notices (owner 2026-09-02). AFTER COMMIT — an approval that rolls back
     must not leave people told their amendment went through. The audience is
     resolved HERE, inside the transaction, because `sb` does not outlive it;
     the deferred half only touches env.DB via the announcements helper, which
     never throws. */
  {
    const audience = await resolvedAmendmentAudience(sb, c, amendment);
    const actorUserId = c.get('houzsUser')?.id ?? null;
    const actorLabel = c.get('houzsUser')?.name ?? actorName(user);
    const followUps = poFollowUps.followUps.map((f) => ({
      amendmentNo: f.amendmentNo,
      poNumber: f.poNumber,
    }));
    deferScmAfterCommit(c, async () => {
      await notifySoAmendmentResolved(c.env, {
        amendmentNo: amendment.amendment_no ?? '',
        soDocNo: amendment.so_doc_no,
        outcome: 'approved',
        actorName: actorLabel,
        actorUserId,
        requesterUserId: audience.requesterUserId,
        salespersonUserId: audience.salespersonUserId,
      });
      /* The LINES lane's second signature: each follow-up is a fresh to-do on
         the purchaser's desk that nobody asked for by hand, so it is exactly
         the kind of row that used to sit unseen. */
      for (const f of followUps) {
        await notifyPoAmendmentRaised(c.env, {
          amendmentNo: f.amendmentNo,
          poNumber: f.poNumber,
          companyId: activeCompanyId(c),
          requesterUserId: actorUserId,
          sourceSoAmendmentNo: amendment.amendment_no ?? null,
        });
      }
    });
  }

  await scheduleStockAllocationAfterCommand(c, sb, `amendment-approve-so:${amendment.so_doc_no}`);
  return c.json({
    amendment: updated,
    revision: applied.revision,
    poFollowUps: poFollowUps.followUps,
    warnings: poFollowUps.warnings,
  });
}
soAmendments.patch('/:id/approve-so', (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  return runScmPgCommand(c, (sb) => approveSoCommandHandler(c, sb));
});

/* ── PATCH /:id/approve-po ─────────────────────────────────────────────────
   The second hard gate. Guard the transition (SO_APPROVED → PO_APPROVED), then
   RE-DERIVE the bound PO(s): reviseBoundPo snapshots each live bound PO to
   po_revisions, re-derives its lines from the NOW-REVISED SO lines, recomputes
   totals, bumps purchase_orders.revision, and audits.

   Received floor: reviseBoundPo throws a ReceivedFloorError BEFORE mutating if
   any revised qty would drop below that PO line's already-received_qty → 409. */
export async function approvePoCommandHandler(c: any, sb: any) {
  const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.approve_po')) {
    return c.json({
      error: 'approve_po_forbidden',
      message: 'You do not have permission to approve a Purchase Order revision.',
    }, 403);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) return dispatchMirroredCommand(c, sb, loaded.amendment, 'approve-po', {});
  const { amendment } = loaded;

  /* Two-lane rework: a lane row's PO leg lives in PO Amendments. */
  if (laneOf(amendment)) {
    return c.json(NOT_IN_LANE_FLOW('the PO side is confirmed in PO Amendments, not here.'), 409);
  }

  const action: AmendAction = 'approve-po';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot approve the PO revision from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const applyToken = crypto.randomUUID();
  const applyVersion = Number(amendment.version ?? 1);
  const claimNow = new Date().toISOString();
  const claimExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const { data: claimed, error: claimError } = await sb.from('so_amendments').update({
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

  let revised: Awaited<ReturnType<typeof reviseBoundPo>>;
  try {
    revised = await reviseBoundPo(sb, id, user.id, c);
  } catch (e) {
    if (e instanceof ReceivedFloorError) {
      return c.json({
        error: 'received_floor',
        code: e.code,
        poItemId: e.poItemId,
        revisedQty: e.revisedQty,
        receivedQty: e.receivedQty,
        reason: e.message,
      }, 409);
    }
    // eslint-disable-next-line no-console
    console.error('[so-amendment] approve-po revise failed:', e);
    return c.json({
      error: 'revise_failed',
      reason: e instanceof Error ? e.message : 'Failed to revise the bound PO.',
    }, 500);
  }

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:         to,
    version:        applyVersion + 2,
    apply_lease_token: null,
    apply_lease_expires_at: null,
    po_approved_by: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    po_approved_at: new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  }).eq('id', id)
    .eq('status', amendment.status)
    .eq('version', applyVersion + 1)
    .eq('apply_lease_token', applyToken)
    .select('id, so_doc_no, amendment_no, status, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_PO_APPROVED',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [
      { field: 'amendment_status', from: amendment.status, to },
      { field: 'pos_revised', to: revised.perPo.map((p) => p.poNumber).join(', ') || 'none' },
      /* Anything that needed a human hand (an already-received removed line left
         in place, an added item with no open PO, an emptied PO) is recorded on
         the SO's own audit trail so it is visible later, not just in the toast. */
      ...(revised.warnings.length ? [{ field: 'needs_attention', to: revised.warnings.join(' | ') }] : []),
    ],
    note: revised.perPo.length
      ? `Revised PO(s): ${revised.perPo.map((p) => `${p.poNumber} rev ${p.revision}`).join('; ')}`
      : 'No bound PO — nothing to revise.',
  });

  return c.json({ amendment: updated, revisedPurchaseOrders: revised.perPo, warnings: revised.warnings });
}
soAmendments.patch('/:id/approve-po', (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  return runScmPgCommand(c, (sb) => approvePoCommandHandler(c, sb));
});

/* ── PATCH /:id/send ───────────────────────────────────────────────────────
   The terminal happy-path step. Guard the transition (PO_APPROVED → SENT), then
   stamp sent_at. Houzs has NO server-side PO-PDF / doc-email path (the PO PDF is
   produced client-side in the SPA), so the actual Revised-PO delivery is
   performed by the frontend once this gate flips to SENT. Gated to
   scm.amendment.approve_po (same purchasing gate as approve-po). */
soAmendments.patch('/:id/send', async (c) => {
  // WRITE: the company must RESOLVE. companyScope.ts's strict rule - an
  // unresolvable company is a condition to surface, never one to guess past.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.approve_po')) {
    return c.json({
      error: 'send_forbidden',
      message: 'You do not have permission to send the revised Purchase Order.',
    }, 403);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) return dispatchMirroredCommand(c, sb, loaded.amendment, 'send', {});
  const { amendment } = loaded;

  /* Two-lane rework: a lane row never reaches PO_APPROVED — sending the
     revised PO happens off the PO itself once its follow-up is confirmed. */
  if (laneOf(amendment)) {
    return c.json(NOT_IN_LANE_FLOW('print and send the revised PO from the Purchase Order after confirming its follow-up amendment.'), 409);
  }

  const action: AmendAction = 'send';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot send the revised PO from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:     to,
    version:    Number(amendment.version ?? 1) + 1,
    sent_at:    new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id)
    /* loadAmendmentForWrite already scoped the LOAD; the predicate is repeated on
       the WRITE because nothing re-checks between two PostgREST round trips - the
       SCM client is service-role, so RLS never sees this statement. */
    .eq('company_id', co.companyId)
    .eq('status', amendment.status)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, so_doc_no, amendment_no, status, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_SENT',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [{ field: 'amendment_status', from: amendment.status, to }],
    note: 'Revised PO marked sent to supplier.',
  });

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/reject ─────────────────────────────────────────────────────
   Reject an in-flight amendment from ANY pre-approved gate (REQUESTED /
   SUPPLIER_PENDING / SO_APPROVED / PO_APPROVED). NO document changes: the SO/PO
   are untouched, the amendment simply closes as REJECTED (freeing the one-open
   partial unique index so a fresh amendment can be raised). Gated to
   scm.amendment.approve_po.

   Owner 2026-07-19, from the SO-2607-015/A1 screenshot: there was no Reject
   control anywhere in the UI and nowhere to type a reason. This gate existed but
   the frontend never called it (useRejectAmendment was defined and imported by
   nothing), and `reason` was OPTIONAL and written only into the audit NOTE —
   so_amendments had no column for it, so the requester could not see WHY their
   request had been refused.

   The reason is now REQUIRED and persisted. A refusal that does not say why is
   not actionable: the requester's only recourse is to guess and resubmit, which
   is precisely the competing-documents problem the edit/withdraw work exists to
   end. */
soAmendments.patch('/:id/reject', async (c) => {
  // WRITE: the company must RESOLVE. companyScope.ts's strict rule - an
  // unresolvable company is a condition to surface, never one to guess past.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* validated below */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return c.json({
      error: 'reason_required',
      message: 'Give a reason for rejecting this amendment — the person who raised it needs to know what to change.',
    }, 400);
  }

  /* Two-lane rework: the reject key follows the row's lane (its own approver
     refuses it); legacy rows keep the original purchasing gate. Loaded first
     because the key depends on the row. */
  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const lane = laneOf(loaded.amendment);
  const rejectKey = lane ? LANE_APPROVE_KEY[lane] : 'scm.amendment.approve_po';
  if (!hasHouzsPerm(c, rejectKey)) {
    return c.json({
      error: 'reject_forbidden',
      message: lane
        ? `You do not have permission to reject the ${LANE_LABEL[lane]} lane of an SO amendment.`
        : 'You do not have permission to reject an amendment.',
    }, 403);
  }
  if (loaded.mirrored) {
    return dispatchMirroredCommand(c, sb, loaded.amendment, 'reject', { reason });
  }
  const { amendment } = loaded;

  const action: AmendAction = 'reject';
  const legal = lane ? canLaneTransition(amendment.status, action) : canTransition(amendment.status, action);
  if (!legal) {
    return c.json({
      error: 'bad_transition',
      reason: lane && amendment.status !== 'REQUESTED'
        ? `This amendment is already ${amendment.status === 'SO_APPROVED' ? 'applied' : 'closed'} — it can no longer be rejected.`
        : `Cannot reject an amendment from status ${amendment.status}.`,
    }, 409);
  }
  const to = lane ? ('REJECTED' as AmendStatus) : nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:           to,
    version:          Number(amendment.version ?? 1) + 1,
    resolution:       'REJECTED',
    rejection_reason: reason,
    rejected_by:      await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    rejected_at:      new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }).eq('id', id)
    .eq('company_id', co.companyId) // see the note on the supplier-confirm write
    .eq('status', amendment.status)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, so_doc_no, amendment_no, status, resolution, rejection_reason, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_REJECTED',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [
      { field: 'amendment_status', from: amendment.status, to },
      { field: 'rejection_reason', to: reason },
    ],
    note: reason,
  });

  /* Tell the requester WHY (owner 2026-09-02). The reject gate already insists
     on a reason "because the person who raised it needs to know what to
     change" — until now that reason lived only on a screen they had no cause
     to reopen. This route writes outside runScmPgCommand, so the notice fires
     inline; it never throws. */
  {
    const audience = await resolvedAmendmentAudience(sb, c, amendment);
    await notifySoAmendmentResolved(c.env, {
      amendmentNo: amendment.amendment_no ?? '',
      soDocNo: amendment.so_doc_no,
      outcome: 'rejected',
      reason,
      actorName: c.get('houzsUser')?.name ?? actorName(user),
      actorUserId: c.get('houzsUser')?.id ?? null,
      requesterUserId: audience.requesterUserId,
      salespersonUserId: audience.salespersonUserId,
    });
  }

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/withdraw ───────────────────────────────────────────────────
   The REQUESTER pulling their own request back, as distinct from an approver
   refusing it (Owner 2026-07-19).

   Why this is not a reject: reject is gated to scm.amendment.approve_po, which
   a salesperson does not hold. Without a withdraw the person who raised a
   mistaken amendment had no way to close it and no way to correct it, so their
   only move was to raise ANOTHER one — which is how one Sales Order ended up
   carrying two or three competing amendment documents with nothing to say which
   was authoritative.

   Why it is not a new status: it lands on the same terminal REJECTED, which is
   what releases uq_so_amendment_open so a corrected request can be raised
   immediately. resolution = 'WITHDRAWN' (mig 0149) is what tells a reader the
   two apart. REQUESTED only — see the state machine's note. */
soAmendments.patch('/:id/withdraw', async (c) => {
  // WRITE: the company must RESOLVE. companyScope.ts's strict rule - an
  // unresolvable company is a condition to surface, never one to guess past.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* reason is optional here */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) {
    return c.json(MIRRORED_SO_READONLY, 409);
  }
  const { amendment } = loaded;

  /* Only the person who raised it, or someone who could have rejected it
     anyway. Checked against the caller's REAL scm.staff uuid — the bridge pins
     user.id to one shared system row, so comparing that would let ANY caller
     withdraw ANY amendment. */
  const callerStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  const { data: ownerRow } = await sb.from('so_amendments')
    .select('requested_by').eq('id', id).maybeSingle();
  const requestedBy = (ownerRow as { requested_by?: string | null } | null)?.requested_by ?? null;
  const isRequester = callerStaffId != null && requestedBy != null && callerStaffId === requestedBy;
  /* Two-lane rework: the "someone who could reject it anyway" fallback follows
     the row's lane key; legacy rows keep the original purchasing gate. */
  const withdrawLane = laneOf(amendment);
  const withdrawFallbackKey = withdrawLane ? LANE_APPROVE_KEY[withdrawLane] : 'scm.amendment.approve_po';
  if (!isRequester && !hasHouzsPerm(c, withdrawFallbackKey)) {
    return c.json({
      error: 'withdraw_forbidden',
      message: 'Only the person who raised this amendment can withdraw it.',
    }, 403);
  }

  const action: AmendAction = 'withdraw';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: amendment.status === 'REQUESTED'
        ? `Cannot withdraw an amendment from status ${amendment.status}.`
        : 'This amendment has already been acted on, so it can no longer be withdrawn. Ask an approver to reject it instead.',
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:           to,
    version:          Number(amendment.version ?? 1) + 1,
    resolution:       'WITHDRAWN',
    rejection_reason: reason || 'Withdrawn by the person who raised it.',
    rejected_by:      callerStaffId ?? user.id,
    rejected_at:      new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }).eq('id', id)
    .eq('company_id', co.companyId) // see the note on the supplier-confirm write
    .eq('status', amendment.status)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, so_doc_no, amendment_no, status, resolution, rejection_reason, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_WITHDRAWN',
    actorId: user.id,
    actorName: c.get('houzsUser')?.name ?? actorName(user),
    fieldChanges: [{ field: 'amendment_status', from: amendment.status, to }],
    note: reason || 'Withdrawn by the person who raised it.',
  });

  return c.json({ amendment: updated });
});

