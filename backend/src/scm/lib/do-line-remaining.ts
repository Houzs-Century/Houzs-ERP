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
//
// ── A FAILED READ IS NOT "NOTHING IS CONSUMED YET" ─────────────────────────
// Every function here USED to destructure `{ data }` and drop `error`. supabase-js
// does not throw: a failed select resolves `{ data: null, error }`, so a database
// blip arrived at the same line as "there are no invoices against this line" and
// came out the other side as invoiced = 0, returned = 0, i.e. remaining =
// delivered. That is a money CEILING silently becoming its own maximum — the same
// shape BUG-HISTORY records for the payments read that let POD collect an
// already-paid order a second time, and the credit read that spent a credit
// twice. PR #2374 fixed the sibling guard and filed this one, because it has many
// callers: "The blip did not degrade the guard, it disabled it."
//
// So every read below binds `error` and every entry point returns a RESULT:
// `{ ok: true, … }` or `{ ok: false, reason }`. There is no third state, and
// there is no shape a caller can accidentally read as an empty ledger.
//
// WHAT A CALLER DOES WITH `ok: false` IS THE CALLER'S DECISION, and the two
// answers are genuinely different:
//   · a WRITE guard refuses — nothing is saved, and the message says the check
//     could not run rather than accusing the operator of over-invoicing;
//   · a DISPLAY surface refuses to RENDER (500 load_failed) — it must never
//     answer an unreadable ledger with an empty list, because "nothing left to
//     invoice" and "nothing came back" look identical on screen and only one of
//     them is true.
// Neither blames the operator for a blip they could not have caused, which is
// the house rule a gate has to satisfy.
//
// AND THE POST-INSERT RECHECK, which is the one real trade-off. Every convert
// re-derives this ledger AFTER inserting, to catch two operators billing the
// same delivery at the same instant. When THAT read fails the choice is between
// rolling back a document the pre-check passed and keeping one whose ceiling
// nobody verified. It rolls back: at that point nothing has escaped — no revenue
// posted, no stock moved, no other document references the header — so undoing
// costs a keystroke and keeping costs a double bill. But never under
// `race_conflict`: nobody raced them, and accusing a colleague would send the
// operator hunting for a duplicate that does not exist.
// ----------------------------------------------------------------------------

import { DO_NOT_DELIVERED_IN_LIST, doCountsAsDelivered } from '../shared/do-shipped-states';
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
  unitPriceSen: number;
  unitCostSen: number;
  discountSen: number;
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

/** The live Pending ledger, or the reason it could not be read. Never a Map
 *  that a failed read could have emptied — see the header. */
export type DoRemainingResult =
  | { ok: true; lines: Map<string, DoRemainingLine> }
  | { ok: false; reason: string };

/** Remaining-to-invoice qty per DO line id, or the reason it is unknown. */
export type DoRemainingQtyResult =
  | { ok: true; remaining: Map<string, number> }
  | { ok: false; reason: string };

/** The picker's candidate DO ids, or the reason they could not be listed. */
export type CandidateDoIdsResult =
  | { ok: true; doIds: string[] }
  | { ok: false; reason: string };

/**
 * The 409/503 body a WRITE path answers with when the Pending ledger could not
 * be read. Deliberately NOT the over_remaining body: the operator did not ask
 * for too much, we could not work out what "too much" is. Same shape and same
 * reasoning as unlinkedCheckUnavailableResponse in do-unlinked-so-lines.ts —
 * refuse, say why, and save nothing.
 */
export const remainingUnavailableResponse = (reason: string) => ({
  error: 'remaining_check_failed',
  message:
    `Could not work out how much of this delivery is still open, so nothing was saved — try again (${reason}).`,
});

/**
 * Derive the live Pending (remaining) quantity per DO line for the given DOs.
 * Keyed by delivery_order_items.id. Skips cancelled DOs entirely (a cancelled
 * DO delivered nothing). Returns a Map so callers can look up by do_item_id.
 *
 * `sb` is the loosely-typed Supabase client from the Hono context.
 *
 * FAILS CLOSED: any read error short-circuits to `{ ok: false }`. It never
 * returns a partial ledger, because a partial ledger is indistinguishable from
 * a line nobody has invoiced yet.
 */
export async function doLineRemaining(
  sb: any,
  doIds: string[],
): Promise<DoRemainingResult> {
  const out = new Map<string, DoRemainingLine>();
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return { ok: true, lines: out };

  // 1. Load the DO headers — we need debtor + do_number for the descriptors,
  //    and the status so we can drop cancelled DOs (they delivered nothing).
  //    chunkIn splits the id IN-list into ≤200 batches and pages each so a large
  //    DO set can't truncate at PostgREST's 1000-row cap.
  const { data: doHeaders, error: headErr } = await chunkIn(ids, (batch, from, to) => sb
    .from('delivery_orders')
    .select('id, do_number, status, debtor_code, debtor_name')
    .in('id', batch)
    .range(from, to));
  if (headErr) return { ok: false, reason: `delivery_orders: ${headErr.message}` };
  const headerById = new Map<
    string,
    { do_number: string; debtor_code: string | null; debtor_name: string | null }
  >();
  for (const d of (doHeaders ?? []) as Array<{
    id: string; do_number: string; status: string | null;
    debtor_code: string | null; debtor_name: string | null;
  }>) {
    // LEAK GUARD (PRE-SHIP, 2026-06-25 anchoring diff vs 2990) — a DO that has
    // NOT shipped delivered nothing, so its lines must never become invoiceable
    // / returnable (the "Pending" pool both downstream pickers read). That is
    // DRAFT *and* LOADED; this read named only DRAFT until 2026-08-20, and
    // unbilled-deliveries.ts had already dropped LOADED by hand next door.
    if (!doCountsAsDelivered(d.status)) continue; // delivered nothing
    headerById.set(d.id, { do_number: d.do_number, debtor_code: d.debtor_code, debtor_name: d.debtor_name });
  }
  const activeDoIds = [...headerById.keys()];
  if (activeDoIds.length === 0) return { ok: true, lines: out };

  // 2. Load the DO lines of the active DOs — `delivered` = each line's qty —
  //    in each DO's own listing order (line_no per 0165, NULLS LAST so
  //    pre-0165 DOs fall back to created_at).
  // chunkIn batches the DO ids and pages each — every batch returns all lines for
  // its DOs, so a DO's items stay contiguous and in line_no order (lineSeq below
  // stays correct); guards the 1000-row cap for a DO set with many lines.
  const { data: doLines, error: lineErr } = await chunkIn(activeDoIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select(
      'id, delivery_order_id, item_code, item_group, description, description2, uom, qty, ' +
      'unit_price_sen, unit_cost_sen, discount_sen, variants, ' +
      'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
      'custom_specials, line_suffix, special_order_price_sen',
    )
    .in('delivery_order_id', batch)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at')
    .range(from, to));
  if (lineErr) return { ok: false, reason: `delivery_order_items: ${lineErr.message}` };
  const lines = (doLines ?? []) as Array<Record<string, unknown> & {
    id: string; delivery_order_id: string; qty: number;
  }>;
  if (lines.length === 0) return { ok: true, lines: out };
  const doItemIds = lines.map((l) => l.id);

  // 3. Σ invoiced — sales_invoice_items linked by do_item_id whose parent
  //    invoice is NOT cancelled. Two-step: pull candidate SI lines, then drop
  //    those whose parent invoice is cancelled.
  const invoicedByDoItem = new Map<string, number>();
  {
    // chunkIn batches + pages the do_item_id IN-list so a DO line with >1000
    // downstream SI lines can't truncate and under-count `invoiced`.
    const { data: siLines, error: siErr } = await chunkIn<{ do_item_id: string | null; qty: number; sales_invoice_id: string }>(
      doItemIds, (batch, from, to) => sb
        .from('sales_invoice_items')
        .select('do_item_id, qty, sales_invoice_id')
        .in('do_item_id', batch)
        .range(from, to));
    /* THE one that mattered most: this read IS `invoiced`. Dropped, every
       already-invoiced unit reads as un-invoiced and the cap becomes the full
       delivered qty — a customer billed twice for one delivery. */
    if (siErr) return { ok: false, reason: `sales_invoice_items: ${siErr.message}` };
    const siRows = siLines;
    const siIds = [...new Set(siRows.map((l) => l.sales_invoice_id).filter(Boolean))];
    const activeSiIds = new Set<string>();
    if (siIds.length > 0) {
      const { data: sis, error: sErr } = await chunkIn<{ id: string; status: string | null }>(siIds, (batch, from, to) =>
        sb.from('sales_invoices').select('id, status').in('id', batch).range(from, to));
      /* The cancelled-filter read. Losing it makes EVERY parent invoice look
         cancelled (activeSiIds stays empty), which zeroes `invoiced` just as
         completely as losing the lines themselves. */
      if (sErr) return { ok: false, reason: `sales_invoices: ${sErr.message}` };
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
    const { data: drLines, error: drErr } = await chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(
      doItemIds, (batch, from, to) => sb
        .from('delivery_return_items')
        .select('do_item_id, qty_returned, delivery_return_id')
        .in('do_item_id', batch)
        .range(from, to));
    if (drErr) return { ok: false, reason: `delivery_return_items: ${drErr.message}` };
    const drRows = drLines;
    const drIds = [...new Set(drRows.map((l) => l.delivery_return_id).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const { data: drs, error: dErr } = await chunkIn<{ id: string; status: string | null }>(drIds, (batch, from, to) =>
        sb.from('delivery_returns').select('id, status').in('id', batch).range(from, to));
      if (dErr) return { ok: false, reason: `delivery_returns: ${dErr.message}` };
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
      unitPriceSen: Number(l.unit_price_sen ?? 0),
      unitCostSen: Number(l.unit_cost_sen ?? 0),
      discountSen: Number(l.discount_sen ?? 0),
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
  return { ok: true, lines: out };
}

/**
 * Live remaining-to-invoice qty per DO line id (delivered − invoiced −
 * returned), resolved straight from the DO item ids. Used by the SI write-path
 * guards so every sales_invoice_items create / add / qty-increase respects the
 * SAME cap the convert-from-DO picker enforces — no back door. DO lines that no
 * longer exist map to 0.
 *
 * A LINE THAT NO LONGER EXISTS AND A LINE WE COULD NOT READ ARE DIFFERENT. The
 * first is genuinely 0 and stays 0. The second returns `ok: false` — because 0
 * here means "you may not invoice any more of this", but a 0 that came from a
 * failed read used to mean the opposite everywhere it was consumed: the shadow
 * guard read it as "not pending, so this line is not a double-invoice" and let
 * the write through.
 */
export async function doRemainingByItemId(
  sb: any,
  doItemIds: Array<string | null | undefined>,
): Promise<DoRemainingQtyResult> {
  const ids = [...new Set(doItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return { ok: true, remaining: out };
  // chunkIn batches + pages the id IN-list so a >1000 DO-item set can't drop DOs
  // from the resolved set (which would silently under-report the write-path cap).
  const { data, error } = await chunkIn<{ delivery_order_id: string | null }>(ids, (batch, from, to) =>
    sb.from('delivery_order_items').select('delivery_order_id').in('id', batch).range(from, to));
  if (error) return { ok: false, reason: `delivery_order_items: ${error.message}` };
  const doIds = [...new Set((data as Array<{ delivery_order_id: string | null }>).map((r) => r.delivery_order_id).filter((d): d is string => !!d))];
  const remaining = await doLineRemaining(sb, doIds);
  if (!remaining.ok) return remaining;
  for (const id of ids) out.set(id, remaining.lines.get(id)?.remaining ?? 0);
  return { ok: true, remaining: out };
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
): Promise<CandidateDoIdsResult> {
  if (doIdsParam && doIdsParam.trim()) {
    return { ok: true, doIds: [...new Set(doIdsParam.split(',').map((d) => d.trim()).filter(Boolean))] };
  }
  // Page through so PostgREST's 1000-row cap can't drop DOs from the picker
  // (a shipped DO past row 1000 would be invisible to From-DO flows).
  const { data: dos, error } = await paginateAll<{ id: string; status: string }>((from, to) => {
    let q = sb
      .from('delivery_orders')
      .select('id, status')
      /* A LOADED DO is still on the lorry, so it is not invoiceable either —
         unbilled-deliveries.ts already dropped LOADED from its own copy of this
         list by hand, saying "billing it would be the bug". Same list now,
         built from DO_NOT_DELIVERED_STATES. */
      .not('status', 'in', DO_NOT_DELIVERED_IN_LIST);
    if (companyId != null) q = q.eq('company_id', companyId);
    return q.order('do_date', { ascending: false }).range(from, to);
  });
  /* An empty candidate list is what both pickers turn into `{ lines: [] }`, and
     on screen that reads "there is nothing left to invoice / return from any
     delivery". A failed sweep must never be able to say that. */
  if (error) return { ok: false, reason: `delivery_orders: ${error.message}` };
  return { ok: true, doIds: ((dos ?? []) as Array<{ id: string }>).map((d) => d.id).filter(Boolean) };
}

/** Same-customer key — debtor_code when present, else debtor_name. Matches the
 *  SO→DO picker's rule so behaviour is identical across all three flows. */
export const custKeyOf = (l: { debtorCode: string | null; debtorName: string | null }): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

/* The PRE-INSERT half of the remaining-to-invoice invariant — the read-before-
 * write cap every path that can attach a delivery to an invoice is checked
 * against (POST /, POST /:id/items, the qty PATCH, and the cancelled-invoice
 * reopen). It lives beside its post-insert twin below rather than in the route,
 * because the two are one rule and the route file may only shrink.
 *
 * TWO REFUSALS, deliberately distinct, because they blame different things:
 *   409 over_remaining         — the ledger was read and the request exceeds it.
 *                                The operator asked for too much.
 *   503 remaining_check_failed — the ledger could NOT be read. Nobody did
 *                                anything wrong; we cannot tell yet, so nothing
 *                                is saved and the message says exactly that.
 * What must never happen again is the third outcome this used to have: the read
 * fails, every cap silently reads 0 + exclusions, and the guard either refuses a
 * legitimate invoice for the wrong reason or (where an exclusion covers it)
 * waves through an over-invoice. A blip must not be able to decide either.
 */
export type SiOverRemainingRefusal =
  | { status: 409; body: { error: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } }
  | { status: 503; body: { error: string; message: string } };

export async function checkSiOverRemaining(
  sb: any,
  lines: Array<Record<string, unknown>>,
  excludeByDoItem?: Map<string, number>,
): Promise<SiOverRemainingRefusal | null> {
  const wanted = new Map<string, number>();
  for (const it of lines) {
    const doItemId = (it.doItemId as string | undefined) ?? null;
    if (!doItemId) continue;
    wanted.set(doItemId, (wanted.get(doItemId) ?? 0) + Number(it.qty ?? 0));
  }
  if (wanted.size === 0) return null;
  const remaining = await doRemainingByItemId(sb, [...wanted.keys()]);
  if (!remaining.ok) return { status: 503, body: remainingUnavailableResponse(remaining.reason) };
  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) {
    const cap = (remaining.remaining.get(doItemId) ?? 0) + (excludeByDoItem?.get(doItemId) ?? 0);
    if (requested > cap) offenders.push({ doItemId, requested, remaining: cap });
  }
  return offenders.length > 0 ? { status: 409, body: { error: 'over_remaining', lines: offenders } } : null;
}

/* REOPEN's ceiling, whole — the READ and the cap together.
 *
 * A cancelled invoice going back to SENT re-consumes every delivered unit it
 * names, so it must be capped like any other write. The caller used to do the
 * read itself and hand the rows to `checkSiOverRemaining`, which opens with
 * `if (wanted.size === 0) return null`. That made a FAILED read indistinguishable
 * from an invoice with no DO-linked lines: the ceiling was never consulted, the
 * invoice went back to SENT, and `postSiRevenue` re-posted AR and GL revenue for
 * goods a second invoice had already billed.
 *
 * The read is therefore part of the guard and belongs with it. A guard whose
 * inputs are assembled somewhere else is a guard that can be starved.
 */
export async function checkSiReopenOverRemaining(
  sb: any,
  salesInvoiceId: string,
): Promise<SiOverRemainingRefusal | null> {
  const { data, error } = await sb
    .from('sales_invoice_items')
    .select('do_item_id, qty')
    .eq('sales_invoice_id', salesInvoiceId);
  if (error) return { status: 503, body: remainingUnavailableResponse(`sales_invoice_items: ${error.message}`) };
  const lines = ((data ?? []) as Array<{ do_item_id: string | null; qty: number }>)
    .filter((l) => l.do_item_id)
    .map((l) => ({ doItemId: l.do_item_id as string, qty: l.qty }));
  return checkSiOverRemaining(sb, lines);
}

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
