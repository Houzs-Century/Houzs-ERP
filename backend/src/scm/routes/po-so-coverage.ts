// ----------------------------------------------------------------------------
// /po-so-coverage/:type/:id — the REAL "assigned Sales Order" for a purchase
// document (PO / GRN / PI), per line, matched BY SKU.
//
// Owner complaint (2026-07-24 → refined 2026-07-25): on a PO raised FROM a Sales
// Order, the detail wrongly showed "Floating stock — not yet assigned to a Sales
// Order". That old view (#1237) recomputed a floating MRP pool and reported "not
// assigned" whenever its greedy allocation didn't currently land on this PO —
// instead of the PO's ACTUAL origin. The owner already assigned the SO ("我上次
// 都已经 assign 那个 SO 了，会有 SO 的 delivery date") and expects to see it.
//
// This route now returns the STORED origin: which Sales-Order line each PO SKU
// was RAISED from, plus that SO line's effective delivery date. It is a REAL
// document link, not an advisory pool — two sources, both stored FKs / records:
//   (a) purchase_order_items.so_item_id — the MRP-linked raise flow (2026-07-09+)
//   (b) the PO's "From SOs: …" note — how a bulk / shared buy records its source
//       SO(s) (parsed via document-flow's parseFromSosNote, one source of truth)
// The union is validated against real, company-owned SOs; only SKUs with a
// matching origin SO line are returned, so a genuine stock PO (no origin) simply
// yields no assignments and the UI renders a dash — never "floating coverage".
//
// Delivery date = the origin SO's effective delivery date
// (amended_delivery_date ?? customer_delivery_date), the same effective date the
// SO detail surfaces.
//
// Read-only + company-scoped: every doc read is scopeToCompany'd (a foreign id
// resolves to nothing), and the origin SOs are re-validated by
// scopeToCompany on mfg_sales_orders, so a caller in company A never sees
// company B's SOs. Mounted on the coarse SCM read gate alongside /document-flow
// (same sensitivity class — SO doc no + delivery date; no cost, no margin).
//
//   GET /po-so-coverage/po/:id
//   GET /po-so-coverage/grn/:id   (resolves grns.purchase_order_id → PO)
//   GET /po-so-coverage/pi/:id    (resolves purchase_invoices.grn_id → GRN → PO)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { parseFromSosNote } from './document-flow';
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

/* One real origin assignment for a PO SKU: the Sales Order it was raised from
   and that SO's effective delivery date. Clickable to the SO on the frontend. */
export type OriginAssignment = { soDocNo: string; deliveryDate: string | null };
/* Per-SKU origin: the covering PO line's material_code and every origin SO that
   carries that SKU. Only SKUs WITH an origin appear (a stock PO SKU is absent,
   and the UI shows a dash for it). */
export type SkuOrigin = { itemCode: string; assignments: OriginAssignment[] };

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

/* PURE core: match the PO's SKUs to the origin SOs' lines by item_code and
   attach each origin SO's effective delivery date. No DB — unit-tested directly.
   - poSkus: the PO's material_codes (may repeat / be blank).
   - soHeaders: the validated, company-owned origin SO headers.
   - soLines: those SOs' item lines (doc_no + item_code).
   An origin SO appears under a SKU only when it actually has a line with that
   item_code, so the assignment is never a guess. Assignments are de-duped per
   SKU and ordered earliest delivery date first (undated last), then by SO no. */
export function buildSkuOrigins(
  poSkus: Array<string | null | undefined>,
  soHeaders: SoHeaderRow[],
  soLines: SoLineRow[],
): SkuOrigin[] {
  const ddByDoc = new Map<string, string | null>();
  for (const h of soHeaders ?? []) {
    if (h.doc_no) ddByDoc.set(h.doc_no, effectiveDeliveryDate(h));
  }
  // item_code → set of origin SO doc_nos that carry it (only validated SOs).
  const docsByCode = new Map<string, Set<string>>();
  for (const l of soLines ?? []) {
    const code = (l.item_code ?? '').trim();
    if (!code || !l.doc_no || !ddByDoc.has(l.doc_no)) continue;
    const set = docsByCode.get(code) ?? new Set<string>();
    set.add(l.doc_no);
    docsByCode.set(code, set);
  }

  const wantedSkus = new Set(
    (poSkus ?? []).map((s) => (s ?? '').trim()).filter(Boolean),
  );
  const out: SkuOrigin[] = [];
  for (const code of wantedSkus) {
    const docs = docsByCode.get(code);
    if (!docs || docs.size === 0) continue;
    const assignments: OriginAssignment[] = [...docs]
      .map((soDocNo) => ({ soDocNo, deliveryDate: ddByDoc.get(soDocNo) ?? null }))
      .sort((a, b) => {
        if (a.deliveryDate === b.deliveryDate) return a.soDocNo.localeCompare(b.soDocNo);
        if (!a.deliveryDate) return 1;
        if (!b.deliveryDate) return -1;
        return a.deliveryDate < b.deliveryDate ? -1 : 1;
      });
    out.push({ itemCode: code, assignments });
  }
  return out.sort((a, b) => a.itemCode.localeCompare(b.itemCode));
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
    const soItemIds = [
      ...new Set(
        ((poLines ?? []) as Array<{ so_item_id: string | null }>)
          .map((l) => l.so_item_id)
          .filter((x): x is string => !!x),
      ),
    ];

    // (a) exact raise-link SO doc_nos (2026-07-09+ MRP-linked flow).
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

    // (b) the PO's "From SOs: …" note (bulk / shared buys), via the ONE shared
    // note extractor. Tokens are validated below by the company-scoped SO
    // lookup — a bogus token simply resolves to no SO.
    const { data: poHdr } = await scopeToCompany(
      sb.from('purchase_orders').select('notes'), c,
    ).eq('id', po.poId).maybeSingle();
    const noteTokens = parseFromSosNote((poHdr as { notes?: string | null } | null)?.notes);

    const candidateDocs = [...new Set([...exactDocs, ...noteTokens])];
    if (candidateDocs.length === 0) {
      return c.json({ poNumber: po.poNumber, poId: po.poId, origins: [] as SkuOrigin[] });
    }

    // Validate the candidates against REAL, company-owned SOs (this is the
    // company gate AND the whole-token check: a token equals a doc_no or it is
    // dropped). Pull the effective-delivery-date inputs in the same read.
    const { data: soHeaders } = await scopeToCompany(
      sb.from('mfg_sales_orders')
        .select('doc_no, customer_delivery_date, amended_delivery_date'), c,
    ).in('doc_no', candidateDocs);
    const validDocs = [
      ...new Set(((soHeaders ?? []) as SoHeaderRow[])
        .map((h) => h.doc_no).filter((x): x is string => !!x)),
    ];
    if (validDocs.length === 0) {
      return c.json({ poNumber: po.poNumber, poId: po.poId, origins: [] as SkuOrigin[] });
    }

    // Those SOs' lines (item_code) — the SKU-match input. doc_no is already
    // company-validated above, so this read stays inside the active company.
    const { data: soLines } = await sb.from('mfg_sales_order_items')
      .select('doc_no, item_code').in('doc_no', validDocs);

    const origins = buildSkuOrigins(
      poSkus,
      (soHeaders ?? []) as SoHeaderRow[],
      (soLines ?? []) as SoLineRow[],
    );
    return c.json({ poNumber: po.poNumber, poId: po.poId, origins });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default poSoCoverage;
