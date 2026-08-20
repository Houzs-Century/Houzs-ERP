// ----------------------------------------------------------------------------
// /purchase-consignment-orders — PC Orders to suppliers for goods held on
// CONSIGNMENT (the supplier's stock parked at MY warehouse).
//
// ORDER-ONLY (no inventory): a Purchase Consignment Order itself writes NO
// inventory_movements — it is just the order. (Its receive/return children ARE
// on-ledger since 2026-06-05: the receive books an IN, the return an OUT.) The
// goods remain the supplier's until a future settlement converts them into a
// real owned-stock GRN. This route is a faithful
// clone of /mfg-purchase-orders (apps/api/src/routes/mfg-purchase-orders.ts) with
// the owned-PO pipeline stripped out:
//   • DROPPED: the MRP shortage picker (/outstanding-so-items), the From-SO bulk
//     converter (/from-sos), per-line so_item_id linkage + recomputeSoPicked,
//     and the GRN-receipt rollups (poLineReceipts) that point at the real grns
//     table. None of those apply off the owned-stock pipeline.
//   • KEPT: create (header + items, full variant/pricing), line CRUD, header
//     PATCH, list, detail, status lifecycle (submit/cancel). The
//     downstream lock now points at purchase_consignment_receives (a PC Order
//     locks once it has any non-cancelled PC Receive), NOT the real grns table.
//
// Tables: purchase_consignment_orders / purchase_consignment_order_items
//   (migration 0154). PK is UUID `id` + `pc_number TEXT UNIQUE`.
// Numbering: PCO-YYMM-NNN.
//
// Endpoints:
//   GET   /purchase-consignment-orders               — list with filters
//   GET   /purchase-consignment-orders/:id           — detail (header + items)
//   GET   /purchase-consignment-orders/:id/linked     — downstream receives/returns
//   POST  /purchase-consignment-orders               — create PC Order from items
//   PATCH /purchase-consignment-orders/:id           — update header
//   POST  /purchase-consignment-orders/:id/items     — add a line
//   PATCH /purchase-consignment-orders/:id/items/:itemId — edit a line
//   DELETE /purchase-consignment-orders/:id/items/:itemId — delete a line
//   PATCH /purchase-consignment-orders/:id/submit    — idempotent (no-op) submit
//   PATCH /purchase-consignment-orders/:id/cancel    — flip → CANCELLED (terminal)
//
// There is NO document delete. A DELETE /:id used to purge a CANCELLED PC Order
// outright; it was removed 2026-08-11 under the owner rule 不可以删只可以
// cancel. See the block at the end of this file, docs/modules/
// purchase-consignment-order.md, and docs/hard-delete-inventory.md.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { buildVariantSummary } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { supabaseAuth } from '../middleware/auth';
import { VALID_CURRENCIES, VALID_KINDS } from '../lib/purchase-doc-vocab';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { changedLockedCols, identityLockedRefusal } from '../shared/header-inherited-lock';
import { PCO_LOCK_COLS, PCO_LOCK_LABELS } from '../shared/document-policy';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const purchaseConsignmentOrders = new Hono<{ Bindings: Env; Variables: Variables }>();

purchaseConsignmentOrders.use('*', supabaseAuth);

/* ── PC Order child-lock guard (Tier 2 — downstream lock) ────────────────────
   A PC Order locks (read-only — no header edit / no line edit / no cancel) once
   it has ANY non-cancelled PC Receive. Mirrors poHasDownstream in
   apps/api/src/routes/mfg-purchase-orders.ts, but points at
   purchase_consignment_receives instead of the real grns table. Returns the
   blocking JSON, or null if the PC Order is free to edit. */
/* Header field-level lock — column set + labels from the ONE rulebook
   (shared/document-policy.ts); mirrors the mfg PO. */
const PCO_IDENTITY_LOCK_COLS = PCO_LOCK_COLS;
const PCO_IDENTITY_LABELS = PCO_LOCK_LABELS;

async function pcoHasDownstream(sb: any, pcoId: string): Promise<{ error: string; message: string } | null> {
  const { count, error } = await sb.from('purchase_consignment_receives')
    .select('id', { head: true, count: 'exact' })
    .eq('purchase_consignment_order_id', pcoId)
    .neq('status', 'CANCELLED');
  /* A failed count is not zero (mirrors scm/lib/downstream-lock.ts). Dropping
     the error made `count ?? 0` read as "no PC Receive", which is the very
     absence that authorises the cancel / line edit this guard exists to refuse.
     A failed read must never read as an absence when the absence is what
     authorises the write — so an unreadable count locks too. */
  if (error) {
    return { error: 'downstream_check_failed', message: `Could not check whether this PC Order has a Consignment Receive, so it is locked for safety — try again (${error.message}).` };
  }
  if ((count ?? 0) > 0) {
    /* "cancel it first", not "delete it": a PC Receive has no delete either
       (only PATCH /:id/cancel), so the old "delete or cancel" wording told the
       user to do something the API does not offer. */
    return { error: 'pco_has_downstream', message: 'PC Order has a Consignment Receive — cancel it first to edit' };
  }
  return null;
}

/* VALID_STATUSES is NOT shared with the Purchase Order: a PCO has no DRAFT
   state — it is raised straight to SUBMITTED. See purchase-doc-vocab.ts and
   tests/purchaseDocVocab.test.ts. */
const VALID_STATUSES = new Set(['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']);

const HEADER_COLS =
  'id, pc_number, supplier_id, status, po_date, expected_at, currency, ' +
  'subtotal_sen, tax_sen, total_sen, notes, submitted_at, received_at, ' +
  'cancelled_at, created_at, created_by, updated_at, ' +
  'purchase_location_id, ' +
  /* supplier-revised header delivery dates (migration 0181) */
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4';

const ITEM_COLS =
  'id, purchase_consignment_order_id, binding_id, material_kind, item_code, material_name, ' +
  'supplier_sku, qty, unit_price_sen, line_total_sen, received_qty, notes, created_at, ' +
  /* variant fields (migration 0056) */
  'item_group, description, description2, uom, discount_sen, unit_cost_sen, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, variants, ' +
  /* per-line delivery date + ship-to warehouse */
  'delivery_date, warehouse_id, ' +
  /* supplier-revised per-line delivery dates (migration 0181) */
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4';

// ── List ──────────────────────────────────────────────────────────────
purchaseConsignmentOrders.get('/', async (c) => {
  const status = c.req.query('status');
  const supplierId = c.req.query('supplierId');
  const supabase = c.get('supabase');

  let q = supabase
    .from('purchase_consignment_orders')
    .select(
      `${HEADER_COLS}, supplier:suppliers(id, code, name), items:purchase_consignment_order_items(item_code, material_name, qty)`,
    )
    .order('po_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (status && VALID_STATUSES.has(status)) q = q.eq('status', status);
  if (supplierId) q = q.eq('supplier_id', supplierId);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* Tier 2 downstream-lock — stamp has_children on every PC Order row from the
     distinct PC-order ids that have any non-cancelled PC Receive, so the list
     grid can hide Edit / Cancel from locked rows. */
  const rows = (data ?? []) as Array<{ id: string } & Record<string, unknown>>;
  const childIds = new Set<string>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const { data: recvRows } = await supabase
      .from('purchase_consignment_receives')
      .select('purchase_consignment_order_id')
      .in('purchase_consignment_order_id', ids)
      .neq('status', 'CANCELLED');
    for (const g of (recvRows ?? []) as Array<{ purchase_consignment_order_id: string | null }>) {
      if (g.purchase_consignment_order_id) childIds.add(g.purchase_consignment_order_id);
    }
  }
  const purchaseConsignmentOrdersList = rows.map((r) => ({ ...r, has_children: childIds.has(r.id) }));
  return c.json({ purchaseOrders: purchaseConsignmentOrdersList });
});

/* Per-line receive breakdown — which PC Receive(s) each PC Order line was
   received into (one entry per receive line), carrying the receive number + net
   qty + status. The PC Order counterpart of poLineReceipts. Cancelled receives
   are excluded. Net qty = qty_accepted − returned_qty; zero/negative nets are
   dropped. Read-only display aid — no inventory. */
export type PcoLineReceipt = { receiveNumber: string; qty: number; status: string };
async function pcoLineReceipts(
  sb: any,
  pcoItemIds: string[],
): Promise<Map<string, PcoLineReceipt[]>> {
  const out = new Map<string, PcoLineReceipt[]>();
  if (pcoItemIds.length === 0) return out;
  const { data: recvLines } = await sb
    .from('purchase_consignment_receive_items')
    .select('pc_order_item_id, qty_accepted, returned_qty, pc_receive_id')
    .in('pc_order_item_id', pcoItemIds);
  const rows = (recvLines ?? []) as Array<{ pc_order_item_id: string | null; qty_accepted: number; returned_qty: number; pc_receive_id: string }>;
  const recvIds = [...new Set(rows.map((r) => r.pc_receive_id).filter(Boolean))];
  if (recvIds.length === 0) return out;
  const { data: receives } = await sb.from('purchase_consignment_receives').select('id, receive_number, status').in('id', recvIds);
  const recvMeta = new Map<string, { receiveNumber: string; status: string }>();
  for (const g of (receives ?? []) as Array<{ id: string; receive_number: string | null; status: string | null }>) {
    if ((g.status ?? '').toUpperCase() === 'CANCELLED') continue;
    recvMeta.set(g.id, { receiveNumber: g.receive_number ?? '—', status: (g.status ?? '').toUpperCase() });
  }
  for (const r of rows) {
    if (!r.pc_order_item_id) continue;
    const meta = recvMeta.get(r.pc_receive_id);
    if (!meta) continue; // cancelled receive — excluded
    const net = Number(r.qty_accepted ?? 0) - Number(r.returned_qty ?? 0);
    if (net <= 0) continue;
    const arr = out.get(r.pc_order_item_id) ?? [];
    arr.push({ receiveNumber: meta.receiveNumber, qty: net, status: meta.status });
    out.set(r.pc_order_item_id, arr);
  }
  return out;
}

// ── Detail ────────────────────────────────────────────────────────────
purchaseConsignmentOrders.get('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const [headerRes, itemsRes] = await Promise.all([
    scopeToCompany(supabase
      .from('purchase_consignment_orders')
      .select(`${HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address)`)
      .eq('id', id), c)
      .maybeSingle(),
    supabase.from('purchase_consignment_order_items').select(ITEM_COLS).eq('purchase_consignment_order_id', id).order('created_at'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  /* Tier 2 downstream-lock — stamp has_children on the detail header so the PC
     Order Detail page can lock once any non-cancelled PC Receive exists. */
  const { count: childCount } = await supabase.from('purchase_consignment_receives')
    .select('id', { head: true, count: 'exact' })
    .eq('purchase_consignment_order_id', id)
    .neq('status', 'CANCELLED');
  const purchaseConsignmentOrder = {
    ...(headerRes.data as Record<string, unknown>),
    has_children: (childCount ?? 0) > 0,
  };

  /* Per-line receive breakdown so the PC Order list expansion can show a
     "Received" column (which PC Receive took how much). */
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; PC lines expose `item_code`, so sort a shimmed view
     that carries the original row back unchanged. `.order('created_at')` above
     stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type PcoItemRow = Record<string, unknown> & { id: string; item_code: string };
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((itemsRes.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; item_code: string }>)
        .map((it): PcoItemRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const receiptsMap = await pcoLineReceipts(supabase, itemRows.map((it) => it.id));
  const items = itemRows.map((it) => ({ ...it, receipts: receiptsMap.get(it.id) ?? [] }));

  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(supabase, c, items);
  return c.json({ purchaseOrder: purchaseConsignmentOrder, items });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// Returns the PC Receives + PC Returns that descend from this PC Order.
purchaseConsignmentOrders.get('/:id/linked', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');

  /* Prove the PC Order belongs to the active company BEFORE fanning out. This
     read was the only one on the router with no company scope, so a caller in
     one company could resolve another company's PCO to its receive/return
     numbers by id (found 2026-08-12 by code read; the module guide claimed
     scoping that was absent). 404 rather than 403: an unreachable row must not
     confirm its own existence. */
  const owner = await scopeToCompany(
    sb.from('purchase_consignment_orders').select('id').eq('id', id),
    c,
  ).maybeSingle();
  if (owner.error) return c.json({ error: 'load_failed', reason: owner.error.message }, 500);
  if (!owner.data) return c.json({ error: 'not_found' }, 404);

  const [recvRes, retRes] = await Promise.all([
    sb.from('purchase_consignment_receives')
      .select('id, receive_number, status, received_at')
      .eq('purchase_consignment_order_id', id)
      .order('received_at', { ascending: false }),
    sb.from('purchase_consignment_returns')
      .select('id, return_number, status, return_date')
      .eq('pc_order_id', id)
      .order('return_date', { ascending: false }),
  ]);

  if (recvRes.error) return c.json({ error: 'load_failed', reason: recvRes.error.message }, 500);
  if (retRes.error)  return c.json({ error: 'load_failed', reason: retRes.error.message  }, 500);

  return c.json({
    receives: recvRes.data ?? [],
    returns:  retRes.data  ?? [],
  });
});

// ── Create ────────────────────────────────────────────────────────────
// body: {
//   supplierId, currency?, expectedAt?, purchaseLocationId?, notes?,
//   items: [{ materialKind, itemCode, materialName, supplierSku?, qty, unitPriceSen, bindingId? }]
// }
purchaseConsignmentOrders.post('/', async (c) => {
  /* company-scope: the only by-id write here is the ROLLBACK — the header this
     handler inserted moments earlier is deleted when the child insert fails.
     insertHeader / insertWithDocNoRetry stamp the active company on that row, so
     the id is not caller-supplied and cannot name another company's document.
     Verified 2026-08-13 by reading the handler end to end. */
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supplierId = body.supplierId as string | undefined;
  if (!supplierId) return c.json({ error: 'supplier_id_required' }, 400);

  // Owner 2026-08-20 ("越松越好"): mirror PO — Expected Delivery must not block
  // opening a purchase-consignment order. Blank defaults to today (still fans out
  // downstream) instead of a 400. Purchase Location stays required (per-line
  // warehouse = stock location).
  const expectedAt = dateOrNull(body.expectedAt) ?? todayMyt();
  const purchaseLocationId = body.purchaseLocationId as string | undefined;
  if (!purchaseLocationId) return c.json({ error: 'purchase_location_id_required' }, 400);

  // Allow blank-draft creation (no items) — add lines on the detail page.
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const currency = ((body.currency as string) ?? 'MYR').toUpperCase();
  if (!VALID_CURRENCIES.has(currency)) return c.json({ error: 'invalid_currency' }, 400);

  // PC Order number. Format: PCO-YYMM-NNN. max(suffix)+1 (NEVER count+1) so a
  // deleted mid-month row can't make the counter re-mint a surviving number
  // forever — see doc-no.ts.
  const supabase = c.get('supabase');
  const user = c.get('user');

  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  // Minted inside insertWithDocNoRetry below so a concurrent-create collision
  // (23505 on pc_number) re-derives the next free number instead of 500ing.
  const p = companyDocPrefix(c);
  const nextPcNumber = async (): Promise<string> =>
    mintMonthlyDocNo(supabase, 'purchase_consignment_orders', 'pc_number', `${p}PCO-${yymm}`);

  // Compute totals.
  let subtotal = 0;
  const itemRows = items.map((it) => {
    const kind = it.materialKind as string;
    if (!VALID_KINDS.has(kind)) throw new Error(`invalid material_kind: ${kind}`);
    if (!it.itemCode || !it.materialName) throw new Error('item_code + material_name required per item');
    const qty = Math.max(0, Number(it.qty ?? 0));
    const unit = Math.max(0, Number(it.unitPriceSen ?? 0));
    const discountSen = Math.max(0, Number(it.discountSen ?? 0));
    const lineTotal = Math.max(0, qty * unit - discountSen);
    subtotal += lineTotal;
    return {
      binding_id: (it.bindingId as string | undefined) ?? null,
      material_kind: kind,
      item_code: it.itemCode,
      material_name: it.materialName,
      supplier_sku: (it.supplierSku as string | undefined) ?? null,
      qty,
      unit_price_sen: unit,
      line_total_sen: lineTotal,
      notes: (it.notes as string | undefined) ?? null,
      discount_sen: discountSen,
      delivery_date: dateOrNull(it.deliveryDate),
      supplier_delivery_date_2: dateOrNull(it.supplierDeliveryDate2),
      supplier_delivery_date_3: dateOrNull(it.supplierDeliveryDate3),
      supplier_delivery_date_4: dateOrNull(it.supplierDeliveryDate4),
      warehouse_id:  (it.warehouseId  as string | undefined) ?? null,
      item_group:   (it.itemGroup as string | undefined) ?? null,
      variants:     (it.variants as unknown) ?? null,
      description:  (it.description as string | undefined) ?? null,
      description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
    };
  });

  // PC Order is created SUBMITTED directly (no DRAFT — migration 0154 default).
  const headerInsert: Record<string, unknown> = {
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    supplier_id: supplierId,
    status: 'SUBMITTED',
    submitted_at: new Date().toISOString(),
    currency,
    expected_at: expectedAt,
    supplier_delivery_date_2: dateOrNull(body.supplierDeliveryDate2),
    supplier_delivery_date_3: dateOrNull(body.supplierDeliveryDate3),
    supplier_delivery_date_4: dateOrNull(body.supplierDeliveryDate4),
    notes: (body.notes as string | undefined) ?? null,
    subtotal_sen: subtotal,
    tax_sen: 0,
    total_sen: subtotal,
    created_by: user.id,
    purchase_location_id: purchaseLocationId,
  };
  if (body.poDate) headerInsert.po_date = body.poDate;

  const { data: headerData, error: hErr } = await insertWithDocNoRetry<{ id: string; pc_number: string }>(
    nextPcNumber,
    (pcNumber) => supabase
      .from('purchase_consignment_orders')
      .insert({ pc_number: pcNumber, ...headerInsert })
      .select(HEADER_COLS)
      .single(),
  );

  if (hErr) {
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }

  const header = headerData as unknown as { id: string; pc_number: string };

  if (itemRows.length > 0) {
    const itemsToInsert = itemRows.map((r) => ({ ...r, purchase_consignment_order_id: header.id }));
    const { error: iErr } = await supabase.from('purchase_consignment_order_items').insert(stampCompany(itemsToInsert, c));
    if (iErr) {
      /* CREATE-TIME ROLLBACK, not a document delete — keep it. supabase-js has
         no transaction, so this compensating delete is the only thing standing
         between a failed line insert and a headerless orphan PC Order. It
         removes a document that never successfully existed. The owner's
         no-delete rule (see the removed DELETE /:id at the end of this file)
         is about documents that DID exist. */
      await supabase.from('purchase_consignment_orders').delete().eq('id', header.id);
      return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    }
  }

  return c.json({ id: header.id, pcNumber: header.pc_number }, 201);
});

/* ── PATCH header (po_date, expected_at, currency, notes, supplier, location) ── */
purchaseConsignmentOrders.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['poDate', 'po_date'], ['expectedAt', 'expected_at'], ['currency', 'currency'],
    ['notes', 'notes'], ['supplierId', 'supplier_id'],
    ['purchaseLocationId', 'purchase_location_id'],
    ['supplierDeliveryDate2', 'supplier_delivery_date_2'],
    ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
    ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  /* A cleared supplier date posts "" and this loop wrote it through to a date
     column, which Postgres rejects and 500s the save. */
  coerceEmptyDates(updates);
  /* Tier-2 lock — FIELD-LEVEL (owner 2026-08-20, §8 GAP-1): once a live PC Receive
     exists only the columns it inherits (supplier / currency / purchase location)
     freeze; the PCO's own dates + notes stay editable. Mirrors the mfg PO. */
  {
    const { data: before, error: bErr } = await scopeToCompanyId(sb.from('purchase_consignment_orders')
      .select('supplier_id, currency, purchase_location_id').eq('id', id), co.companyId).maybeSingle();
    if (bErr) return c.json({ error: 'update_failed', reason: bErr.message }, 500);
    const locked = before ? changedLockedCols(PCO_IDENTITY_LOCK_COLS, updates, before as Record<string, unknown>) : [];
    if (locked.length > 0 && (await pcoHasDownstream(sb, id))) {
      return c.json(identityLockedRefusal({
        error: 'pco_identity_locked', fields: locked, labels: PCO_IDENTITY_LABELS,
        what: 'Purchase-Consignment Order', child: 'PC Receive', ownFields: 'dates and notes',
      }), 409);
    }
  }
  const { data, error } = await scopeToCompanyId(sb.from('purchase_consignment_orders').update(updates).eq('id', id), co.companyId).select('*').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ purchaseConsignmentOrder: data });
});

/* ── PC Order line items: add / edit / delete ───────────────────────────
   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputePcoTotals(sb: any, pcoId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_consignment_order_items')
    .select('line_total_sen')
    .eq('purchase_consignment_order_id', pcoId);
  /* A failed READ is not an empty order, and `?? []` cannot tell them apart — it
     folded a transient blip into subtotal_sen / total_sen ZERO on an order
     whose lines were intact. The ERROR is the signal, never the emptiness: a
     genuinely empty order resolves error === null with data === [] and MUST still
     fall through to zero the header. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pco-recompute] item read failed — header left unchanged:', pcoId, itemsErr.message);
    return;
  }
  const subtotal = (items ?? []).reduce((s: number, r: any) => s + (r.line_total_sen ?? 0), 0);
  const { error: updErr } = await sb.from('purchase_consignment_orders').update({
    subtotal_sen: subtotal,
    total_sen: subtotal,
    updated_at: new Date().toISOString(),
  }).eq('id', pcoId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pco-recompute] header update failed — totals left STALE:', pcoId, updErr.message);
  }
}

purchaseConsignmentOrders.post('/:id/items', async (c) => {
  const pcoId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* The child is stamped with the active company; the parent it hangs off must
     be this company's too, or a line lands on another company's PC Order. */
  const { data: parent } = await scopeToCompanyId(sb.from('purchase_consignment_orders').select('id').eq('id', pcoId), co.companyId).maybeSingle();
  if (!parent) return c.json(NOT_THIS_COMPANY, 404);
  /* Tier 2 downstream-lock — line-add is blocked once a PC Receive exists. */
  const childLock = await pcoHasDownstream(sb, pcoId);
  if (childLock) return c.json(childLock, 409);

  const qty = Number(it.qty ?? 1);
  const unitPriceSen = Number(it.unitPriceSen ?? 0);
  const discountSen = Number(it.discountSen ?? 0);
  const lineTotal = (qty * unitPriceSen) - discountSen;

  const row: Record<string, unknown> = {
    purchase_consignment_order_id: pcoId,
    binding_id: (it.bindingId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    item_code: it.itemCode,
    material_name: it.materialName,
    supplier_sku: (it.supplierSku as string) ?? null,
    qty,
    unit_price_sen: unitPriceSen,
    line_total_sen: lineTotal,
    notes: (it.notes as string) ?? null,
    gap_inches: (it.gapInches as number) ?? null,
    divan_height_inches: (it.divanHeightInches as number) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    item_group: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
    uom: (it.uom as string) ?? 'UNIT',
    discount_sen: discountSen,
    unit_cost_sen: Number(it.unitCostSen ?? 0),
    delivery_date: dateOrNull(it.deliveryDate),
    supplier_delivery_date_2: dateOrNull(it.supplierDeliveryDate2),
    supplier_delivery_date_3: dateOrNull(it.supplierDeliveryDate3),
    supplier_delivery_date_4: dateOrNull(it.supplierDeliveryDate4),
    warehouse_id: (it.warehouseId as string) ?? null,
  };
  const { data, error } = await sb.from('purchase_consignment_order_items').insert({ company_id: activeCompanyId(c), ...row }).select('*').single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputePcoTotals(sb, pcoId);
  return c.json({ item: data }, 201);
});

purchaseConsignmentOrders.patch('/:id/items/:itemId', async (c) => {
  const pcoId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* Tier 2 downstream-lock — line-edit is blocked once a PC Receive exists. */
  const childLock = await pcoHasDownstream(sb, pcoId);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('purchase_consignment_order_items')
    .select('qty, unit_price_sen, discount_sen, unit_cost_sen, item_group, variants')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  const unit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : prev.unit_price_sen;
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : prev.discount_sen;
  const lineTotal = (qty * unit) - discount;

  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unit, discount_sen: discount, line_total_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['materialName', 'material_name'],
    ['supplierSku', 'supplier_sku'], ['itemGroup', 'item_group'],
    ['description', 'description'], ['description2', 'description2'],
    ['uom', 'uom'], ['unitCostSen', 'unit_cost_sen'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
    ['deliveryDate', 'delivery_date'], ['warehouseId', 'warehouse_id'],
    ['supplierDeliveryDate2', 'supplier_delivery_date_2'],
    ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
    ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  coerceEmptyDates(updates);
  /* Description 2 is server-owned: recompute from the effective itemGroup +
     variants (incoming patch, else stored row). */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_consignment_order_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputePcoTotals(sb, pcoId);
  return c.json({ ok: true });
});

purchaseConsignmentOrders.delete('/:id/items/:itemId', async (c) => {
  const pcoId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* Tier 2 downstream-lock — line-delete is blocked once a PC Receive exists. */
  const childLock = await pcoHasDownstream(sb, pcoId);
  if (childLock) return c.json(childLock, 409);

  const { data: del, error } = await scopeToCompanyId(sb.from('purchase_consignment_order_items').delete().eq('id', itemId), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!del) return c.json(NOT_THIS_COMPANY, 404);
  await recomputePcoTotals(sb, pcoId);

  return c.body(null, 204);
});

// ── Submit / cancel ──────────────────────────────────────────────────
// POST creates SUBMITTED directly. This endpoint is kept as an idempotent
// no-op so legacy callers still work.
purchaseConsignmentOrders.patch('/:id/submit', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data } = await scopeToCompanyId(supabase
    .from('purchase_consignment_orders')
    .select('id, status, submitted_at')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  const row = data as { id: string; status: string; submitted_at: string | null };
  if (row.status === 'SUBMITTED') return c.json({ purchaseConsignmentOrder: row });
  return c.json({ error: 'cannot_submit', message: `PC Order is ${row.status}` }, 409);
});

export const cancelPurchaseConsignmentOrderHandler = async (c: any) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(supabase
    .from('purchase_consignment_orders')
    .select('id, status')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curStatus = (cur as { status: string }).status;
  if (curStatus === 'RECEIVED') return c.json({ error: 'cannot_cancel', message: 'PC Order already received' }, 409);
  // Advisory only: this read cannot see a cancel that lands after it. The atomic
  // gate on the UPDATE below is what decides, and answers with the same body.
  if (curStatus === 'CANCELLED') return c.json({ purchaseConsignmentOrder: { id, status: 'CANCELLED' } });

  /* Tier 2 downstream-lock — can't cancel a PC Order that has a downstream PC
     Receive; the receive must be CANCELLED first (it has no delete either). */
  const childLock = await pcoHasDownstream(supabase, id);
  if (childLock) return c.json(childLock, 409);

  /* ATOMIC ACTIVE->CANCELLED, the same conditional UPDATE the six sibling cancels
     carry (grns.ts:2566 has the full note). Two concurrent cancels race on the row
     and exactly one flips it; the loser gets no row back and echoes. Nothing here
     moves money — a PC Order never reaches AutoCount (mig 0277 pins the outbox
     doc_type vocabulary to SO/PO/DO/IV/GR/PI) and there is no inventory reversal
     on this path — so what the gate buys is one cancelled_at and one honest
     response per cancel, instead of a second write silently restamping the time. */
  const { data: updRow, error: updErr } = await scopeToCompanyId(supabase
    .from('purchase_consignment_orders')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED'), co.companyId).select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) return c.json({ purchaseConsignmentOrder: { id, status: 'CANCELLED' } });

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_consignment_orders')
    .select('id, status, cancelled_at')
    .eq('id', id), co.companyId)
    .maybeSingle();
  return c.json({ purchaseConsignmentOrder: after ?? { id, status: 'CANCELLED' } });
};
purchaseConsignmentOrders.patch('/:id/cancel', cancelPurchaseConsignmentOrderHandler);

/* ── Delete: REMOVED (owner rule, 2026-08-11) ──────────────────────────────
   There was a DELETE /:id here that hard-purged a CANCELLED PC Order — the
   header, and by FK ON DELETE CASCADE every line with it. It is gone, and it
   must not come back.

   The owner's rule is 不可以删只可以 cancel — nothing is ever deleted, only
   cancelled. This was the same endpoint #1939 removed from purchase orders,
   copied into this module ("mirror PO", as the frontend hook said), and it was
   in fact WORSE than the PO one: the PO at least wrote an audit row before the
   purge, so something survived to say the document had existed. This one wrote
   nothing. A CANCELLED PC Order deleted here left no trace anywhere.

   Unlike the PO, a PC Order does NOT reach AutoCount — mig 0277 pins
   autocount_outbox.doc_type to SO / PO / DO / IV / GR / PI, and consignment
   purchasing is not in that vocabulary. So this is not the sync-divergence
   argument #1939 made. It is the plainer one: a PC Order commits the company to
   a supplier's goods held on consignment, and a purged one leaves no record
   that the commitment was ever made.

   CANCELLED already does everything the delete was used for. PATCH /:id/cancel
   above stamps cancelled_at, the order leaves every working list, and the
   downstream lock (pcoHasDownstream) already refuses to cancel one that has a
   PC Receive — so nothing needed deleting to stay consistent. The only thing
   delete added was the loss of the record.

   NOT touched, deliberately: the create-time rollback delete at :371. supabase-js
   has no transaction, so that compensating delete is the ONLY thing standing
   between a failed line insert and a headerless orphan document. It removes a
   document that never successfully existed; this endpoint removed one that did.

   The full classification of every delete on the SCM route surface is in
   docs/hard-delete-inventory.md. Check it before adding a DELETE handler. */
