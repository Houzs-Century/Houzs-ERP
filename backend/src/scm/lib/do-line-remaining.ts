// ----------------------------------------------------------------------------
// do-line-remaining — the single source of truth for the DO-line "Pending"
// quantity used by BOTH downstream conversions (DO → Sales Invoice and
// DO → Delivery Return). Commander 2026-05-30 (Phase B), mirroring the SO→DO
// partial-delivery model in delivery-orders-mfg.ts (soDeliverableRemaining).
//
// Every delivered unit is in exactly ONE state — Pending / Invoiced / Returned
// — and the three are mutually exclusive. Per DO line:
//
//   delivered = the DO line's qty (delivery_order_items.qty)
//   invoiced  = Σ sales_invoice_items.qty   linked via do_item_id to a
//                                            NON-cancelled sales_invoice
//   returned  = Σ delivery_return_items.qty_returned  linked via do_item_id to
//                                            a NON-cancelled delivery_return
//
//   remaining = delivered − invoiced − returned          (= Pending)
//
// remaining_to_invoice and remaining_to_return are the SAME number: invoicing
// and returning COMPETE for the same Pending pool, so a unit that's been
// invoiced can't be returned and vice-versa (the invoice⊕return exclusion the
// user asked for — it falls straight out of this one formula, no extra flag).
//
// CANCEL releases: cancelling an invoice or a return drops its rows out of the
// non-cancelled filter, so the qty re-derives back into Pending automatically —
// the line becomes re-convertible. The number is always DERIVED LIVE from the
// rows; there is no stored counter to drift.
// ----------------------------------------------------------------------------

import { paginateAll, chunkIn } from './paginate-all';

export type DoRemainingLine = {
  doItemId: string;
  deliveryOrderId: string;
  doNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  /** delivered = the DO line's qty */
  delivered: number;
  invoiced: number;
  returned: number;
  /** delivered − invoiced − returned (= Pending = remaining to invoice OR return) */
  remaining: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  variants: unknown;
  /* Migration 0058 — dedicated sofa/bedframe variant-breakdown columns. Carried
     so the DO→SI picker convert keeps them (sales_invoice_items has them too);
     previously dropped here, so a converted SI lost the sofa/bedframe breakdown. */
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  customSpecials: unknown;
  lineSuffix: string | null;
  specialOrderPriceSen: number;
  /** Position of this line within ITS DO listing order (line_no per 0165,
   *  created_at for pre-0165 rows) — SI conversion copies the DO's order
   *  instead of shuffling by uuid (Loo 2026-06-12 line-order rules). */
  lineSeq: number;
};

/**
 * Derive the live Pending (remaining) quantity per DO line for the given DOs.
 * Keyed by delivery_order_items.id. Skips cancelled DOs entirely (a cancelled
 * DO delivered nothing). Returns a Map so callers can look up by do_item_id.
 *
 * `sb` is the loosely-typed Supabase client from the Hono context.
 */
export async function doLineRemaining(
  sb: any,
  doIds: string[],
): Promise<Map<string, DoRemainingLine>> {
  const out = new Map<string, DoRemainingLine>();
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return out;

  // 1. Load the DO headers — we need debtor + do_number for the descriptors,
  //    and the status so we can drop cancelled DOs (they delivered nothing).
  //    chunkIn splits the id IN-list into ≤200 batches and pages each so a large
  //    DO set can't truncate at PostgREST's 1000-row cap.
  const { data: doHeaders } = await chunkIn(ids, (batch, from, to) => sb
    .from('delivery_orders')
    .select('id, do_number, status, debtor_code, debtor_name')
    .in('id', batch)
    .range(from, to));
  const headerById = new Map<
    string,
    { do_number: string; debtor_code: string | null; debtor_name: string | null }
  >();
  for (const d of (doHeaders ?? []) as Array<{
    id: string; do_number: string; status: string | null;
    debtor_code: string | null; debtor_name: string | null;
  }>) {
    const st = (d.status ?? '').toUpperCase();
    // LEAK GUARD (DRAFT, 2026-06-25 anchoring diff vs 2990) — a DRAFT DO has NOT
    // shipped: it delivered nothing, so its lines must never become invoiceable /
    // returnable (the "Pending" pool both downstream pickers read). Dropped
    // alongside CANCELLED.
    if (st === 'CANCELLED' || st === 'DRAFT') continue; // delivered nothing
    headerById.set(d.id, { do_number: d.do_number, debtor_code: d.debtor_code, debtor_name: d.debtor_name });
  }
  const activeDoIds = [...headerById.keys()];
  if (activeDoIds.length === 0) return out;

  // 2. Load the DO lines of the active DOs — `delivered` = each line's qty —
  //    in each DO's own listing order (line_no per 0165, NULLS LAST so
  //    pre-0165 DOs fall back to created_at).
  // chunkIn batches the DO ids and pages each — every batch returns all lines for
  // its DOs, so a DO's items stay contiguous and in line_no order (lineSeq below
  // stays correct); guards the 1000-row cap for a DO set with many lines.
  const { data: doLines } = await chunkIn(activeDoIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select(
      'id, delivery_order_id, item_code, item_group, description, description2, uom, qty, ' +
      'unit_price_centi, unit_cost_centi, discount_centi, variants, ' +
      'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
      'custom_specials, line_suffix, special_order_price_sen',
    )
    .in('delivery_order_id', batch)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at')
    .range(from, to));
  const lines = (doLines ?? []) as Array<Record<string, unknown> & {
    id: string; delivery_order_id: string; qty: number;
  }>;
  if (lines.length === 0) return out;
  const doItemIds = lines.map((l) => l.id);

  // 3. Σ invoiced — sales_invoice_items linked by do_item_id whose parent
  //    invoice is NOT cancelled. Two-step: pull candidate SI lines, then drop
  //    those whose parent invoice is cancelled.
  const invoicedByDoItem = new Map<string, number>();
  {
    // chunkIn batches + pages the do_item_id IN-list so a DO line with >1000
    // downstream SI lines can't truncate and under-count `invoiced`.
    const { data: siLines } = await chunkIn<{ do_item_id: string | null; qty: number; sales_invoice_id: string }>(
      doItemIds, (batch, from, to) => sb
        .from('sales_invoice_items')
        .select('do_item_id, qty, sales_invoice_id')
        .in('do_item_id', batch)
        .range(from, to));
    const siRows = siLines;
    const siIds = [...new Set(siRows.map((l) => l.sales_invoice_id).filter(Boolean))];
    const activeSiIds = new Set<string>();
    if (siIds.length > 0) {
      const { data: sis } = await chunkIn<{ id: string; status: string | null }>(siIds, (batch, from, to) =>
        sb.from('sales_invoices').select('id, status').in('id', batch).range(from, to));
      for (const s of sis as Array<{ id: string; status: string | null }>) {
        if ((s.status ?? '').toUpperCase() !== 'CANCELLED') activeSiIds.add(s.id);
      }
    }
    for (const l of siRows) {
      if (!l.do_item_id || !activeSiIds.has(l.sales_invoice_id)) continue;
      invoicedByDoItem.set(l.do_item_id, (invoicedByDoItem.get(l.do_item_id) ?? 0) + Number(l.qty ?? 0));
    }
  }

  // 4. Σ returned — delivery_return_items linked by do_item_id whose parent
  //    return is NOT cancelled. Same two-step.
  const returnedByDoItem = new Map<string, number>();
  {
    // chunkIn batches + pages the do_item_id IN-list so a DO line with >1000
    // downstream DR lines can't truncate and under-count `returned`.
    const { data: drLines } = await chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(
      doItemIds, (batch, from, to) => sb
        .from('delivery_return_items')
        .select('do_item_id, qty_returned, delivery_return_id')
        .in('do_item_id', batch)
        .range(from, to));
    const drRows = drLines;
    const drIds = [...new Set(drRows.map((l) => l.delivery_return_id).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const { data: drs } = await chunkIn<{ id: string; status: string | null }>(drIds, (batch, from, to) =>
        sb.from('delivery_returns').select('id, status').in('id', batch).range(from, to));
      for (const d of drs as Array<{ id: string; status: string | null }>) {
        if ((d.status ?? '').toUpperCase() !== 'CANCELLED') activeDrIds.add(d.id);
      }
    }
    for (const l of drRows) {
      if (!l.do_item_id || !activeDrIds.has(l.delivery_return_id)) continue;
      returnedByDoItem.set(l.do_item_id, (returnedByDoItem.get(l.do_item_id) ?? 0) + Number(l.qty_returned ?? 0));
    }
  }

  // 5. Assemble per-line descriptors with the live Pending (remaining).
  //    lineSeq counts per DO so SI conversion can keep each DO's listing order.
  const seqByDo = new Map<string, number>();
  for (const l of lines) {
    const head = headerById.get(l.delivery_order_id);
    if (!head) continue;
    const delivered = Number(l.qty ?? 0);
    const invoiced = invoicedByDoItem.get(l.id) ?? 0;
    const returned = returnedByDoItem.get(l.id) ?? 0;
    const lineSeq = seqByDo.get(l.delivery_order_id) ?? 0;
    seqByDo.set(l.delivery_order_id, lineSeq + 1);
    out.set(l.id, {
      doItemId: l.id,
      deliveryOrderId: l.delivery_order_id,
      doNumber: head.do_number,
      debtorCode: head.debtor_code,
      debtorName: head.debtor_name,
      itemCode: l.item_code as string,
      itemGroup: (l.item_group as string | null) ?? null,
      description: (l.description as string | null) ?? null,
      description2: (l.description2 as string | null) ?? null,
      uom: (l.uom as string | null) ?? null,
      delivered,
      invoiced,
      returned,
      remaining: delivered - invoiced - returned,
      unitPriceCenti: Number(l.unit_price_centi ?? 0),
      unitCostCenti: Number(l.unit_cost_centi ?? 0),
      discountCenti: Number(l.discount_centi ?? 0),
      variants: l.variants ?? null,
      /* Migration 0058 — carry the dedicated variant-breakdown columns (supabase-js
         returns snake_case; dual-read camelCase ?? snake_case stays safe either way). */
      gapInches: (l.gapInches ?? l.gap_inches ?? null) as number | null,
      divanHeightInches: (l.divanHeightInches ?? l.divan_height_inches ?? null) as number | null,
      divanPriceSen: Number(l.divanPriceSen ?? l.divan_price_sen ?? 0),
      legHeightInches: (l.legHeightInches ?? l.leg_height_inches ?? null) as number | null,
      legPriceSen: Number(l.legPriceSen ?? l.leg_price_sen ?? 0),
      customSpecials: l.customSpecials ?? l.custom_specials ?? null,
      lineSuffix: (l.lineSuffix ?? l.line_suffix ?? null) as string | null,
      specialOrderPriceSen: Number(l.specialOrderPriceSen ?? l.special_order_price_sen ?? 0),
      lineSeq,
    });
  }
  return out;
}

/**
 * Live remaining-to-invoice qty per DO line id (delivered − invoiced −
 * returned), resolved straight from the DO item ids. Used by the SI write-path
 * guards so every sales_invoice_items create / add / qty-increase respects the
 * SAME cap the convert-from-DO picker enforces — no back door. DO lines that no
 * longer exist map to 0.
 */
export async function doRemainingByItemId(
  sb: any,
  doItemIds: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const ids = [...new Set(doItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  // chunkIn batches + pages the id IN-list so a >1000 DO-item set can't drop DOs
  // from the resolved set (which would silently under-report the write-path cap).
  const { data } = await chunkIn<{ delivery_order_id: string | null }>(ids, (batch, from, to) =>
    sb.from('delivery_order_items').select('delivery_order_id').in('id', batch).range(from, to));
  const doIds = [...new Set((data as Array<{ delivery_order_id: string | null }>).map((r) => r.delivery_order_id).filter((d): d is string => !!d))];
  const remainingMap = await doLineRemaining(sb, doIds);
  for (const id of ids) out.set(id, remainingMap.get(id)?.remaining ?? 0);
  return out;
}

/**
 * Resolve the set of candidate DO ids the picker should consider.
 * Explicit ?doIds=A,B wins; otherwise every shipped (non-cancelled, non-draft)
 * DO (capped) so the picker can show all of them. Returns [] when there are none.
 *
 * LEAK GUARD (DRAFT, 2026-06-25 anchoring diff vs 2990): a DRAFT DO has NOT
 * shipped, so it must never surface in the invoiceable-from-DO / returnable-from-DO
 * picker. Even when an explicit ?doIds= list is passed, doLineRemaining (above)
 * drops DRAFT headers, so a draft id can't yield invoiceable lines through either
 * entry point.
 */
export async function resolveCandidateDoIds(
  sb: any,
  doIdsParam: string | undefined,
  /* Company scope (owner 2026-08-10 cross-company audit). Both callers — the
     sales-invoice "invoiceable DO lines" picker and the delivery-return
     "returnable DO lines" picker — enumerated EVERY company's delivery orders
     when no explicit doIds was passed, then cascaded that id set into the
     header + line reads below. Same defect as the GRN pick-PO picker. Passed
     as an id (not the Hono ctx) so this lib stays free of the route layer;
     callers resolve it with requireActiveCompanyId/activeCompanyId.

     REQUIRED, not optional. A leak guard that a third caller can switch off by
     omitting an argument is not a guard — it is a default, and this one's
     default direction is "every company's delivery orders". Pass an explicit
     `null` only where there genuinely is no company; that then reads as a
     decision instead of an oversight (optional-param-noop sweep 2026-08-13). */
  companyId: number | null | undefined,
): Promise<string[]> {
  if (doIdsParam && doIdsParam.trim()) {
    return [...new Set(doIdsParam.split(',').map((d) => d.trim()).filter(Boolean))];
  }
  // Page through so PostgREST's 1000-row cap can't drop DOs from the picker
  // (a shipped DO past row 1000 would be invisible to From-DO flows).
  const { data: dos } = await paginateAll<{ id: string; status: string }>((from, to) => {
    let q = sb
      .from('delivery_orders')
      .select('id, status')
      .not('status', 'in', '("CANCELLED","DRAFT")');
    if (companyId != null) q = q.eq('company_id', companyId);
    return q.order('do_date', { ascending: false }).range(from, to);
  });
  return ((dos ?? []) as Array<{ id: string }>).map((d) => d.id).filter(Boolean);
}

/** Same-customer key — debtor_code when present, else debtor_name. Matches the
 *  SO→DO picker's rule so behaviour is identical across all three flows. */
export const custKeyOf = (l: { debtorCode: string | null; debtorName: string | null }): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

/* The POST-INSERT half of the remaining-to-invoice invariant, extracted pure so
 * the money-path guard is unit testable without booting the route.
 *
 * WHY A SECOND CHECK. `checkSiOverRemaining` is read-before-write: it reads each
 * DO line's remaining, finds it sufficient, and the caller inserts. Two invoices
 * raised against the same delivered goods at the same moment BOTH read the same
 * remaining, BOTH pass, and BOTH insert — the customer is billed twice for one
 * delivery.
 *
 * Every sibling conversion already closes this. SO -> DO does it inline ("Edge
 * #E" in delivery-orders-mfg.ts, rollback + 409 race_conflict); PO -> GRN has
 * verifyGrnOverReceipt; GRN -> PI has verifyGrnLinesNotOverInvoiced, whose
 * comment describes the identical failure. DO -> SI was the one path without it.
 *
 * WHY "< 0" IS THE WHOLE TEST. remaining_to_invoice = delivered − invoiced −
 * returned, and a just-inserted SI line counts toward `invoiced` immediately.
 * Re-reading therefore ALREADY subtracts our own quantity: >= 0 was within cap,
 * NEGATIVE is over by exactly that much. This is the same shape `from-sos`
 * uses, deliberately — one idea, not two.
 *
 * A MISSING id is not an offence. It means the line resolved to no open figure
 * at all, which the pre-check already refused; treating absence as "over" would
 * roll back a legitimate invoice whenever a read came back thin.
 */
export function findOverInvoicedDoItems(
  doItemIds: readonly string[],
  remainingAfterInsert: Map<string, number>,
): Array<{ doItemId: string; over: number }> {
  const out: Array<{ doItemId: string; over: number }> = [];
  for (const id of [...new Set(doItemIds)]) {
    const r = remainingAfterInsert.get(id);
    if (r === undefined) continue;
    if (r < 0) out.push({ doItemId: id, over: -r });
  }
  return out;
}
