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
    // (do id, product_code, variant_key) buckets whose goods came from THIS PO.
    const bucketKeys = new Set<string>();
    const doIds = new Set<string>();
    const addBucket = (doId: string | null, code: string | null, vk: string | null): void => {
      if (!doId || !code) return;
      bucketKeys.add(`${doId}::${code}::${vk ?? ''}`);
      doIds.add(doId);
    };

    // Sofa / drop-ship: the DO OUT movement itself carries batch_no = PO number.
    const { data: movs } = await sb.from('inventory_movements')
      .select('source_doc_id, product_code, variant_key, batch_no')
      .eq('source_doc_type', 'DO')
      .eq('movement_type', 'OUT')
      .eq('batch_no', poNumber);
    for (const m of (movs ?? []) as Array<{ source_doc_id: string | null; product_code: string | null; variant_key: string | null }>) {
      addBucket(m.source_doc_id, m.product_code, m.variant_key);
    }

    // Plain-FIFO (bed frame / mattress / accessories): the OUT is un-batched, but
    // the consumed lots ARE batched (GRN stamps batch_no = PO number). Find this
    // PO's lots, then the DO consumptions of them.
    try {
      const { data: lots } = await sb.from('inventory_lots')
        .select('id').eq('batch_no', poNumber);
      const lotIds = [...new Set(((lots ?? []) as Array<{ id: string }>).map((l) => l.id).filter(Boolean))];
      for (let i = 0; i < lotIds.length; i += 300) {
        const chunk = lotIds.slice(i, i + 300);
        if (chunk.length === 0) continue;
        const { data: cons } = await sb.from('inventory_lot_consumptions')
          .select('source_doc_id, product_code, variant_key')
          .eq('source_doc_type', 'DO')
          .in('lot_id', chunk);
        for (const r of (cons ?? []) as Array<{ source_doc_id: string | null; product_code: string | null; variant_key: string | null }>) {
          addBucket(r.source_doc_id, r.product_code, r.variant_key);
        }
      }
    } catch { /* consumption / lot table absent — movement batches stand alone */ }

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
      return c.json({ poNumber: null, poId: null, origins: [] as SkuOrigin[] });
    }

    // The covering PO's own lines: SKUs (matched by material_code) + the exact
    // raise-link (so_item_id) where present.
    const { data: poLines } = await scopeToCompany(
      sb.from('purchase_order_items').select('material_code, so_item_id'), c,
    ).eq('purchase_order_id', po.poId);
    const poSkus = ((poLines ?? []) as Array<{ material_code: string | null }>)
      .map((l) => l.material_code);
    /* Which SKUs are STORED-linked at the row level. Not the same question as
       "did the stored-origin layer win": a delivered SKU outranks it, and an
       MRP-only SKU can show an SO with no stored link at all. */
    const linkedSkus = new Set(
      ((poLines ?? []) as Array<{ material_code: string | null; so_item_id: string | null }>)
        .filter((l) => !!l.so_item_id)
        .map((l) => (l.material_code ?? '').trim())
        .filter(Boolean),
    );
    const soItemIds = [
      ...new Set(
        ((poLines ?? []) as Array<{ so_item_id: string | null }>)
          .map((l) => l.so_item_id)
          .filter((x): x is string => !!x),
      ),
    ];

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
    return c.json({ poNumber: po.poNumber, poId: po.poId, origins });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default poSoCoverage;
