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
//       "From SOs: …" note (bulk / shared buys, via the shared parseProvenanceNote).
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
// DECISION 2026-08-06 (soft until DO, hard from DO — docs/modules/
// purchase-order.md §Decision): (b) is procurement PROVENANCE, not an execution
// answer. Pre-DO the execution answer is (c); post-DO it is (a). The staged
// realignment demotes (b) out of the precedence chain into a parallel
// "bought-for" annotation — until that stage lands, remember when reading this
// route's output that (b) outranking (c) reflects the RETIRED model.
//
// PR-3 (2026-08-07): the parallel annotation now EXISTS on the wire — every
// SkuOrigin carries `provenance` = its layer-(b) assignments regardless of
// which layer won — but the PRECEDENCE IS UNCHANGED: `assignments` still
// resolves a > b > c exactly as above. The flip that makes (c)/(a) the only
// execution answer (the live DO-time allocator binding) is PR-4, owner-gated.
//
// 2990-0023 (2026-10-28): a POOLED company (every company but
// HARD_BOUND_COMPANY_ID) now resolves a > c > b — the PO names the SO the
// pooled walk gives it, and the raised-for SO rides as `provenance`. The
// hard-bound company keeps a > b > c. See mergeAssignments.
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
import { effectiveSoDelivery } from '../shared';
import { parseProvenanceNote } from './document-flow';
import { computeMrp, mrpReverseCoverage } from './mrp';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { tracePoDeliveredLedger } from '../lib/source-po-trace';
import { sharedLiveMrp } from '../lib/live-mrp-memo';
import { listMrpResult, type ListMrp } from '../lib/list-mrp-source';
import { chunkIn, UUID_CHUNK } from '../lib/paginate-all';
import { eager } from '../lib/concurrency';
import type { Env, Variables } from '../env';

export const poSoCoverage = new Hono<{ Bindings: Env; Variables: Variables }>();
poSoCoverage.use('*', supabaseAuth);

const TYPES = new Set(['po', 'grn', 'pi']);

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
  const { data } = await scopeToCompany(
    sb.from('purchase_invoices').select('grn_id').eq('id', id), c,
  ).maybeSingle();
  return data?.grn_id ? resolvePo(sb, c, 'grn', data.grn_id) : null;
}

export type OriginAssignment = {
  soDocNo: string;
  deliveryDate: string | null;
  locked?: boolean;
  source?: 'delivered' | 'linked' | 'mrp';
};
export type SkuOrigin = {
  itemCode: string;
  assignments: OriginAssignment[];
  storedLink: boolean;
  provenance: OriginAssignment[];
};

type SoHeaderRow = {
  doc_no: string | null;
  customer_delivery_date: string | null;
  amended_delivery_date: string | null;
};
type SoLineRow = { doc_no: string | null; item_code: string | null };

const effectiveDeliveryDate = (h: SoHeaderRow): string | null => effectiveSoDelivery(h);

function ddByDocOf(soHeaders: SoHeaderRow[]): Map<string, string | null> {
  const ddByDoc = new Map<string, string | null>();
  for (const h of soHeaders ?? []) {
    if (h.doc_no) ddByDoc.set(h.doc_no, effectiveDeliveryDate(h));
  }
  return ddByDoc;
}

function sortAssignments(assignments: OriginAssignment[]): OriginAssignment[] {
  return assignments.sort((a, b) => {
    if (a.deliveryDate === b.deliveryDate) return a.soDocNo.localeCompare(b.soDocNo);
    if (!a.deliveryDate) return 1;
    if (!b.deliveryDate) return -1;
    return a.deliveryDate < b.deliveryDate ? -1 : 1;
  });
}

export function buildStoredOrigins(
  poSkus: Array<string | null | undefined>,
  soHeaders: SoHeaderRow[],
  soLines: SoLineRow[],
): Map<string, OriginAssignment[]> {
  const ddByDoc = ddByDocOf(soHeaders);
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

export function effectiveStoredLinks(
  poLines: Array<{ id?: string | null; item_code: string | null; so_item_id: string | null }>,
  allocationsByItem: Map<string, Array<{ so_item_id: string | null }>>,
): { soItemIds: string[]; linkedSkus: Set<string> } {
  const soItemIds = new Set<string>();
  const linkedSkus = new Set<string>();
  for (const l of poLines ?? []) {
    const code = (l.item_code ?? '').trim();
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

async function loadAllocationLinksForItems(
  sb: any,
  itemIds: Array<string | null | undefined>,
): Promise<Map<string, Array<{ so_item_id: string | null }>>> {
  const out = new Map<string, Array<{ so_item_id: string | null }>>();
  const ids = [...new Set(itemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += UUID_CHUNK) {
      const chunk = ids.slice(i, i + UUID_CHUNK);
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
   whichever layer won (do/origin already stamp true; floating stamps false).

   Since 2026-08-07 (PR-3, additive): every emitted SKU ALSO carries
   `provenance` = its layer-(b) stored-origin assignments verbatim, whether or
   not (b) won. The precedence itself is NOT changed — `assignments` and
   `storedLink` are byte-identical to the pre-PR-3 output. A SKU whose only
   data is stored origin still appears (layer (b) wins for it), so provenance
   is never silently dropped by the only-SKUs-with-an-assignment rule.

   `pooled` (2990-0023, 2026-10-28) = the company pools its supply (every
   company but HARD_BOUND_COMPANY_ID). There (c) outranks (b): a pooled walk
   can hand a PO to another SO with an earlier delivery date (boss rule,
   2990-0018), and Sim asked that the PO then name THAT SO, not the one it was
   raised for. (b) stays on the wire as `provenance` — the "Bought for" chip —
   and still wins when MRP has no answer for the SKU (received / stock). The
   hard-bound company keeps a > b > c: its bound lines only ever use their own
   PO, so there (c) already equals (b).

   Owner 2026-11-19: Assigned SO follows MRP's record in BOTH companies. Keeping
   a > b > c for company 1 named the raise-link SO for every SKU, a standard
   mattress included, while MRP had given the PO to another order (HC-PO-2611-143
   / -256 read HC-SO-003726; MRP gave them to HC-SO-012294 / HC-SO-2611-174). A
   bound line's MRP answer is its own PO, so nothing changes for it. */
export const ASSIGNED_FOLLOWS_MRP = true;

export function mergeAssignments(
  poSkus: Array<string | null | undefined>,
  doLock: Map<string, OriginAssignment[]>,
  storedOrigin: Map<string, OriginAssignment[]>,
  floating: Map<string, OriginAssignment[]>,
  linkedSkus: Set<string>,
  pooled: boolean,
): SkuOrigin[] {
  const wantedSkus = new Set((poSkus ?? []).map((s) => (s ?? '').trim()).filter(Boolean));
  const out: SkuOrigin[] = [];
  for (const code of wantedSkus) {
    const stored = storedOrigin.get(code)?.length ? storedOrigin.get(code) : null;
    const mrp = floating.get(code)?.length ? floating.get(code) : null;
    const picked =
      (doLock.get(code)?.length ? doLock.get(code) : null)
      ?? (pooled ? mrp ?? stored : stored ?? mrp);
    if (!picked || picked.length === 0) continue;
    out.push({
      itemCode: code,
      assignments: picked,
      storedLink: linkedSkus.has(code),
      provenance: storedOrigin.get(code) ?? [],
    });
  }
  return out.sort((a, b) => a.itemCode.localeCompare(b.itemCode));
}

async function resolveDeliveredSoLock(
  sb: any,
  c: Context<any>,
  poNumber: string,
): Promise<{ bySku: Map<string, OriginAssignment[]>; docNos: string[] }> {
  const empty = { bySku: new Map<string, OriginAssignment[]>(), docNos: [] as string[] };
  if (!poNumber) return empty;
  try {
    const ledger = await tracePoDeliveredLedger(sb, [poNumber]);
    const bucketKeys = ledger.bucketsByPo.get(poNumber) ?? new Set<string>();
    const doIds = new Set<string>();
    for (const k of bucketKeys) {
      const doId = k.split('::')[0];
      if (doId) doIds.add(doId);
    }

    if (doIds.size === 0) return empty;
    const doIdList = [...doIds];

    const { data: doItems } = await scopeToCompany(
      sb.from('delivery_order_items')
        .select('delivery_order_id, so_item_id, item_code, item_group, variants'), c,
    ).in('delivery_order_id', doIdList);
    const doLines = (doItems ?? []) as DoLineRow[];
    if (doLines.length === 0) return empty;

    const { data: doHdrs } = await scopeToCompany(
      sb.from('delivery_orders').select('id, so_doc_no'), c,
    ).in('id', doIdList);
    const soDocByDo = new Map<string, string>();
    for (const d of (doHdrs ?? []) as Array<{ id: string; so_doc_no: string | null }>) {
      if (d.so_doc_no) soDocByDo.set(d.id, d.so_doc_no);
    }

    const soItemIds = [...new Set(doLines.map((l) => l.so_item_id).filter((x): x is string => !!x))];
    const soDocBySoItem = new Map<string, string>();
    for (let i = 0; i < soItemIds.length; i += UUID_CHUNK) {
      const chunk = soItemIds.slice(i, i + UUID_CHUNK);
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

    const { data: soHeaders } = await scopeToCompany(
      sb.from('mfg_sales_orders')
        .select('doc_no, customer_delivery_date, amended_delivery_date'), c,
    ).in('doc_no', wantedDocs);
    const validDocs = new Set(
      ((soHeaders ?? []) as SoHeaderRow[]).map((h) => h.doc_no).filter((x): x is string => !!x),
    );
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
    if (!po) {
      return c.json({ poNumber: null, poId: null, origins: [] as SkuOrigin[], delivered: [] as Array<{ itemCode: string; dos: DeliveredDo[] }> });
    }

    const { data: poLines } = await scopeToCompany(
      sb.from('purchase_order_items').select('id, item_code, so_item_id'), c,
    ).eq('purchase_order_id', po.poId);
    const lineRows = (poLines ?? []) as Array<{ id: string; item_code: string | null; so_item_id: string | null }>;
    const poSkus = lineRows.map((l) => l.item_code);
    const allocationsByItem = await loadAllocationLinksForItems(sb, lineRows.map((l) => l.id));
    const { soItemIds, linkedSkus } = effectiveStoredLinks(lineRows, allocationsByItem);

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
    const { data: poHdr } = await scopeToCompany(
      sb.from('purchase_orders').select('notes'), c,
    ).eq('id', po.poId).maybeSingle();
    const noteTokens = parseProvenanceNote((poHdr as { notes?: string | null } | null)?.notes);
    const candidateDocs = [...new Set([...exactDocs, ...noteTokens])];

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

    const origins = mergeAssignments(
      poSkus, doLockRes.bySku, storedOrigin, floating, linkedSkus,
      ASSIGNED_FOLLOWS_MRP,
    );
    const deliveredBySku = await resolveDeliveredBySkuForPo(sb, c, po.poNumber);
    const delivered: Array<{ itemCode: string; dos: DeliveredDo[] }> = [...deliveredBySku.entries()]
      .map(([itemCode, dos]) => ({ itemCode, dos }))
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
    return c.json({ poNumber: po.poNumber, poId: po.poId, origins, delivered });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export type PoAssignedSummary = {
  assignedSos: OriginAssignment[];
  sourceLinked: boolean;
  provenanceSos: OriginAssignment[];
};

export function summarizeOrigins(origins: SkuOrigin[]): PoAssignedSummary {
  const byDoc = new Map<string, OriginAssignment>();
  const provByDoc = new Map<string, OriginAssignment>();
  let sourceLinked = false;
  for (const o of origins) {
    if (o.storedLink) sourceLinked = true;
    for (const a of o.assignments) {
      const prev = byDoc.get(a.soDocNo);
      if (!prev || (prev.locked === false && a.locked)) byDoc.set(a.soDocNo, a);
    }
    for (const p of o.provenance ?? []) {
      if (!provByDoc.has(p.soDocNo)) provByDoc.set(p.soDocNo, p);
    }
  }
  return {
    assignedSos: sortAssignments([...byDoc.values()]),
    sourceLinked,
    provenanceSos: sortAssignments([...provByDoc.values()]),
  };
}

export async function resolvePoSoCoverageForPos(
  sb: any,
  c: Context<any>,
  poIds: Array<string | null | undefined>,
  listMrp: Promise<ListMrp> | null,
): Promise<Map<string, PoAssignedSummary>> {
  const perSku = await resolvePoSoCoveragePerSkuForPos(sb, c, poIds, listMrp);
  const out = new Map<string, PoAssignedSummary>();
  for (const [id, origins] of perSku.entries()) out.set(id, summarizeOrigins(origins));
  return out;
}

export async function resolvePoSoCoveragePerSkuForPos(
  sb: any,
  c: Context<any>,
  poIds: Array<string | null | undefined>,
  listMrp: Promise<ListMrp> | null,
): Promise<Map<string, SkuOrigin[]>> {
  const out = new Map<string, SkuOrigin[]>();
  const ids = [...new Set(poIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;

  const { data: poHdrs } = await chunkIn<{ id: string; po_number: string | null; notes: string | null }>(
    ids,
    (batch, from, to) => scopeToCompany(
      sb.from('purchase_orders').select('id, po_number, notes'), c,
    ).in('id', batch).order('id').range(from, to),
  );
  const poNumberById = new Map<string, string>();
  const notesById = new Map<string, string | null>();
  for (const h of poHdrs) {
    poNumberById.set(h.id, h.po_number ?? '');
    notesById.set(h.id, h.notes ?? null);
  }
  const validIds = [...poNumberById.keys()];
  if (validIds.length === 0) return out;
  const poNumbers = [...new Set([...poNumberById.values()].filter(Boolean))];

  /* PERF (2026-08-17). The two most expensive reads in this function — the MRP
     engine (section c, ~100 round trips of its own) and the delivered ledger
     (section a) — take NOTHING from the stored-origin chain that runs between
     here and their old call sites. computeMrp keys off the company alone;
     tracePoDeliveredLedger keys off `poNumbers`, which is known on the line
     above. They were nonetheless issued only after six serial reads had
     finished, so the whole stored-origin chain was dead time on the critical
     path of the PO list, the GRN list and the PI list alike.

     ISSUED here, AWAITED at their original sites. Neither query text, filter,
     nor argument changes; `eager` keeps the rejection attached from the moment
     it is created, so a failure still surfaces inside the same try/catch that
     caught it before and still degrades to the same empty map. The set of
     requests that run either read is unchanged too — both sit after the same
     two early returns they always sat after.

     HC-0002 (2026-10-22): the run is the one lib/live-mrp-memo.ts shares with
     the SO list and SO detail — the identical options (no filters, undated
     included, active company, stored lead buffers) — so the PO / GRN / PI lists
     no longer pay for their own. A failed run still rejects into the same catch. */
  const mrpProm = eager(listMrp ? listMrpResult(listMrp) : sharedLiveMrp(sb, c.env.DB, activeCompanyId(c)).result);
  const ledgerProm = eager(tracePoDeliveredLedger(sb, poNumbers));

  type PoLineLinkRow = { id: string; purchase_order_id: string; item_code: string | null; so_item_id: string | null };
  const { data: poLines } = await chunkIn<PoLineLinkRow>(
    validIds,
    (batch, from, to) => scopeToCompany(
      sb.from('purchase_order_items').select('id, purchase_order_id, item_code, so_item_id'), c,
    ).in('purchase_order_id', batch).order('id').range(from, to),
  );
  const lineRowsByPo = new Map<string, PoLineLinkRow[]>();
  const skusByPo = new Map<string, Array<string | null>>();
  for (const l of poLines) {
    const arr = skusByPo.get(l.purchase_order_id) ?? [];
    arr.push(l.item_code);
    skusByPo.set(l.purchase_order_id, arr);
    const rows = lineRowsByPo.get(l.purchase_order_id) ?? [];
    rows.push(l);
    lineRowsByPo.set(l.purchase_order_id, rows);
  }
  const allocationsByItem = await loadAllocationLinksForItems(
    sb, poLines.map((l) => l.id),
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

  const soItemDoc = new Map<string, string>();
  const soItemArr = [...allSoItemIds];
  for (let k = 0; k < soItemArr.length; k += UUID_CHUNK) {
    const chunk = soItemArr.slice(k, k + UUID_CHUNK);
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
  for (const id of validIds) {
    for (const tok of parseProvenanceNote(notesById.get(id) ?? null)) {
      candidateDocsByPo.get(id)!.add(tok); allCandidateDocs.add(tok);
    }
  }
  const ddByDoc = new Map<string, string | null>();
  const validDocs = new Set<string>();
  const soHeaderByDoc = new Map<string, SoHeaderRow>();
  const soLinesByDoc = new Map<string, SoLineRow[]>();
  const candArr = [...allCandidateDocs];
  for (let k = 0; k < candArr.length; k += UUID_CHUNK) {
    const chunk = candArr.slice(k, k + UUID_CHUNK);
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
  for (let k = 0; k < validDocArr.length; k += UUID_CHUNK) {
    const chunk = validDocArr.slice(k, k + UUID_CHUNK);
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

  const floatingByPo = new Map<string, Map<string, OriginAssignment[]>>();
  try {
    const mrpResult = (await mrpProm)();
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
  } catch { }

  let bucketsByPo = new Map<string, Set<string>>();
  const doIds = new Set<string>();
  try {
    const ledger = (await ledgerProm)();
    bucketsByPo = ledger.bucketsByPo;
    for (const set of bucketsByPo.values()) {
      for (const k of set) {
        const doId = k.split('::')[0];
        if (doId) doIds.add(doId);
      }
    }
  } catch { }

  const doLockByPo = new Map<string, Map<string, OriginAssignment[]>>();
  if (doIds.size > 0) {
    const doIdList = [...doIds];
    const doLines: DoLineRow[] = [];
    const soDocByDo = new Map<string, string>();
    for (let k = 0; k < doIdList.length; k += UUID_CHUNK) {
      const chunk = doIdList.slice(k, k + UUID_CHUNK);
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
    const soDocBySoItem = new Map<string, string>();
    const dlSoItemIds = [...new Set(doLines.map((l) => l.so_item_id).filter((x): x is string => !!x))];
    for (let k = 0; k < dlSoItemIds.length; k += UUID_CHUNK) {
      const chunk = dlSoItemIds.slice(k, k + UUID_CHUNK);
      if (chunk.length === 0) continue;
      const { data: soItems } = await scopeToCompany(
        sb.from('mfg_sales_order_items').select('id, doc_no'), c,
      ).in('id', chunk);
      for (const r of (soItems ?? []) as Array<{ id: string; doc_no: string | null }>) {
        if (r.doc_no) soDocBySoItem.set(r.id, r.doc_no);
      }
    }
    const wantedDocs = [...new Set([...soDocBySoItem.values(), ...soDocByDo.values()].filter(Boolean))];
    const doLockDd = new Map<string, string | null>();
    const validLockDocs = new Set<string>();
    for (let k = 0; k < wantedDocs.length; k += UUID_CHUNK) {
      const chunk = wantedDocs.slice(k, k + UUID_CHUNK);
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

  const pooled = ASSIGNED_FOLLOWS_MRP;
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
    const origins = mergeAssignments(
      skus, doLock, storedOrigin, floating, linkedSkusByPo.get(id) ?? new Set(), pooled,
    );
    out.set(id, origins);
  }
  return out;
}

export type DeliveredDo = {
  doNo: string;
  qty: number;
  /* The Sales Order this DO belongs to (delivery_orders.so_doc_no) — pairs each
     delivered chip with its Assigned-SO row in the drill's per-SO sub-table
     (owner 2026-08-02: one row per SO, not three unaligned stacks). Null for an
     ad-hoc DO with no SO. */
  soDocNo?: string | null;
};
export type PoDeliveredSummary = { deliveredDos: DeliveredDo[] };

const sortDeliveredDos = (dos: DeliveredDo[]): DeliveredDo[] =>
  dos.sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true }));


async function nonCancelledDoNumbers(
  sb: any,
  c: Context<any>,
  doIds: string[],
): Promise<Map<string, { doNo: string; soDocNo: string | null }>> {
  const doNoById = new Map<string, { doNo: string; soDocNo: string | null }>();
  for (let k = 0; k < doIds.length; k += UUID_CHUNK) {
    const chunk = doIds.slice(k, k + UUID_CHUNK);
    if (chunk.length === 0) continue;
    const { data: doHdrs } = await scopeToCompany(
      sb.from('delivery_orders').select('id, do_number, status, so_doc_no'), c,
    ).in('id', chunk);
    for (const d of (doHdrs ?? []) as Array<{ id: string; do_number: string | null; status: string | null; so_doc_no: string | null }>) {
      if (d.do_number && (d.status ?? '').toUpperCase() !== 'CANCELLED') {
        doNoById.set(d.id, { doNo: d.do_number, soDocNo: d.so_doc_no ?? null });
      }
    }
  }
  return doNoById;
}

export async function resolveDeliveredDosForPos(
  sb: any,
  c: Context<any>,
  poIds: Array<string | null | undefined>,
): Promise<Map<string, PoDeliveredSummary>> {
  const out = new Map<string, PoDeliveredSummary>();
  const ids = [...new Set(poIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const { data: poHdrs } = await chunkIn<{ id: string; po_number: string | null }>(
    ids,
    (batch, from, to) => scopeToCompany(
      sb.from('purchase_orders').select('id, po_number'), c,
    ).in('id', batch).order('id').range(from, to),
  );
  const poNumberById = new Map<string, string>();
  for (const h of poHdrs) {
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
      const hdr = doNoById.get(doId);
      if (!hdr) continue;
      dos.push({ doNo: hdr.doNo, qty, soDocNo: hdr.soDocNo });
    }
    if (dos.length > 0) out.set(id, { deliveredDos: sortDeliveredDos(dos) });
  }
  return out;
}

export async function resolveDeliveredByCodeForPos(
  sb: any,
  c: Context<any>,
  poIds: Array<string | null | undefined>,
): Promise<Map<string, Map<string, DeliveredDo[]>>> {
  const out = new Map<string, Map<string, DeliveredDo[]>>();
  const ids = [...new Set(poIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const { data: poHdrs } = await chunkIn<{ id: string; po_number: string | null }>(
    ids,
    (batch, from, to) => scopeToCompany(
      sb.from('purchase_orders').select('id, po_number'), c,
    ).in('id', batch).order('id').range(from, to),
  );
  const poNumberById = new Map<string, string>();
  for (const h of poHdrs) {
    poNumberById.set(h.id, h.po_number ?? '');
  }
  const poNumbers = [...new Set([...poNumberById.values()].filter(Boolean))];
  if (poNumbers.length === 0) return out;
  const { qtyByPoDoCode, doIds } = await tracePoDeliveredLedger(sb, poNumbers);
  if (doIds.size === 0) return out;
  const doNoById = await nonCancelledDoNumbers(sb, c, [...doIds]);
  for (const id of poNumberById.keys()) {
    const byDo = qtyByPoDoCode.get(poNumberById.get(id) ?? '');
    if (!byDo) continue;
    const byCode = new Map<string, Map<string, DeliveredDo>>();
    for (const [doId, codeQty] of byDo.entries()) {
      const hdr = doNoById.get(doId);
      if (!hdr) continue;
      for (const [code, qty] of codeQty.entries()) {
        const inner = byCode.get(code) ?? new Map<string, DeliveredDo>();
        const prev = inner.get(hdr.doNo);
        if (prev) prev.qty += qty;
        else inner.set(hdr.doNo, { doNo: hdr.doNo, qty, soDocNo: hdr.soDocNo });
        byCode.set(code, inner);
      }
    }
    if (byCode.size > 0) {
      out.set(id, new Map([...byCode.entries()].map(([code, inner]) =>
        [code, sortDeliveredDos([...inner.values()])])));
    }
  }
  return out;
}

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
  const byCode = new Map<string, Map<string, DeliveredDo>>();
  for (const [doId, codeQty] of byDo.entries()) {
    const hdr = doNoById.get(doId);
    if (!hdr) continue;
    for (const [code, qty] of codeQty.entries()) {
      const inner = byCode.get(code) ?? new Map<string, DeliveredDo>();
      const prev = inner.get(hdr.doNo);
      if (prev) prev.qty += qty;
      else inner.set(hdr.doNo, { doNo: hdr.doNo, qty, soDocNo: hdr.soDocNo });
      byCode.set(code, inner);
    }
  }
  for (const [code, inner] of byCode.entries()) {
    out.set(code, sortDeliveredDos([...inner.values()]));
  }
  return out;
}

export default poSoCoverage;
