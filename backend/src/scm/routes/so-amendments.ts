
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import {
  canTransition, nextStatus, type AmendStatus, type AmendAction,
  canLaneTransition, LANE_APPROVE_KEY, LANE_LABEL, type AmendmentLane,
} from '../shared';
import { applySoAmendment, reviseBoundPo, ReceivedFloorError } from '../lib/so-revision';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { raisePoFollowUps } from '../lib/amendment-po-followup';
import { DESK, judgeLaneHandover, judgeLaneMove } from '../lib/amendment-lane-handover';
import { countCancelRequestsAwaitingSigner } from '../lib/cancel-pending-count';
import { approveKeysFor } from '../shared/document-cancel';
import { CANCEL_REQUESTS_TABLE } from './document-cancel-routes';
import { hasHouzsPerm, holdsHouzsPermLiterally, canViewAllSales, canWriteScmConfig } from '../lib/houzs-perms';
import { resolveSalesScopeIds, soOwnedInScope, readSoOwnership, resolveCallerStaffId, resolveUserIdByStaffId } from '../lib/salesScope';
import {
  notifySoAmendmentResolved,
  notifySoAmendmentHandedOver,
  notifyPoAmendmentRaised,
} from '../../services/amendmentNotify';
import { collectProcessingGateProblems } from '../shared/so-save-problems';
import { canonicaliseSoHeaderChanges, soDateDay, soDatePairRefusal, withProcessingRemovalCascade } from '../shared/so-processing-date';
import { recordSoAudit } from '../lib/so-audit';
import { soHasLivePo, soHasUnreceivedPo } from '../lib/so-po-lock';
import { deliveryBroughtForward, deliveryNeedsPurchaserOk, poAwaitingSupplier, processingDateFrozenByPo, PROCESSING_DATE_PO_LOCKED, PROCESSING_DATE_PO_OVERRIDE_KEY, PURCHASER_OK_REQUIRED } from '../shared/so-po-date-rule';
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
import { loggedStepClock } from '../../lib/step-timing';
import { scheduleStockAllocationAfterCommand } from '../lib/stock-allocation-job';

export const soAmendments = new Hono<{ Bindings: Env; Variables: Variables }>();
soAmendments.use('*', supabaseAuth);

function actorName(user: { user_metadata?: { name?: string } } | undefined): string | null {
  return user?.user_metadata?.name ?? null;
}

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
  lane?: string | null;
  reason?: string | null;
  apply_lease_token?: string | null;
  apply_lease_expires_at?: string | null;
  /* Needed by the approve-time date-pair re-check (owner 2026-07-28). */
  header_changes?: Record<string, unknown> | null;
  requested_by?: string | null;
  lane_flag_note?: string | null;
  purchaser_ok_at?: string | null;
  po_date_override_by?: string | null;
};

const laneOf = (a: AmendmentForWrite): AmendmentLane | null =>
  a.lane === 'LINES' || a.lane === 'DELIVERY' || a.lane === 'PRICE' || a.lane === 'LINE_ADDREMOVE' ? a.lane : null;

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

const NOT_IN_LANE_FLOW = (what: string) => ({
  error: 'not_in_lane_flow',
  reason: `This amendment uses the two-lane flow — ${what}`,
});
const LEGACY_HAS_NO_DESK = {
  error: 'legacy_amendment',
  reason: 'This amendment predates the two-desk flow, so there is no other desk to pass it to.',
};
type AmendmentWriteLoad =
  | { ok: true; mirrored: false; amendment: AmendmentForWrite }
  | { ok: true; mirrored: true; amendment: AmendmentForWrite }
  | { ok: false; reason: 'not_found' };

async function loadAmendmentForWrite(
  sb: any,
  id: string,
  c: Context<any>,
): Promise<AmendmentWriteLoad> {
  const { data } = await scopeToCompany(
    sb.from('so_amendments')
      .select('id, so_doc_no, amendment_no, status, version, lane, reason, apply_lease_token, apply_lease_expires_at, header_changes, requested_by, lane_flag_note, purchaser_ok_at, po_date_override_by')
      .eq('id', id),
    c,
  ).maybeSingle();
  if (!data) return { ok: false, reason: 'not_found' };
  const amendment = data as AmendmentForWrite;
  return { ok: true, mirrored: isMirroredDocNo(amendment.so_doc_no) && !houzsOwns2990(c.env), amendment };
}

async function dispatchMirroredCommand(
  c: Context<any>,
  sb: any,
  amendment: AmendmentForWrite,
  action: AmendAction,
  payload: Record<string, unknown>,
) {
  if (!(await commandsEnabled(sb))) {
    return c.json(MIRRORED_SO_READONLY, 409);
  }
  const cfg = readBridgeCommandConfig(c.env);
  if (!cfg.ok) {
    return c.json({
      error: 'bridge_not_configured',
      message: 'The connection to 2990 is not set up yet, so this change cannot be sent to 2990. Nothing was queued.',
      missing: cfg.missing,
    }, 503);
  }

  let enq;
  try {
    enq = await enqueueAmendmentCommand(sb, {
      entityKey: amendment.id,
      action,
      payload,
      requestedBy: c.get('houzsUser')?.id ?? null,
      companyId: activeCompanyId(c) ?? null,
    });
  } catch {
    return c.json({
      error: 'command_enqueue_failed',
      message: 'Could not queue the change for 2990. Please try again.',
    }, 500);
  }

  if (enq.row.status === 'PENDING') {
    const dispatch = () => {
      const p = dispatchOne(c.get('supabase'), cfg.config, enq.row);
      try { c.executionCtx.waitUntil(p); } catch { void p; }
      return Promise.resolve();
    };
    if (sb?.__atomicCommand === true) deferScmAfterCommit(c, dispatch);
    else dispatch();
  }

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

const AMENDMENT_LIST_COLS = 'id, so_doc_no, amendment_no, status, lane, reason, lane_flag_note, requested_by, created_at, updated_at';
const AMENDMENT_LIST_CAP = 500;

soAmendments.get('/', async (c) => {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const { data, error } = scopeIds
    ? await paginateAll((from, to) => scopeToCompany(sb.from('so_amendments').select(AMENDMENT_LIST_COLS), c)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to))
    : await scopeToCompany(sb.from('so_amendments').select(AMENDMENT_LIST_COLS), c)
      .order('created_at', { ascending: false })
      .limit(AMENDMENT_LIST_CAP);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  let rows = (data ?? []) as Array<{ so_doc_no?: string | null; requested_by?: string | null }>;
  if (scopeIds && rows.length > 0) {
    const docNos = [...new Set(rows.map((r) => r.so_doc_no).filter((x): x is string => !!x))];
    const owned = await readSoOwnership(sb, docNos, (q) => scopeToCompany(q, c));
    if (owned.error) return c.json({ error: 'load_failed', reason: owned.error }, 500);
    rows = rows
      .filter((r) => (r.requested_by != null && scopeIds.includes(r.requested_by))
        || (r.so_doc_no != null && soOwnedInScope(scopeIds, owned.byDoc.get(r.so_doc_no))))
      .slice(0, AMENDMENT_LIST_CAP);
  }

  /* Bound-PO enrichment (owner 2026-07-27 — "这个应该出现在 PO Amendment"): each
     row carries the PO(s) its SO's lines were purchased on, the SAME linkage the
     detail's light bound-PO summary resolves (purchase_order_items.so_item_id →
     mfg_sales_order_items.id). The PO Amendments inbox merges the SO amendments
     that revise a bound PO alongside the direct po_amendments, so the purchasing
     team sees the whole revision queue in one place. Three reads over the
     ≤500-row page, never per-row, each batched by URL budget and paged
     (chunkIn), because the id lists ride in the request line: on 2026-09-15
     HOUZS's PO-line read already sent 10.6KB against the tree's 4KB budget,
     with ~19.5KB known to be refused. A failed read fails the list: both PO
     Amendments queues list an SO amendment only when bound_pos is non-empty, so
     an empty field from a failed read looked exactly like "never purchased" and
     the row left purchasing's queue with nothing to say why
     (docs/bugs/0930-an-so-amendment-left-the-po-amendments-queue-when-a-bound-po.md). */
  const boundBySo = new Map<string, Array<{ id: string; po_number: string; status: string }>>();
  const allDocNos = [...new Set(rows.map((r) => r.so_doc_no).filter((x): x is string => !!x))];
  if (allDocNos.length > 0) {
    const { data: soItemRows, error: soItemErr } = await chunkIn(allDocNos, (batch, from, to) =>
      sb.from('mfg_sales_order_items').select('id, doc_no').in('doc_no', batch).range(from, to));
    if (soItemErr) return c.json({ error: 'load_failed', reason: soItemErr.message }, 500);
    const soItemToDoc = new Map<string, string>();
    for (const r of soItemRows as Array<{ id: string; doc_no: string }>) soItemToDoc.set(r.id, r.doc_no);
    const soItemIds = [...soItemToDoc.keys()];
    if (soItemIds.length > 0) {
      const { data: poItemRows, error: poItemErr } = await chunkIn(soItemIds, (batch, from, to) =>
        sb.from('purchase_order_items').select('purchase_order_id, so_item_id').in('so_item_id', batch).range(from, to));
      if (poItemErr) return c.json({ error: 'load_failed', reason: poItemErr.message }, 500);
      const poToDocs = new Map<string, Set<string>>();
      for (const r of poItemRows as Array<{ purchase_order_id: string | null; so_item_id: string | null }>) {
        const doc = r.so_item_id ? soItemToDoc.get(r.so_item_id) : undefined;
        if (!r.purchase_order_id || !doc) continue;
        const set = poToDocs.get(r.purchase_order_id) ?? new Set<string>();
        set.add(doc);
        poToDocs.set(r.purchase_order_id, set);
      }
      const poIds = [...poToDocs.keys()];
      if (poIds.length > 0) {
        const { data: poRows, error: poErr } = await chunkIn(poIds, (batch, from, to) =>
          sb.from('purchase_orders').select('id, po_number, status').in('id', batch).range(from, to));
        if (poErr) return c.json({ error: 'load_failed', reason: poErr.message }, 500);
        for (const po of poRows as Array<{ id: string; po_number: string; status: string }>) {
          for (const doc of poToDocs.get(po.id) ?? []) {
            const list = boundBySo.get(doc) ?? [];
            list.push(po);
            boundBySo.set(doc, list);
          }
        }
      }
    }
  }
  /* The queue's Reference column (owner 2026-09-14: 「要加上reference number」) —
     the SO header's own customer reference. Sent RAW (`ref`, `customer_so_no`):
     the frontend resolves the cell with customerRefOf, the one display rule the
     Sales Order list already uses, so the two screens cannot show different
     references for one order. One read over the page's doc_nos, batched like
     the three above. A failed read fails the list like the main read does: a
     blank column would say "this order has no reference", which a failed read
     does not know. */
  const refBySo = new Map<string, { ref: string | null; customer_so_no: string | null }>();
  if (allDocNos.length > 0) {
    const { data: soRefRows, error: soRefErr } = await chunkIn(allDocNos, (batch, from, to) =>
      scopeToCompany(sb.from('mfg_sales_orders').select('doc_no, ref, customer_so_no').in('doc_no', batch), c)
        .range(from, to));
    if (soRefErr) return c.json({ error: 'load_failed', reason: soRefErr.message }, 500);
    for (const so of soRefRows as Array<{ doc_no: string; ref: string | null; customer_so_no: string | null }>) {
      refBySo.set(so.doc_no, so);
    }
  }
  const amendments = rows.map((r) => {
    const so = r.so_doc_no ? refBySo.get(r.so_doc_no) : undefined;
    return {
      ...r,
      bound_pos: r.so_doc_no ? (boundBySo.get(r.so_doc_no) ?? []) : [],
      so_ref: so?.ref ?? null,
      so_customer_so_no: so?.customer_so_no ?? null,
    };
  });
  return c.json({ amendments });
});

/* ── GET /pending-count — how many amendments are waiting for THIS caller ───
   Feeds the red count on the "Sales Order Amendment" sidebar entry (owner
   2026-09-09: "根据目前还有多少单需要被审批 — 在需要审批人员账号显示, 审批后就
   根据目前需要的单号改变").

   THE COUNT IS PER-SIGNER, NOT A GLOBAL BACKLOG. It counts only the lanes this
   caller can actually sign, so the badge answers "how much is waiting for ME".
   Someone who holds neither lane key gets 0 and the badge never renders — which
   is the whole "在需要审批人员账号显示" half of the ask: a number on a menu the
   reader cannot act on is worse than no number, because it never goes down for
   them no matter what they do.

   REQUESTED only — that is the one open state a lane row has (amendment-lane.ts
   state machine); everything else is terminal. Legacy (lane IS NULL) rows are
   counted for the legacy key holder for the same reason the gates still honour
   it: a finite backlog that still needs clearing.

   Registered BEFORE `/:id` — Hono matches in order, and a param route above
   this one would swallow "pending-count" as an amendment id.

   Fails SOFT with 0. A badge is decoration on someone else's screen; a count
   query that errors must not turn the sidebar into an error state. */
soAmendments.get('/pending-count', async (c) => {
  /* holdsHouzsPermLiterally, NOT hasHouzsPerm: the `*` wildcard must not put a
     count on the Owner account's menu (owner 2026-09-09). Same rule the notice
     audience already applied — a badge that carries every desk's backlog is a
     badge its reader learns to ignore, and the wildcard holder can still
     approve anything and still sees every row inside the module. */
  const lanes: string[] = [];
  if (holdsHouzsPermLiterally(c, LANE_APPROVE_KEY.LINES)) lanes.push('LINES');
  if (holdsHouzsPermLiterally(c, LANE_APPROVE_KEY.DELIVERY)) lanes.push('DELIVERY');
  if (holdsHouzsPermLiterally(c, LANE_APPROVE_KEY.PRICE)) lanes.push('PRICE');
  if (holdsHouzsPermLiterally(c, LANE_APPROVE_KEY.LINE_ADDREMOVE)) lanes.push('LINE_ADDREMOVE');
  const legacy = holdsHouzsPermLiterally(c, 'scm.amendment.approve_so');
  /* Cancellations sit in this queue too since owner 2026-09-24 (「当有 SO request
     cancel bill - 需要在 SO amendment 出现」), so the badge over it counts them
     as well — a number that stops at the amendments under-states the desk. */
  const cancelKeys = approveKeysFor('SO').filter((k) => holdsHouzsPermLiterally(c, k));
  if (lanes.length === 0 && !legacy && cancelKeys.length === 0) return c.json({ count: 0 });

  const sb = c.get('supabase');
  let amendments = 0;
  let cancellations = 0;
  if (lanes.length > 0 || legacy) {
    try {
      const { data, error } = await scopeToCompany(
        sb.from('so_amendments').select('id, lane').eq('status', 'REQUESTED'),
        c,
      );
      if (error) {
        console.error('[so-amendment] pending-count failed:', error.message);
      } else {
        const rows = data as Array<{ lane: string | null }>;
        amendments = rows.filter((r) => (r.lane == null ? legacy : lanes.includes(r.lane))).length;
      }
    } catch (e) {
      console.error('[so-amendment] pending-count threw:', (e as Error).message);
    }
  }
  if (cancelKeys.length > 0) {
    try {
      const { data, error } = await scopeToCompany(
        sb.from(CANCEL_REQUESTS_TABLE)
          .select('doc_type, status, requested_by, l1_by')
          .eq('doc_type', 'SO')
          .in('status', ['REQUESTED', 'L1_APPROVED']),
        c,
      );
      if (error) {
        console.error('[so-amendment] pending-count cancel read failed:', error.message);
      } else {
        cancellations = countCancelRequestsAwaitingSigner(
          (data ?? []) as Array<{ doc_type: string; status: string; requested_by: number | null; l1_by: number | null }>,
          { userId: c.get('houzsUser')?.id ?? null, holds: (k) => holdsHouzsPermLiterally(c, k) },
        );
      }
    } catch (e) {
      console.error('[so-amendment] pending-count cancel read threw:', (e as Error).message);
    }
  }
  return c.json({ count: amendments + cancellations, amendments, cancellations });
});

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

soAmendments.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [amdRes, lineRes] = await Promise.all([
    scopeToCompany(sb.from('so_amendments')
      .select('id, so_doc_no, amendment_no, status, lane, reason, lane_flag_note, requested_by, ' +
        'supplier_confirmed_by, supplier_confirmation_ref, supplier_confirmation_note, ' +
        'supplier_confirmation_attachment_key, so_approved_by, so_approved_at, ' +
        'po_approved_by, po_approved_at, sent_at, created_at, updated_at, ' +
      'rejected_by, rejected_at, rejection_reason, resolution, edited_at, edit_count, ' +
        'purchaser_ok_by, purchaser_ok_at, po_date_override_by, ' +
        'header_changes, old_header_snapshot')
      .eq('id', id), c).maybeSingle(),
    sb.from('so_amendment_lines')
      .select('id, amendment_id, sales_order_item_id, change_type, new_item_code, ' +
        'new_variants, new_qty, new_unit_price_sen, new_remark, new_discount_sen, old_snapshot')
      .eq('amendment_id', id),
  ]);
  if (amdRes.error) return c.json({ error: 'load_failed', reason: amdRes.error.message }, 500);
  if (!amdRes.data) return c.json({ error: 'not_found' }, 404);
  // company-scope: prove the parent amendment — its read above is scopeToCompany'd and 404s first; the lines, bound POs and PO follow-ups below are its children, keyed by that id or its SO.
  const amendment = amdRes.data as unknown as { so_doc_no: string; requested_by?: string | null } & Record<string, unknown>;
  const lines = (lineRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  const { data: soRow } = await scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, status, revision, salesperson_id, access_staff_ids, customer_delivery_date')
    .eq('doc_no', amendment.so_doc_no), c).maybeSingle();
  const salesOrder = (soRow ?? null) as
    { doc_no: string; status: string; revision: number; salesperson_id?: number | string | null; access_staff_ids?: string[] | null; customer_delivery_date?: string | null } | null;

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  if (scopeIds
    && !(amendment.requested_by != null && scopeIds.includes(amendment.requested_by))
    && !soOwnedInScope(scopeIds, salesOrder)) {
    return c.json({ error: 'not_found' }, 404);
  }

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

  let poFollowUps: Array<Record<string, unknown>> = [];
  {
    const { data: fuRows } = await sb.from('po_amendments')
      .select('id, po_id, po_number, amendment_no, status, resolution, approved_at, rejected_at, created_at')
      .eq('source_so_amendment_id', id)
      .order('created_at', { ascending: true });
    poFollowUps = (fuRows ?? []) as Array<Record<string, unknown>>;
  }

  const callerStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  const viewerIsRequester = callerStaffId != null && amendment.requested_by != null
    && callerStaffId === amendment.requested_by;

  const requestedDeliv = canonicaliseSoHeaderChanges(
    (amendment.header_changes ?? null) as Record<string, unknown> | null,
  )?.['customerDeliveryDate'];
  const purchaserOkRequired = amendment.lane === 'DELIVERY' && amendment.status === 'REQUESTED'
    && deliveryNeedsPurchaserOk({
      storedDeliv: soDateDay(salesOrder?.customer_delivery_date),
      nextDeliv: requestedDeliv === undefined ? null : soDateDay(requestedDeliv as string | null),
      hasUnreceivedPo: purchaseOrders.some((p) => poAwaitingSupplier(p.status)),
    });

  return c.json({ amendment, lines, salesOrder, purchaseOrders, poFollowUps, viewerIsRequester, purchaserOkRequired });
});

soAmendments.patch('/:id/supplier-confirm', async (c) => {
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

export async function approveSoCommandHandler(c: any, sb: any, lap: (step: string) => void = () => {}): Promise<Response> {
  const id = c.req.param('id'); const user = c.get('user');

  const loaded = await loadAmendmentForWrite(sb, id, c);
  lap('load');
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
  const headerChanges = canonicaliseSoHeaderChanges(amendment.header_changes ?? null);
  if (headerChanges && ('processingDate' in headerChanges || 'customerDeliveryDate' in headerChanges)) {
    const { data: soDates } = await sb.from('mfg_sales_orders')
      .select('processing_date, customer_delivery_date, debtor_name, address1, postcode')
      .eq('doc_no', amendment.so_doc_no)
      .maybeSingle();
    const cur = (soDates ?? {}) as { processing_date?: string | Date | null; customer_delivery_date?: string | Date | null };
    /* soDateDay, NOT `String(v).slice(0, 10)`. This handler runs inside
       runScmPgCommand, whose postgres.js shim returns a DATE column as a JS
       Date object; `String(date).slice(0, 10)` is 'Fri Aug 28', which sorts
       after every '2026-…' string, so the order re-check below refused a legal
       Delivery Date amendment on 2990-SO-2606-011 (2026-09-04) with a message
       the frontend then dropped as too long. See docs/bugs/0636. */
    const ymd = soDateDay;
    const nextProc = 'processingDate' in headerChanges
      ? ymd(headerChanges['processingDate'])
      : ymd(cur.processing_date);
    const effective = withProcessingRemovalCascade(headerChanges, {
      processingDate: cur.processing_date, deliveryDate: cur.customer_delivery_date,
    });
    const nextDeliv = 'customerDeliveryDate' in effective
      ? ymd(effective['customerDeliveryDate'])
      : ymd(cur.customer_delivery_date);
    const stalePair = soDatePairRefusal({
      nextProc, nextDeliv,
      origProc: ymd(cur.processing_date),
      origDeliv: ymd(cur.customer_delivery_date),
    });
    if (stalePair) {
      return c.json({
        error: 'amendment_dates_pair_stale',
        message:
          `Approving this would leave the order with only one date ` +
          `(Processing ${nextProc || '—'}, Delivery ${nextDeliv || '—'}). ` +
          'Reject it and re-request both dates together.',
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
        message:
          `Approving this would put the Processing Date (${nextProc}) after the Delivery Date (${nextDeliv}). ` +
          'Reject it and re-request both dates together.',
        reason:
          `Approving this would put the Processing Date (${nextProc}) after the Delivery Date (${nextDeliv}). ` +
          'The other half of the paired reschedule was rejected, or the order\'s dates have moved since this ' +
          'was requested — reject this amendment and re-request both dates together.',
      }, 409);
    }

    const origProc = ymd(cur.processing_date);
    const poDateOverridden = Boolean(amendment.po_date_override_by) || hasHouzsPerm(c, PROCESSING_DATE_PO_OVERRIDE_KEY);
    const procMoves = 'processingDate' in headerChanges && origProc !== '' && nextProc !== origProc && !poDateOverridden;
    const delivForward = lane === 'DELIVERY' && 'customerDeliveryDate' in headerChanges
      && deliveryBroughtForward(ymd(cur.customer_delivery_date), nextDeliv);
    const hasLivePo = procMoves && await soHasLivePo(sb, amendment.so_doc_no);
    if (!poDateOverridden && processingDateFrozenByPo({ storedProc: origProc, nextProc, hasLivePo })) {
      return c.json(PROCESSING_DATE_PO_LOCKED, 409);
    }
    if (delivForward && !amendment.purchaser_ok_at && await soHasUnreceivedPo(sb, amendment.so_doc_no)) {
      return c.json(PURCHASER_OK_REQUIRED, 409);
    }

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

  lap('date-gates');
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
  lap('claim');

  let applied: { soDocNo: string; revision: number; addedLineIds: string[] };
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
    lap('apply');
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
    /* HC-0004: the DB floor (mig 20261014T1420) refused a qty cut below what
       live delivery orders already ship — one raced in after the freeze read. */
    if (e instanceof Error && e.message.includes('so_line_over_delivered')) {
      return c.json({
        error: 'qty_below_delivered',
        message: 'A Delivery Order has just shipped this Sales Order line. Its qty can no longer be cut below what was delivered. Refresh and check the order.',
        reason: e.message,
      }, 409);
    }
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
  lap('status');

  /* Two-lane rework — the product-line lanes' PO leg: raise the follow-up PO
     Amendment(s) INSIDE this same transaction (runScmPgCommand), so the SO
     revision and the purchaser's to-do commit or roll back together. The
     purchaser confirms them in PO Amendments (their second signature), where
     the apply is reviseBoundPo scoped to that one PO. BOTH LINES (spec / qty)
     and LINE_ADDREMOVE (a product line added / cancelled, signed by the Sales
     Director — owner 2026-11-16) carry changes the supplier must follow, so both
     raise the follow-up; raisePoFollowUps filters to the PO-relevant lines, so a
     half with nothing for the PO raises nothing. DELIVERY lane and legacy rows
     never reach this: DELIVERY never touches a PO, legacy uses approve-po. */
  let poFollowUps: Awaited<ReturnType<typeof raisePoFollowUps>> = { followUps: [], warnings: [] };
  if (lane === 'LINES' || lane === 'LINE_ADDREMOVE') {
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

  lap('po-follow-ups');
  await enqueueEdit(sb, {
    companyId: activeCompanyId(c),
    docType: 'SO',
    docNo: amendment.so_doc_no,
    createdBy: c.get('houzsUser')?.id ?? null,
    /* Lines this amendment ADDED carry no AutoCount key yet; declare them NEW so
       composeEdit appends them instead of refusing the whole document as keyless
       (docs/bugs/0942). Existing lines already carry keys, which is the condition
       composeEdit requires before it honours a new line. */
    newLineIds: applied.addedLineIds,
  });
  lap('ac-enqueue');

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

  lap('notice-audience');
  await scheduleStockAllocationAfterCommand(c, sb, `amendment-approve-so:${amendment.so_doc_no}`);
  lap('alloc-schedule');
  return c.json({
    amendment: updated,
    revision: applied.revision,
    poFollowUps: poFollowUps.followUps,
    warnings: poFollowUps.warnings,
  });
}
/* HC-0167: logged laps, so an approve the browser gave up on at 30 s still says
   which step took the time ('tx-begin' = waiting for a connection). */
soAmendments.patch('/:id/approve-so', (c) => {
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  const lap = loggedStepClock('approve-so', 'db-pg');
  return runScmPgCommand(c, (sb) => { lap('tx-begin'); return approveSoCommandHandler(c, sb, lap); })
    .finally(() => lap('commit-and-notices'));
});

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

soAmendments.patch('/:id/send', async (c) => {
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
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return c.json({
      error: 'reason_required',
      message: 'Give a reason for rejecting this amendment — the person who raised it needs to know what to change.',
    }, 400);
  }

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
    .eq('company_id', co.companyId)
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

/* ── PATCH /:id/purchaser-ok ───────────────────────────────────────────────
   BUG-101 (owner 2026-10-12): a Logistic-lane request that brings the Delivery
   Date forward on an order with a live PO needs the Purchaser too. The
   Purchaser checks with the supplier and records the OK here; nothing is
   applied. Logistic's approve then runs as usual. Gated on the Purchaser's
   lane key. A Purchaser who disagrees tells Logistic, who rejects it. */
soAmendments.patch('/:id/purchaser-ok', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, LANE_APPROVE_KEY.LINES)) {
    return c.json({
      error: 'purchaser_ok_forbidden',
      message: 'Only a Purchaser can OK a Delivery Date brought forward.',
    }, 403);
  }
  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) return c.json(MIRRORED_SO_READONLY, 409);
  const { amendment } = loaded;
  if (laneOf(amendment) !== 'DELIVERY' || amendment.status !== 'REQUESTED') {
    return c.json({
      error: 'bad_transition',
      message: 'Only an open Logistic amendment can take a Purchaser OK.',
    }, 409);
  }
  if (amendment.purchaser_ok_at) {
    return c.json({ error: 'already_ok', message: 'A Purchaser has already OK\'d this amendment.' }, 409);
  }

  const headerChanges = canonicaliseSoHeaderChanges(amendment.header_changes ?? null) ?? {};
  const { data: soRow, error: soErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('customer_delivery_date').eq('doc_no', amendment.so_doc_no),
    c,
  ).maybeSingle();
  if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);
  const needed = 'customerDeliveryDate' in headerChanges && deliveryNeedsPurchaserOk({
    storedDeliv: soDateDay((soRow as { customer_delivery_date?: unknown } | null)?.customer_delivery_date),
    nextDeliv: soDateDay(headerChanges['customerDeliveryDate']),
    hasUnreceivedPo: await soHasUnreceivedPo(sb, amendment.so_doc_no),
  });
  if (!needed) {
    return c.json({
      error: 'purchaser_ok_not_needed',
      message: 'This amendment does not bring the Delivery Date forward on an order with a Purchase Order still to be received, so Logistic approves it alone.',
    }, 409);
  }

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    purchaser_ok_by: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    purchaser_ok_at: now,
    version:         amendment.version + 1,
    updated_at:      now,
  }).eq('id', id)
    .eq('company_id', co.companyId)
    .eq('status', 'REQUESTED')
    .eq('version', amendment.version)
    .select('id, so_doc_no, amendment_no, status, purchaser_ok_by, purchaser_ok_at, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_PURCHASER_OK',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [
      { field: 'amendment_id', to: amendment.id },
      { field: 'customer_delivery_date', to: String(headerChanges['customerDeliveryDate'] ?? '') },
    ],
    note: `Purchaser OK for ${amendment.amendment_no ?? 'the amendment'}: Delivery Date brought forward to ${String(headerChanges['customerDeliveryDate'] ?? '')}. Waiting for Logistic approval.`,
  });

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/flag-lane ──────────────────────────────────────────────────
   The APPROVER, reviewing a request on their desk, saying it is not theirs to
   sign — and the request MOVES to the other desk (owner 2026-09-17, option B;
   the requester cannot judge the desk, the approver reading the change can).
   Gated on the row's own lane key. lib/amendment-lane-handover decides whether
   the move is safe: a change the Purchase Order has to follow never leaves the
   Purchaser. ONCE per amendment — a row that already carries a handover note
   cannot be passed back, so two desks cannot bounce it between them; the
   second desk approves or rejects. */
soAmendments.patch('/:id/flag-lane', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  let body: { note?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!note) {
    return c.json({
      error: 'note_required',
      message: 'Say why this is not yours to approve — that note is what the other desk reads.',
    }, 400);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const lane = laneOf(loaded.amendment);
  if (!lane) return c.json(LEGACY_HAS_NO_DESK, 409);
  // The Sales Director's lanes have no "other desk" — a price-only change (owner
  // 2026-09-21) and a product line add/cancel (owner 2026-11-16) are the Sales
  // Director's alone, approved or rejected in place. Handover is the
  // LINES<->DELIVERY move; neither is ever passed on.
  if (lane === 'PRICE' || lane === 'LINE_ADDREMOVE') {
    return c.json({
      error: 'price_lane_no_handover',
      reason: "This amendment is the Sales Director's to approve or reject — it cannot be passed to another desk.",
    }, 409);
  }
  if (!hasHouzsPerm(c, LANE_APPROVE_KEY[lane])) {
    return c.json({
      error: 'flag_forbidden',
      message: `Only an approver of the ${LANE_LABEL[lane]} lane can pass this amendment to the other desk.`,
    }, 403);
  }
  if (loaded.mirrored) return c.json(MIRRORED_SO_READONLY, 409);
  const { amendment } = loaded;
  if (amendment.status !== 'REQUESTED') {
    return c.json({
      error: 'bad_transition',
      reason: 'This amendment has already been acted on, so it can no longer be passed to the other desk.',
    }, 409);
  }
  if ((amendment.lane_flag_note ?? '').trim()) {
    return c.json({
      error: 'already_handed_over',
      reason: 'This amendment was already passed over from the other desk once. Approve it, or reject it with a reason.',
    }, 409);
  }

  const verdict = await judgeLaneHandover(sb, c, {
    id: amendment.id, so_doc_no: amendment.so_doc_no, lane, header_changes: amendment.header_changes ?? null,
  });
  if (!verdict.ok) return c.json({ error: verdict.error, reason: verdict.reason }, verdict.status);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    lane:           verdict.toLane,
    lane_flag_note: note,
    version:        Number(amendment.version ?? 1) + 1,
    updated_at:     new Date().toISOString(),
  }).eq('id', id)
    .eq('company_id', co.companyId)
    .eq('status', 'REQUESTED')
    .eq('lane', lane)
    .eq('version', Number(amendment.version ?? 1))
    .select('id, so_doc_no, amendment_no, status, lane, lane_flag_note, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_LANE_FLAGGED',
    actorId: user.id,
    actorName: c.get('houzsUser')?.name ?? actorName(user),
    fieldChanges: [
      { field: 'lane', from: lane, to: verdict.toLane },
      { field: 'lane_flag_note', to: note },
    ],
    note,
  });

  await notifySoAmendmentHandedOver(c.env, {
    amendmentNo: amendment.amendment_no ?? '',
    soDocNo: amendment.so_doc_no,
    fromLane: lane,
    toLane: verdict.toLane,
    companyId: co.companyId,
    note,
    actorName: c.get('houzsUser')?.name ?? actorName(user),
    actorUserId: c.get('houzsUser')?.id ?? null,
    requesterUserId: await resolveUserIdByStaffId(sb, amendment.requested_by),
    byAdmin: false,
  });

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/lane ────────────────────────────────────────────────────────
   A SUPER ADMIN (the * wildcard) choosing which desk signs an open request
   (owner 2026-09-25: "super admin 直接在 SO amendment 修改 approver"). Any of
   the three lanes, any number of times, but through the same safety judge as
   the approver's handover (lib/amendment-lane-handover judgeLaneMove): a change
   the Purchase Order must follow never leaves LINES, and only a pure
   price/discount change lands on PRICE. A note is required — it is what the
   receiving desk reads and what History keeps. */
soAmendments.patch('/:id/lane', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, '*')) {
    return c.json({ error: 'forbidden', message: 'Only a super admin can change who approves an amendment.' }, 403);
  }
  let body: { lane?: string; note?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { }
  const toLane = body.lane === 'LINES' || body.lane === 'DELIVERY' || body.lane === 'PRICE' ? body.lane : null;
  if (!toLane) return c.json({ error: 'bad_lane', message: 'Choose Purchaser, Logistic or Sales Director.' }, 400);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!note) return c.json({ error: 'note_required', message: 'Say why the approver is changing — the new desk reads it.' }, 400);

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  const lane = laneOf(loaded.amendment);
  if (!lane) return c.json(LEGACY_HAS_NO_DESK, 409);
  if (loaded.mirrored) return c.json(MIRRORED_SO_READONLY, 409);
  const { amendment } = loaded;
  if (amendment.status !== 'REQUESTED') {
    return c.json({ error: 'bad_transition', reason: 'This amendment has already been acted on, so its approver can no longer change.' }, 409);
  }
  if (lane === toLane) return c.json({ error: 'same_lane', reason: `It is already waiting on the ${DESK[lane]} desk.` }, 409);

  const verdict = await judgeLaneMove(sb, c, {
    id: amendment.id, so_doc_no: amendment.so_doc_no, lane, header_changes: amendment.header_changes ?? null,
  }, toLane);
  if (!verdict.ok) return c.json({ error: verdict.error, reason: verdict.reason }, verdict.status);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    lane:       toLane,
    version:    Number(amendment.version) + 1,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
    .eq('company_id', co.companyId)
    .eq('status', 'REQUESTED')
    .eq('lane', lane)
    .eq('version', Number(amendment.version))
    .select('id, so_doc_no, amendment_no, status, lane, lane_flag_note, version')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) return c.json({ error: 'amendment_version_conflict' }, 409);

  const who = c.get('houzsUser')?.name ?? actorName(user);
  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_LANE_CHANGED',
    actorId: user.id,
    actorName: who,
    fieldChanges: [{ field: 'lane', from: lane, to: toLane }],
    note,
  });

  await notifySoAmendmentHandedOver(c.env, {
    amendmentNo: amendment.amendment_no ?? '',
    soDocNo: amendment.so_doc_no,
    fromLane: lane,
    toLane,
    companyId: co.companyId,
    note,
    actorName: who,
    actorUserId: c.get('houzsUser')?.id ?? null,
    requesterUserId: await resolveUserIdByStaffId(sb, amendment.requested_by),
    byAdmin: true,
  });

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
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) {
    return c.json(MIRRORED_SO_READONLY, 409);
  }
  const { amendment } = loaded;

  const callerStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  const { data: ownerRow } = await sb.from('so_amendments')
    .select('requested_by').eq('id', id).maybeSingle();
  const requestedBy = (ownerRow as { requested_by?: string | null } | null)?.requested_by ?? null;
  const isRequester = callerStaffId != null && requestedBy != null && callerStaffId === requestedBy;
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
    .eq('company_id', co.companyId)
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

