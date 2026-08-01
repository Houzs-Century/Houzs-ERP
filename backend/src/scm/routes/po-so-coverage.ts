// ----------------------------------------------------------------------------
// /po-so-coverage/:type/:id — the "Assigned Sales Order" for a purchase document
// (PO / GRN / PI), per line, matched BY SKU.
//
// Owner's model (2026-07-25, refined again): a Sales Order knows (via MRP) which
// PO covers it, so the REVERSE must hold — a PO must show which SO(s) its supply
// is assigned to, plus that SO line's delivery date. And PO<->SO must be ONE
// mutually-consistent relationship: if SO-X shows "covered by PO-Y", then PO-Y
// must show "assigned to SO-X". "PO 关联的 SO、SO 关联的 PO 应该是一致且相互互通的".
//
// This is FLOATING until the goods ship, then STATIC once a Delivery Order locks
// them ("之前都是浮动的，可是当这个东西一出 DO 之后，Everything 都会变静态，锁定
// 下来了"). So the Assigned SO is resolved by PRECEDENCE, per SKU:
//
//   (a) DELIVERED — DO-locked (STATIC).  The PO's goods have shipped: a lot
//       stamped batch_no = this PO number was consumed by a DO (linkage C, the
//       reverse of soLineShippedSourcePos). Resolve the SO from the ACTUAL
//       DO->SO linkage (delivery_order_items.so_item_id / delivery_orders
//       .so_doc_no). Fixed — no longer recomputed.
//   (b) STORED ORIGIN (STATIC).  The PO was explicitly RAISED from an SO —
//       purchase_order_items.so_item_id (2026-07-09+ MRP raise-link) ∪ the PO's
//       "From SOs: …" note (bulk / shared buys, via the shared parseFromSosNote).
//       A real, immutable document link.
//   (c) MRP FLOATING coverage.  The single MRP engine (computeMrp) is called
//       ONCE and inverted via mrpReverseCoverage — the exact reverse of the
//       mrpLineCoverage the SO detail reads, so SO->PO and PO->SO can NEVER
//       disagree (ONE allocation, both sides). Matched by SKU, carrying the
//       covered SO line's delivery date. This is why a PO with matching demand
//       shows its SO(s) even when it was NOT converted-from-SO.
//       Since 2026-08-01 (audit D6) the claim holds across EVERY caller, not
//       just these two: includeUndated is display-only in computeMrp — the
//       allocation always runs over the full demand set (undated last), so
//       the MRP page (false) and this route (true) read one identical
//       allocation and can only differ in which rows they RENDER.
//   (d) none -> the line renders a dash.
//
// #1246 regression this fixes: #1246 dropped (c) and served (b) ONLY, so a PO
// not raised from an SO showed "—" even when MRP was pooling its supply against
// live SO demand. We restore (c) as the fallback and add (a) as the lock, while
// KEEPING (b) — see BUG-HISTORY.md 2026-07-25.
//
// Each assignment carries `locked`: true for (a)/(b) (STATIC — delivered or a
// stored raise-link), false for (c) (FLOATING — recomputed, evaporates/shifts as
// demand moves). The UI shows a subtle floating-vs-static indicator.
//
// Read-only + company-scoped: every doc read is scopeToCompany'd (a foreign id
// resolves to nothing); computeMrp is called with the active company id; the
// origin + DO-linked SOs are re-validated against company-owned mfg_sales_orders.
// Mounted on the coarse SCM read gate alongside /document-flow (same sensitivity
// class — SO doc no + delivery date; no cost, no margin).
//
//   GET /po-so-coverage/po/:id
//   GET /po-so-coverage/grn/:id   (resolves grns.purchase_order_id → PO)
//   GET /po-so-coverage/pi/:id    (resolves purchase_invoices.grn_id → GRN → PO)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { computeVariantKey } from '../shared';
import { parseFromSosNote } from './document-flow';
import { computeMrp, mrpReverseCoverage } from './mrp';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { tracePoDeliveredLedger } from '../lib/source-po-trace';
import type { Env, Variables } from '../env';

export const poSoCoverage = new Hono<{ Bindings: Env; Variables: Variables }>();
poSoCoverage.use('*', supabaseAuth);

const TYPES = new Set(['po', 'grn', 'pi']);

/* Resolve any of the three purchase-doc types down to its Purchase Order
   (id + number). Company-scoped throughout: a foreign / unknown id returns null,
   which the handler turns into an empty (but honest) origin response. */
async function resolvePo(
  sb: any,
  c: Context<any>,
  type: string,
  id: string,
): Promise<{ poId: string; poNumber: string } | null> {
  if (type === 'po') {
    const { data } = await scopeToCompany(
      sb.from('purchase_orders').select('id, po_number').eq('id', id), c,
    ).maybeSingle();
    return data?.id ? { poId: data.id, poNumber: data.po_number ?? '' } : null;
  }
  if (type === 'grn') {
    const { data } = await scopeToCompany(
      sb.from('grns').select('purchase_order_id').eq('id', id), c,
    ).maybeSingle();
    return data?.purchase_order_id ? resolvePo(sb, c, 'po', data.purchase_order_id) : null;
  }
  // pi → grn → po
  const { data } = await scopeToCompany(
    sb.from('purchase_invoices').select('grn_id').eq('id', id), c,
  ).maybeSingle();
  return data?.grn_id ? resolvePo(sb, c, 'grn', data.grn_id) : null;
}

/* One Assigned-SO for a PO SKU: the Sales Order and that SO's effective delivery
   date. `locked` = STATIC (delivered→DO-linked, or a stored raise-link); false /
   absent = FLOATING (live MRP coverage that shifts and evaporates on delivery).
   Clickable to the SO on the frontend. */
export type OriginAssignment = {
  soDocNo: string;
  deliveryDate: string | null;
  locked?: boolean;
  /* WHICH of the three layers produced this row. `locked` alone says static vs
     floating; `source` says WHY, which is what the UI needs to write the
     difference in words rather than as a dashed border the owner can miss:
       delivered — the goods physically shipped to that SO (linkage C)
       linked    — a STORED purchase_order_items.so_item_id / "From SOs" note
       mrp       — a live MRP allocation and nothing more (no stored link) */
  source?: 'delivered' | 'linked' | 'mrp';
};
/* Per-SKU assignment: the covering PO line's material_code and every SO assigned
   to it. Only SKUs WITH an assignment appear (a bare stock SKU is absent, and
   the UI shows a dash for it).

   `storedLink` = at least one PO line for this SKU actually carries a stored
   so_item_id. It is deliberately SEPARATE from the assignments: a SKU can show
   an MRP-derived SO while its PO lines are all unlinked, and that combination —
   an assignment on screen with nothing behind it in the database — is exactly
   what the 2026-07-29 incident mistook for a binding. */
export type SkuOrigin = { itemCode: string; assignments: OriginAssignment[]; storedLink: boolean };

type SoHeaderRow = {
  doc_no: string | null;
  customer_delivery_date: string | null;
  amended_delivery_date: string | null;
};
type SoLineRow = { doc_no: string | null; item_code: string | null };

/* Effective SO delivery date — the amended date wins over the customer's
   original, mirroring what the SO detail surfaces (mfg-sales-orders.ts). */
const effectiveDeliveryDate = (h: SoHeaderRow): string | null =>
  h.amended_delivery_date ?? h.customer_delivery_date ?? null;

/* Build doc_no → effective delivery date from a set of SO headers. */
function ddByDocOf(soHeaders: SoHeaderRow[]): Map<string, string | null> {
  const ddByDoc = new Map<string, string | null>();
  for (const h of soHeaders ?? []) {
    if (h.doc_no) ddByDoc.set(h.doc_no, effectiveDeliveryDate(h));
  }
  return ddByDoc;
}

/* Sort + de-dupe assignments for one SKU: earliest delivery date first (undated
   last), then by SO no. */
function sortAssignments(assignments: OriginAssignment[]): OriginAssignment[] {
  return assignments.sort((a, b) => {
    if (a.deliveryDate === b.deliveryDate) return a.soDocNo.localeCompare(b.soDocNo);
    if (!a.deliveryDate) return 1;
    if (!b.deliveryDate) return -1;
    return a.deliveryDate < b.deliveryDate ? -1 : 1;
  });
}

/* PURE core (linkage B): match the PO's SKUs to the STORED-ORIGIN SOs' lines by
   item_code and attach each origin SO's effective delivery date. No DB.
   - poSkus: the PO's material_codes (may repeat / be blank).
   - soHeaders: the validated, company-owned origin SO headers.
   - soLines: those SOs' item lines (doc_no + item_code).
   An origin SO appears under a SKU only when it actually has a line with that
   item_code. Returns Map<item_code, assignments> for the merge below. */
export function buildStoredOrigins(
  poSkus: Array<string | null | undefined>,
  soHeaders: SoHeaderRow[],
  soLines: SoLineRow[],
): Map<string, OriginAssignment[]> {
  const ddByDoc = ddByDocOf(soHeaders);
  // item_code → set of origin SO doc_nos that carry it (only validated SOs).
  const docsByCode = new Map<string, Set<string>>();
  for (const l of soLines ?? []) {
    const code = (l.item_code ?? '').trim();
    if (!code || !l.doc_no || !ddByDoc.has(l.doc_no)) continue;
    const set = docsByCode.get(code) ?? new Set<string>();
    set.add(l.doc_no);
    docsByCode.set(code, set);
  }
  const wantedSkus = new Set((poSkus ?? []).map((s) => (s ?? '').trim()).filter(Boolean));
  const out = new Map<string, OriginAssignment[]>();
  for (const code of wantedSkus) {
    const docs = docsByCode.get(code);
    if (!docs || docs.size === 0) continue;
    out.set(code, sortAssignments([...docs].map((soDocNo) => ({
      soDocNo, deliveryDate: ddByDoc.get(soDocNo) ?? null, locked: true, source: 'linked' as const,
    }))));
  }
  return out;
}

/* PURE core (mig 0235 — allocation-aware layer (b) links): per PO line, the
   EFFECTIVE stored so_item link(s).

   A line WITH allocations: the allocations ARE the authoritative finer-grained
   answer — their non-null so_item_ids replace the line's own single so_item_id
   entirely (a consolidated line can now name SEVERAL SOs; and where both the
   old link and allocations exist, allocations win, so nothing double-counts).
   An all-stock split (every slice so_item_id NULL) therefore yields NO link —
   the allocations overrule the stale single link by saying "stock".

   A line WITHOUT allocations keeps its so_item_id — the 1:1 fast path,
   unchanged for every PO raised through From-SO / convert / the line picker.

   Returns both halves layer (b) needs: the effective so_item_ids (the b1
   candidate docs) and which SKUs are STORED-linked (the storedLink flag the
   2026-07-29 guess-vs-binding distinction rides on — an allocation IS a stored
   link, so an allocated SKU counts). */
export function effectiveStoredLinks(
  poLines: Array<{ id?: string | null; material_code: string | null; so_item_id: string | null }>,
  allocationsByItem: Map<string, Array<{ so_item_id: string | null }>>,
): { soItemIds: string[]; linkedSkus: Set<string> } {
  const soItemIds = new Set<string>();
  const linkedSkus = new Set<string>();
  for (const l of poLines ?? []) {
    const code = (l.material_code ?? '').trim();
    const allocs = l.id ? allocationsByItem.get(l.id) ?? [] : [];
    if (allocs.length > 0) {
      let linked = false;
      for (const a of allocs) {
        if (a.so_item_id) { soItemIds.add(a.so_item_id); linked = true; }
      }
      if (linked && code) linkedSkus.add(code);
    } else if (l.so_item_id) {
      soItemIds.add(l.so_item_id);
      if (code) linkedSkus.add(code);
    }
  }
  return { soItemIds: [...soItemIds], linkedSkus };
}

/* Allocations for a set of PO line ids — the read half of the pure function
   above. Best-effort + chunked: pre-0235 (or on any read hiccup) the map is
   empty and every line falls back to its single so_item_id, which is exactly
   the pre-allocation behaviour. */
async function loadAllocationLinksForItems(
  sb: any,
  itemIds: Array<string | null | undefined>,
): Promise<Map<string, Array<{ so_item_id: string | null }>>> {
  const out = new Map<string, Array<{ so_item_id: string | null }>>();
  const ids = [...new Set(itemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data, error } = await sb.from('purchase_order_item_allocations')
        .select('purchase_order_item_id, so_item_id')
        .in('purchase_order_item_id', chunk);
      if (error) return new Map();
      for (const r of (data ?? []) as Array<{ purchase_order_item_id: string; so_item_id: string | null }>) {
        const arr = out.get(r.purchase_order_item_id) ?? [];
        arr.push({ so_item_id: r.so_item_id });
        out.set(r.purchase_order_item_id, arr);
      }
    }
  } catch {
    return new Map();
  }
  return out;
}

type DoLineRow = {
  delivery_order_id: string;
  so_item_id: string | null;
  item_code: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
};

/* PURE core (linkage C, the DO-lock): given the (do, code, variant) buckets a
   PO's goods physically shipped under (batch_no = this PO number, from OUT
   movements ∪ FIFO lot consumptions), the DO lines, and the SO resolution maps,
   produce the STATIC Assigned-SO per SKU. A DO line counts only when it lands in
   one of those buckets — i.e. its shipped goods came from THIS PO — matched by
   the SAME (item_code, variant_key) bucket the ship wrote them under.

   `soDocBySoItem` (so_item_id → SO doc_no) is preferred; `soDocByDo` (do id → SO
   doc_no, the DO header's so_doc_no) is the fallback for a DO line with no
   so_item_id. `ddByDoc` gives each SO's effective delivery date. */
export function buildDeliveredSoLock(
  buckets: Set<string>,
  doLines: DoLineRow[],
  soDocBySoItem: Map<string, string>,
  soDocByDo: Map<string, string>,
  ddByDoc: Map<string, string | null>,
): Map<string, OriginAssignment[]> {
  const docsByCode = new Map<string, Set<string>>();
  for (const dl of doLines ?? []) {
    const code = (dl.item_code ?? '').trim();
    if (!code) continue;
    const vk = computeVariantKey(dl.item_group ?? null, (dl.variants ?? null) as any);
    if (!buckets.has(`${dl.delivery_order_id}::${code}::${vk}`)) continue;
    const soDoc = (dl.so_item_id ? soDocBySoItem.get(dl.so_item_id) : null)
      ?? soDocByDo.get(dl.delivery_order_id)
      ?? null;
    if (!soDoc) continue;
    const set = docsByCode.get(code) ?? new Set<string>();
    set.add(soDoc);
    docsByCode.set(code, set);
  }
  const out = new Map<string, OriginAssignment[]>();
  for (const [code, docs] of docsByCode.entries()) {
    out.set(code, sortAssignments([...docs].map((soDocNo) => ({
      soDocNo, deliveryDate: ddByDoc.get(soDocNo) ?? null, locked: true, source: 'delivered' as const,
    }))));
  }
  return out;
}

/* PURE merge: pick each PO SKU's Assigned SO(s) by precedence
   (a) delivered→DO-lock (static) > (b) stored origin (static) >
   (c) MRP floating (floating) > (d) none. Only SKUs with an assignment appear;
   a SKU absent from the result renders a dash. `locked` is carried through from
   whichever layer won (do/origin already stamp true; floating stamps false). */
export function mergeAssignments(
  poSkus: Array<string | null | undefined>,
  doLock: Map<string, OriginAssignment[]>,
  storedOrigin: Map<string, OriginAssignment[]>,
  floating: Map<string, OriginAssignment[]>,
  /* SKUs whose PO lines carry a stored so_item_id. Reported per SKU so the UI
     can distinguish "the database binds this" from "MRP currently thinks this",
     independently of which layer happened to win the precedence. */
  linkedSkus: Set<string> = new Set(),
): SkuOrigin[] {
  const wantedSkus = new Set((poSkus ?? []).map((s) => (s ?? '').trim()).filter(Boolean));
  const out: SkuOrigin[] = [];
  for (const code of wantedSkus) {
    const picked =
      (doLock.get(code)?.length ? doLock.get(code) : null)
      ?? (storedOrigin.get(code)?.length ? storedOrigin.get(code) : null)
      ?? (floating.get(code)?.length ? floating.get(code) : null);
    if (!picked || picked.length === 0) continue;
    out.push({ itemCode: code, assignments: picked, storedLink: linkedSkus.has(code) });
  }
  return out.sort((a, b) => a.itemCode.localeCompare(b.itemCode));
}

/* Resolve the STATIC DO-lock (linkage C) for a PO: which SO(s) its DELIVERED
   goods actually shipped to. The reverse of soLineShippedSourcePos —
   batch_no = source PO number, stamped by the GRN (mig 0120) onto the FIFO lot
   and carried on the DO OUT movement. Best-effort + fully company-scoped: an
   absent table / column, or a PO whose goods have not shipped, yields an empty
   map (the line falls through to stored origin / floating). Returns
   Map<item_code, assignments> (STATIC / locked). */
async function resolveDeliveredSoLock(
  sb: any,
  c: Context<any>,
  poNumber: string,
): Promise<{ bySku: Map<string, OriginAssignment[]>; docNos: string[] }> {
  const empty = { bySku: new Map<string, OriginAssignment[]>(), docNos: [] as string[] };
  if (!poNumber) return empty;
  try {
    // (do id, product_code, variant_key) buckets whose goods came from THIS PO —
    // batched OUT movements ∪ consumptions of this PO's lots, from the ONE
    // shared ledger resolver (lib/source-po-trace.ts) the Delivered column also
    // reads, so the two columns can never disagree.
    const ledger = await tracePoDeliveredLedger(sb, [poNumber]);
    const bucketKeys = ledger.bucketsByPo.get(poNumber) ?? new Set<string>();
    const doIds = new Set<string>();
    for (const k of bucketKeys) {
      const doId = k.split('::')[0];
      if (doId) doIds.add(doId);
    }

    if (doIds.size === 0) return empty;
    const doIdList = [...doIds];

    // The DO lines (so_item_id + SKU + variants) for those DOs — company-scoped.
    const { data: doItems } = await scopeToCompany(
      sb.from('delivery_order_items')
        .select('delivery_order_id, so_item_id, item_code, item_group, variants'), c,
    ).in('delivery_order_id', doIdList);
    const doLines = (doItems ?? []) as DoLineRow[];
    if (doLines.length === 0) return empty;

    // DO header so_doc_no (fallback when a line has no so_item_id) — company-scoped.
    const { data: doHdrs } = await scopeToCompany(
      sb.from('delivery_orders').select('id, so_doc_no'), c,
    ).in('id', doIdList);
    const soDocByDo = new Map<string, string>();
    for (const d of (doHdrs ?? []) as Array<{ id: string; so_doc_no: string | null }>) {
      if (d.so_doc_no) soDocByDo.set(d.id, d.so_doc_no);
    }

    // so_item_id → SO doc_no (preferred) — company-scoped.
    const soItemIds = [...new Set(doLines.map((l) => l.so_item_id).filter((x): x is string => !!x))];
    const soDocBySoItem = new Map<string, string>();
    for (let i = 0; i < soItemIds.length; i += 300) {
      const chunk = soItemIds.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: soItems } = await scopeToCompany(
        sb.from('mfg_sales_order_items').select('id, doc_no'), c,
      ).in('id', chunk);
      for (const r of (soItems ?? []) as Array<{ id: string; doc_no: string | null }>) {
        if (r.doc_no) soDocBySoItem.set(r.id, r.doc_no);
      }
    }

    const wantedDocs = [
      ...new Set([...soDocBySoItem.values(), ...soDocByDo.values()].filter(Boolean)),
    ];
    if (wantedDocs.length === 0) return empty;

    // Effective delivery dates for the DO-locked SOs — re-validates company scope.
    const { data: soHeaders } = await scopeToCompany(
      sb.from('mfg_sales_orders')
        .select('doc_no, customer_delivery_date, amended_delivery_date'), c,
    ).in('doc_no', wantedDocs);
    const validDocs = new Set(
      ((soHeaders ?? []) as SoHeaderRow[]).map((h) => h.doc_no).filter((x): x is string => !!x),
    );
    // Drop any SO doc that failed the company re-validation.
    for (const [k, v] of soDocBySoItem) if (!validDocs.has(v)) soDocBySoItem.delete(k);
    for (const [k, v] of soDocByDo) if (!validDocs.has(v)) soDocByDo.delete(k);
    const ddByDoc = ddByDocOf((soHeaders ?? []) as SoHeaderRow[]);

    const bySku = buildDeliveredSoLock(bucketKeys, doLines, soDocBySoItem, soDocByDo, ddByDoc);
    return { bySku, docNos: [...validDocs] };
  } catch {
    return empty;
  }
}

poSoCoverage.get('/:type/:id', async (c) => {
  const type = c.req.param('type');
  const id = c.req.param('id');
  if (!TYPES.has(type)) return c.json({ error: 'bad_type' }, 400);

  const sb = c.get('supabase');
  try {
    const po = await resolvePo(sb, c, type, id);
    // No PO behind this doc (manual PI, unresolved id, foreign company): honest
    // empty — every line renders a dash in the Assigned SO / delivery columns.
    if (!po) {
      return c.json({ poNumber: null, poId: null, origins: [] as SkuOrigin[], delivered: [] as Array<{ itemCode: string; dos: DeliveredDo[] }> });
    }

    // The covering PO's own lines: SKUs (matched by material_code) + the exact
    // raise-link (so_item_id) where present.
    const { data: poLines } = await scopeToCompany(
      sb.from('purchase_order_items').select('id, material_code, so_item_id'), c,
    ).eq('purchase_order_id', po.poId);
    const lineRows = (poLines ?? []) as Array<{ id: string; material_code: string | null; so_item_id: string | null }>;
    const poSkus = lineRows.map((l) => l.material_code);
    /* mig 0235 — allocations, where present for a line, are the AUTHORITATIVE
       finer-grained links and replace that line's single so_item_id (a
       consolidated line can name several SOs; where both exist, allocations
       win — never both, so never a double count). Which SKUs are STORED-linked
       is still a separate question from "did the stored-origin layer win": a
       delivered SKU outranks it, and an MRP-only SKU can show an SO with no
       stored link at all. */
    const allocationsByItem = await loadAllocationLinksForItems(sb, lineRows.map((l) => l.id));
    const { soItemIds, linkedSkus } = effectiveStoredLinks(lineRows, allocationsByItem);

    // ── (b) STORED ORIGIN candidates (linkage B) ─────────────────────────────
    // (b1) exact raise-link SO doc_nos (2026-07-09+ MRP-linked flow).
    let exactDocs: string[] = [];
    if (soItemIds.length) {
      const { data: rows } = await scopeToCompany(
        sb.from('mfg_sales_order_items').select('doc_no'), c,
      ).in('id', soItemIds);
      exactDocs = [
        ...new Set(((rows ?? []) as Array<{ doc_no: string | null }>)
          .map((r) => r.doc_no).filter((x): x is string => !!x)),
      ];
    }
    // (b2) the PO's "From SOs: …" note (bulk / shared buys), via the ONE shared
    // note extractor. Tokens are validated below by the company-scoped SO lookup.
    const { data: poHdr } = await scopeToCompany(
      sb.from('purchase_orders').select('notes'), c,
    ).eq('id', po.poId).maybeSingle();
    const noteTokens = parseFromSosNote((poHdr as { notes?: string | null } | null)?.notes);
    const candidateDocs = [...new Set([...exactDocs, ...noteTokens])];

    // ── (a) DELIVERED DO-lock (linkage C), (c) MRP floating (linkage A) ──────
    // Both computed here; the merge applies the precedence a > b > c. computeMrp
    // is the SAME single engine the SO detail reads via mrpLineCoverage — inverted
    // by mrpReverseCoverage — so SO->PO and PO->SO can never disagree.
    const doLockRes = await resolveDeliveredSoLock(sb, c, po.poNumber);

    let floating = new Map<string, OriginAssignment[]>();
    try {
      const mrpResult = await computeMrp(sb, {
        catFilter: null,
        whFilter: null,
        includeUndated: true,
        companyId: activeCompanyId(c),
        leadBuffers: await loadLeadBuffers(c.env.DB),
      });
      const forPo = mrpReverseCoverage(mrpResult).get(po.poNumber) ?? [];
      const byCode = new Map<string, Map<string, string | null>>();
      for (const a of forPo) {
        const code = (a.itemCode ?? '').trim();
        if (!code || !a.soDocNo) continue;
        const inner = byCode.get(code) ?? new Map<string, string | null>();
        // Earliest date wins if the same SO appears twice for this SKU.
        if (!inner.has(a.soDocNo) || (a.deliveryDate && (inner.get(a.soDocNo) ?? null) === null)) {
          inner.set(a.soDocNo, a.deliveryDate ?? null);
        }
        byCode.set(code, inner);
      }
      floating = new Map(
        [...byCode.entries()].map(([code, inner]) => [
          code,
          sortAssignments([...inner.entries()].map(([soDocNo, deliveryDate]) => ({
            soDocNo, deliveryDate, locked: false, source: 'mrp' as const,
          }))),
        ]),
      );
    } catch {
      floating = new Map();
    }

    // ── (b) STORED ORIGIN resolution — validate candidates, build by SKU ─────
    let storedOrigin = new Map<string, OriginAssignment[]>();
    if (candidateDocs.length > 0) {
      const { data: soHeaders } = await scopeToCompany(
        sb.from('mfg_sales_orders')
          .select('doc_no, customer_delivery_date, amended_delivery_date'), c,
      ).in('doc_no', candidateDocs);
      const validDocs = [
        ...new Set(((soHeaders ?? []) as SoHeaderRow[])
          .map((h) => h.doc_no).filter((x): x is string => !!x)),
      ];
      if (validDocs.length > 0) {
        const { data: soLines } = await sb.from('mfg_sales_order_items')
          .select('doc_no, item_code').in('doc_no', validDocs);
        storedOrigin = buildStoredOrigins(
          poSkus,
          (soHeaders ?? []) as SoHeaderRow[],
          (soLines ?? []) as SoLineRow[],
        );
      }
    }

    const origins = mergeAssignments(poSkus, doLockRes.bySku, storedOrigin, floating, linkedSkus);
    /* "Delivered" per SKU — the DO(s) that shipped this PO's goods + qty (owner
       2026-07-31). The forward companion of the delivered-lock above; the drill-
       down matches it into each line by material_code. */
    const deliveredBySku = await resolveDeliveredBySkuForPo(sb, c, po.poNumber);
    const delivered: Array<{ itemCode: string; dos: DeliveredDo[] }> = [...deliveredBySku.entries()]
      .map(([itemCode, dos]) => ({ itemCode, dos }))
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
    return c.json({ poNumber: po.poNumber, poId: po.poId, origins, delivered });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ----------------------------------------------------------------------------
// Batched Assigned-SO for a PAGE of Purchase Orders (the collapsed list column)
//
// The single-doc handler above answers /po-so-coverage/:type/:id per line. A
// LIST cannot call it per row: that is an N+1 of network round-trips AND — the
// real cost — an N+1 of computeMrp, the global MRP engine. This resolves the
// Assigned SO for a whole page of POs in ONE pass:
//   - computeMrp runs EXACTLY ONCE; its reverse coverage map is built once.
//   - the DO-lock ledger reads (movements / lots / consumptions) and the
//     stored-origin reads are batched with `.in(...)` across every PO number.
//   - each PO's precedence merge reuses the SAME pure helpers the per-line route
//     uses (buildDeliveredSoLock / buildStoredOrigins / mergeAssignments), so a
//     list row and its own drill-down can never disagree.
//
// Returns Map<poId, PoAssignedSummary> — the PO-level rollup the header column
// renders: the distinct SO(s) across all the PO's SKUs (a STATIC assignment wins
// over a FLOATING one when the same SO shows for two SKUs), and whether ANY of
// the PO's lines carries a stored so_item_id (so the column can mark an MRP-only
// guess apart from a real link). Fully company-scoped, same as the route.
// ----------------------------------------------------------------------------
export type PoAssignedSummary = { assignedSos: OriginAssignment[]; sourceLinked: boolean };

/* Roll a PO's per-SKU origins up to ONE distinct-SO summary for the list cell. */
function summarizeOrigins(origins: SkuOrigin[]): PoAssignedSummary {
  const byDoc = new Map<string, OriginAssignment>();
  let sourceLinked = false;
  for (const o of origins) {
    if (o.storedLink) sourceLinked = true;
    for (const a of o.assignments) {
      const prev = byDoc.get(a.soDocNo);
      // A STATIC (locked) assignment wins over a FLOATING one for the same SO.
      if (!prev || (prev.locked === false && a.locked)) byDoc.set(a.soDocNo, a);
    }
  }
  return { assignedSos: sortAssignments([...byDoc.values()]), sourceLinked };
}

export async function resolvePoSoCoverageForPos(
  sb: any,
  c: Context<any>,
  poIds: Array<string | null | undefined>,
): Promise<Map<string, PoAssignedSummary>> {
  const out = new Map<string, PoAssignedSummary>();
  const ids = [...new Set(poIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;

  // PO headers (number + "From SOs:" notes) — company-scoped.
  const { data: poHdrs } = await scopeToCompany(
    sb.from('purchase_orders').select('id, po_number, notes'), c,
  ).in('id', ids);
  const poNumberById = new Map<string, string>();
  const notesById = new Map<string, string | null>();
  for (const h of (poHdrs ?? []) as Array<{ id: string; po_number: string | null; notes: string | null }>) {
    poNumberById.set(h.id, h.po_number ?? '');
    notesById.set(h.id, h.notes ?? null);
  }
  const validIds = [...poNumberById.keys()];
  if (validIds.length === 0) return out;
  const poNumbers = [...new Set([...poNumberById.values()].filter(Boolean))];

  // PO lines — SKUs + so_item_id links, grouped by PO — company-scoped.
  const { data: poLines } = await scopeToCompany(
    sb.from('purchase_order_items').select('id, purchase_order_id, material_code, so_item_id'), c,
  ).in('purchase_order_id', validIds);
  type PoLineLinkRow = { id: string; purchase_order_id: string; material_code: string | null; so_item_id: string | null };
  const lineRowsByPo = new Map<string, PoLineLinkRow[]>();
  const skusByPo = new Map<string, Array<string | null>>();
  for (const l of (poLines ?? []) as PoLineLinkRow[]) {
    const arr = skusByPo.get(l.purchase_order_id) ?? [];
    arr.push(l.material_code);
    skusByPo.set(l.purchase_order_id, arr);
    const rows = lineRowsByPo.get(l.purchase_order_id) ?? [];
    rows.push(l);
    lineRowsByPo.set(l.purchase_order_id, rows);
  }
  /* mig 0235 — one batched allocations read for EVERY line on the page, then
     the same per-line rule the single-doc route applies: allocations, where
     present, replace that line's single so_item_id (allocations win — no
     double count); a line without any keeps the 1:1 fast path. */
  const allocationsByItem = await loadAllocationLinksForItems(
    sb, ((poLines ?? []) as PoLineLinkRow[]).map((l) => l.id),
  );
  const linkedSkusByPo = new Map<string, Set<string>>();
  const soItemToPos = new Map<string, Set<string>>();
  const allSoItemIds = new Set<string>();
  for (const id of validIds) {
    const eff = effectiveStoredLinks(lineRowsByPo.get(id) ?? [], allocationsByItem);
    linkedSkusByPo.set(id, eff.linkedSkus);
    for (const soItemId of eff.soItemIds) {
      allSoItemIds.add(soItemId);
      const s = soItemToPos.get(soItemId) ?? new Set<string>();
      s.add(id);
      soItemToPos.set(soItemId, s);
    }
  }

  // ── (b) STORED ORIGIN — candidate SO doc_nos per PO ───────────────────────
  // b1: exact raise-link (so_item_id → doc_no).
  const soItemDoc = new Map<string, string>();
  const soItemArr = [...allSoItemIds];
  for (let k = 0; k < soItemArr.length; k += 300) {
    const chunk = soItemArr.slice(k, k + 300);
    if (chunk.length === 0) continue;
    const { data: rows } = await scopeToCompany(
      sb.from('mfg_sales_order_items').select('id, doc_no'), c,
    ).in('id', chunk);
    for (const r of (rows ?? []) as Array<{ id: string; doc_no: string | null }>) {
      if (r.doc_no) soItemDoc.set(r.id, r.doc_no);
    }
  }
  const candidateDocsByPo = new Map<string, Set<string>>();
  const allCandidateDocs = new Set<string>();
  for (const id of validIds) candidateDocsByPo.set(id, new Set<string>());
  for (const [soItemId, pos] of soItemToPos.entries()) {
    const doc = soItemDoc.get(soItemId);
    if (!doc) continue;
    for (const poId of pos) { candidateDocsByPo.get(poId)!.add(doc); allCandidateDocs.add(doc); }
  }
  // b2: the PO's "From SOs: …" note (bulk / shared buys), via the shared parser.
  for (const id of validIds) {
    for (const tok of parseFromSosNote(notesById.get(id) ?? null)) {
      candidateDocsByPo.get(id)!.add(tok); allCandidateDocs.add(tok);
    }
  }
  // Validate every candidate against company-owned SOs + carry each one's date + lines.
  const ddByDoc = new Map<string, string | null>();
  const validDocs = new Set<string>();
  const soHeaderByDoc = new Map<string, SoHeaderRow>();
  const soLinesByDoc = new Map<string, SoLineRow[]>();
  const candArr = [...allCandidateDocs];
  for (let k = 0; k < candArr.length; k += 300) {
    const chunk = candArr.slice(k, k + 300);
    if (chunk.length === 0) continue;
    const { data: soHeaders } = await scopeToCompany(
      sb.from('mfg_sales_orders').select('doc_no, customer_delivery_date, amended_delivery_date'), c,
    ).in('doc_no', chunk);
    for (const h of (soHeaders ?? []) as SoHeaderRow[]) {
      if (!h.doc_no) continue;
      validDocs.add(h.doc_no);
      ddByDoc.set(h.doc_no, effectiveDeliveryDate(h));
      soHeaderByDoc.set(h.doc_no, h);
    }
  }
  const validDocArr = [...validDocs];
  for (let k = 0; k < validDocArr.length; k += 300) {
    const chunk = validDocArr.slice(k, k + 300);
    if (chunk.length === 0) continue;
    const { data: soLines } = await sb.from('mfg_sales_order_items')
      .select('doc_no, item_code').in('doc_no', chunk);
    for (const l of (soLines ?? []) as SoLineRow[]) {
      if (!l.doc_no) continue;
      const arr = soLinesByDoc.get(l.doc_no) ?? [];
      arr.push(l);
      soLinesByDoc.set(l.doc_no, arr);
    }
  }

  // ── (c) MRP FLOATING — computeMrp runs ONCE for the whole page ────────────
  const floatingByPo = new Map<string, Map<string, OriginAssignment[]>>();
  try {
    const mrpResult = await computeMrp(sb, {
      catFilter: null,
      whFilter: null,
      includeUndated: true,
      companyId: activeCompanyId(c),
      leadBuffers: await loadLeadBuffers(c.env.DB),
    });
    const reverse = mrpReverseCoverage(mrpResult);
    for (const poNum of poNumbers) {
      const forPo = reverse.get(poNum) ?? [];
      if (forPo.length === 0) continue;
      const byCode = new Map<string, Map<string, string | null>>();
      for (const a of forPo) {
        const code = (a.itemCode ?? '').trim();
        if (!code || !a.soDocNo) continue;
        const inner = byCode.get(code) ?? new Map<string, string | null>();
        if (!inner.has(a.soDocNo) || (a.deliveryDate && (inner.get(a.soDocNo) ?? null) === null)) {
          inner.set(a.soDocNo, a.deliveryDate ?? null);
        }
        byCode.set(code, inner);
      }
      const m = new Map<string, OriginAssignment[]>();
      for (const [code, inner] of byCode.entries()) {
        m.set(code, sortAssignments([...inner.entries()].map(([soDocNo, deliveryDate]) => ({
          soDocNo, deliveryDate, locked: false, source: 'mrp' as const,
        }))));
      }
      floatingByPo.set(poNum, m);
    }
  } catch { /* MRP unavailable — floating stays empty; stored/delivered still show */ }

  // ── (a) DELIVERED → DO-lock — batched across every PO number on the page,
  //    from the ONE shared ledger resolver (the same pass the Delivered
  //    columns read — lib/source-po-trace.ts). ──
  let bucketsByPo = new Map<string, Set<string>>();
  const doIds = new Set<string>();
  try {
    const ledger = await tracePoDeliveredLedger(sb, poNumbers);
    bucketsByPo = ledger.bucketsByPo;
    for (const set of bucketsByPo.values()) {
      for (const k of set) {
        const doId = k.split('::')[0];
        if (doId) doIds.add(doId);
      }
    }
  } catch { /* ledger unreadable — DO-lock simply yields nothing */ }

  const doLockByPo = new Map<string, Map<string, OriginAssignment[]>>();
  if (doIds.size > 0) {
    const doIdList = [...doIds];
    const doLines: DoLineRow[] = [];
    const soDocByDo = new Map<string, string>();
    for (let k = 0; k < doIdList.length; k += 300) {
      const chunk = doIdList.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const [{ data: doItems }, { data: doHdrs }] = await Promise.all([
        scopeToCompany(
          sb.from('delivery_order_items')
            .select('delivery_order_id, so_item_id, item_code, item_group, variants'), c,
        ).in('delivery_order_id', chunk),
        scopeToCompany(
          sb.from('delivery_orders').select('id, so_doc_no'), c,
        ).in('id', chunk),
      ]);
      for (const r of (doItems ?? []) as DoLineRow[]) doLines.push(r);
      for (const d of (doHdrs ?? []) as Array<{ id: string; so_doc_no: string | null }>) {
        if (d.so_doc_no) soDocByDo.set(d.id, d.so_doc_no);
      }
    }
    // so_item_id → SO doc_no (preferred over the DO header fallback).
    const soDocBySoItem = new Map<string, string>();
    const dlSoItemIds = [...new Set(doLines.map((l) => l.so_item_id).filter((x): x is string => !!x))];
    for (let k = 0; k < dlSoItemIds.length; k += 300) {
      const chunk = dlSoItemIds.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const { data: soItems } = await scopeToCompany(
        sb.from('mfg_sales_order_items').select('id, doc_no'), c,
      ).in('id', chunk);
      for (const r of (soItems ?? []) as Array<{ id: string; doc_no: string | null }>) {
        if (r.doc_no) soDocBySoItem.set(r.id, r.doc_no);
      }
    }
    // Effective dates for the DO-locked SOs — re-validates company scope.
    const wantedDocs = [...new Set([...soDocBySoItem.values(), ...soDocByDo.values()].filter(Boolean))];
    const doLockDd = new Map<string, string | null>();
    const validLockDocs = new Set<string>();
    for (let k = 0; k < wantedDocs.length; k += 300) {
      const chunk = wantedDocs.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const { data: soHeaders } = await scopeToCompany(
        sb.from('mfg_sales_orders').select('doc_no, customer_delivery_date, amended_delivery_date'), c,
      ).in('doc_no', chunk);
      for (const h of (soHeaders ?? []) as SoHeaderRow[]) {
        if (!h.doc_no) continue;
        validLockDocs.add(h.doc_no);
        doLockDd.set(h.doc_no, effectiveDeliveryDate(h));
      }
    }
    for (const [k, v] of soDocBySoItem) if (!validLockDocs.has(v)) soDocBySoItem.delete(k);
    for (const [k, v] of soDocByDo) if (!validLockDocs.has(v)) soDocByDo.delete(k);
    for (const poNum of poNumbers) {
      const buckets = bucketsByPo.get(poNum);
      if (!buckets || buckets.size === 0) continue;
      doLockByPo.set(poNum, buildDeliveredSoLock(buckets, doLines, soDocBySoItem, soDocByDo, doLockDd));
    }
  }

  // ── Precedence merge per PO (a > b > c > none), then roll up to the cell ──
  for (const id of validIds) {
    const poNum = poNumberById.get(id) ?? '';
    const skus = skusByPo.get(id) ?? [];
    const doLock = doLockByPo.get(poNum) ?? new Map<string, OriginAssignment[]>();
    let storedOrigin = new Map<string, OriginAssignment[]>();
    const cand = candidateDocsByPo.get(id);
    if (cand && cand.size > 0) {
      const hdrs: SoHeaderRow[] = [];
      const lines: SoLineRow[] = [];
      for (const doc of cand) {
        if (!validDocs.has(doc)) continue;
        const h = soHeaderByDoc.get(doc);
        if (h) hdrs.push(h);
        for (const l of soLinesByDoc.get(doc) ?? []) lines.push(l);
      }
      if (hdrs.length > 0) storedOrigin = buildStoredOrigins(skus, hdrs, lines);
    }
    const floating = floatingByPo.get(poNum) ?? new Map<string, OriginAssignment[]>();
    const origins = mergeAssignments(skus, doLock, storedOrigin, floating, linkedSkusByPo.get(id) ?? new Set());
    out.set(id, summarizeOrigins(origins));
  }
  return out;
}

// ----------------------------------------------------------------------------
// "Delivered" — the FORWARD companion of the Assigned-SO delivered-lock: which
// Delivery Order(s) have SHIPPED a purchase document's goods, and how many units
// per DO. A DO ships a PO's goods when its OUT carries batch_no = the PO number
// (sofa / drop-ship) OR it consumed a FIFO lot stamped batch_no = the PO number
// (plain-FIFO bed frame / mattress / accessories, GRN-stamped per 0120). The
// exact same batch_no linkage the Assigned-SO reads — read here in the shipping
// direction. Cancelled DOs are EXCLUDED (a cancelled DO did not deliver).
// Company-scoped: the DO headers are re-read scopeToCompany'd, so a foreign DO
// never leaks and its qty never counts.
// ----------------------------------------------------------------------------
export type DeliveredDo = { doNo: string; qty: number };
export type PoDeliveredSummary = { deliveredDos: DeliveredDo[] };

const sortDeliveredDos = (dos: DeliveredDo[]): DeliveredDo[] =>
  dos.sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true }));

/* The ledger read itself (qty per (po, do) + per (po, do, code) + the DO-lock's
   bucket keys) lives in lib/source-po-trace.ts (tracePoDeliveredLedger) — ONE
   shared pass with the double-count guard (consumptions primary, batched OUT
   movements fill the drop-ship gap only). This file only shapes its output. */

/* Non-cancelled do_number for a set of DO ids — company-scoped, batched. A
   CANCELLED DO is deliberately absent (it did not deliver). */
async function nonCancelledDoNumbers(
  sb: any,
  c: Context<any>,
  doIds: string[],
): Promise<Map<string, string>> {
  const doNoById = new Map<string, string>();
  for (let k = 0; k < doIds.length; k += 300) {
    const chunk = doIds.slice(k, k + 300);
    if (chunk.length === 0) continue;
    const { data: doHdrs } = await scopeToCompany(
      sb.from('delivery_orders').select('id, do_number, status'), c,
    ).in('id', chunk);
    for (const d of (doHdrs ?? []) as Array<{ id: string; do_number: string | null; status: string | null }>) {
      if (d.do_number && (d.status ?? '').toUpperCase() !== 'CANCELLED') doNoById.set(d.id, d.do_number);
    }
  }
  return doNoById;
}

/* LIST rollup: Map<poId, PoDeliveredSummary> — the distinct non-cancelled DO(s)
   that shipped each PO's goods + qty per DO. Same shape the PO / GRN / PI list
   header cell renders. */
export async function resolveDeliveredDosForPos(
  sb: any,
  c: Context<any>,
  poIds: Array<string | null | undefined>,
): Promise<Map<string, PoDeliveredSummary>> {
  const out = new Map<string, PoDeliveredSummary>();
  const ids = [...new Set(poIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const { data: poHdrs } = await scopeToCompany(
    sb.from('purchase_orders').select('id, po_number'), c,
  ).in('id', ids);
  const poNumberById = new Map<string, string>();
  for (const h of (poHdrs ?? []) as Array<{ id: string; po_number: string | null }>) {
    poNumberById.set(h.id, h.po_number ?? '');
  }
  const poNumbers = [...new Set([...poNumberById.values()].filter(Boolean))];
  if (poNumbers.length === 0) return out;
  const { qtyByPoDo, doIds } = await tracePoDeliveredLedger(sb, poNumbers);
  if (doIds.size === 0) return out;
  const doNoById = await nonCancelledDoNumbers(sb, c, [...doIds]);
  for (const id of poNumberById.keys()) {
    const poNum = poNumberById.get(id) ?? '';
    const inner = qtyByPoDo.get(poNum);
    if (!inner) continue;
    const dos: DeliveredDo[] = [];
    for (const [doId, qty] of inner.entries()) {
      const doNo = doNoById.get(doId);
      if (!doNo) continue; // foreign / cancelled DO — never counts as delivered
      dos.push({ doNo, qty });
    }
    if (dos.length > 0) out.set(id, { deliveredDos: sortDeliveredDos(dos) });
  }
  return out;
}

/* DRILL-DOWN per-SKU: Map<item_code, DeliveredDo[]> for ONE PO — the DO(s) that
   shipped each SKU + qty. Feeds the single-doc /po-so-coverage/:type/:id
   response's `delivered`, matched by SKU into each drill-down line. */
async function resolveDeliveredBySkuForPo(
  sb: any,
  c: Context<any>,
  poNumber: string,
): Promise<Map<string, DeliveredDo[]>> {
  const out = new Map<string, DeliveredDo[]>();
  if (!poNumber) return out;
  const { qtyByPoDoCode, doIds } = await tracePoDeliveredLedger(sb, [poNumber]);
  if (doIds.size === 0) return out;
  const doNoById = await nonCancelledDoNumbers(sb, c, [...doIds]);
  const byDo = qtyByPoDoCode.get(poNumber);
  if (!byDo) return out;
  // (code → (doNo → qty)) so the same SKU across two DOs shows both.
  const byCode = new Map<string, Map<string, number>>();
  for (const [doId, codeQty] of byDo.entries()) {
    const doNo = doNoById.get(doId);
    if (!doNo) continue;
    for (const [code, qty] of codeQty.entries()) {
      const inner = byCode.get(code) ?? new Map<string, number>();
      inner.set(doNo, (inner.get(doNo) ?? 0) + qty);
      byCode.set(code, inner);
    }
  }
  for (const [code, inner] of byCode.entries()) {
    out.set(code, sortDeliveredDos([...inner.entries()].map(([doNo, qty]) => ({ doNo, qty }))));
  }
  return out;
}

export default poSoCoverage;
