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
//   remaining = delivered − invoiced − returned          (= Pending to invoice)
//
// THIS FORMULA IS THE INVOICE POOL. Returning used to share it — one number for
// both, so a unit that had been invoiced could not also be returned. That
// blocked the ordinary retail flow (customer pays, the DO is invoiced, THEN part
// of it comes back), so on 2026-09-20 the RETURN pool was split off:
//   remaining_to_return = delivered − returned          (independent of invoicing)
// See returnableRemainingFrom below and doReturnableRemaining in
// routes/delivery-returns.ts. The invoice pool is UNCHANGED and still subtracts
// returned, so returned goods still can't be invoiced and nothing double-bills.
// (The MONEY side of returning invoiced goods — credit note / AR reversal — is a
// separate, deferred phase; the split only lets stock come back.)
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

import { DO_NOT_DELIVERED_IN_LIST, DO_NOT_INVOICEABLE_IN_LIST, doCountsAsDelivered, doCountsAsInvoiceable } from '../shared/do-shipped-states';

/* WHICH QUESTION THIS PENDING POOL IS BEING ASKED. The engine below serves two
   callers that want DIFFERENT answers for exactly one status, LOADED:

     'invoiceable' — may these lines be BILLED? Owner 2026-08-20: yes, even on
                     the lorry; the invoice is raised by a person who knows.
     'delivered'   — have these goods actually LEFT? Returns, the unbilled-money
                     report and every stock sum ask this, and a LOADED DO has
                     not: its inventory OUT has not fired (#2557).

   REQUIRED, never defaulted, for the reason the companyId argument beside it is
   (optional-param-noop sweep 2026-08-13): a basis a caller can omit is not a
   basis, it is whichever answer the last editor happened to prefer — and this
   rule has now been reversed twice, so the next caller must state which of the
   two it means rather than inherit it. */
export type DoPendingBasis = 'invoiceable' | 'delivered';

const inPendingPool = (basis: DoPendingBasis, status: string | null | undefined): boolean =>
  basis === 'invoiceable' ? doCountsAsInvoiceable(status) : doCountsAsDelivered(status);
import { paginateAll, chunkIn } from './paginate-all';
import { lineLinkItemMismatch } from './line-link-item-identity';
import { SI_TRANSFERABLE_DO_STATES } from '../shared/do-shipped-states';

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
  lineDeliveryDate: string | null;
  delivered: number;
  invoiced: number;
  returned: number;
  remaining: number;
  unitPriceSen: number;
  unitCostSen: number;
  discountSen: number;
  variants: unknown;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  customSpecials: unknown;
  lineSuffix: string | null;
  specialOrderPriceSen: number;
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
export type DoRemainingHeader = {
  id: string; do_number: string; status: string | null;
  debtor_code: string | null; debtor_name: string | null;
};

export async function doLineRemaining(
  sb: any,
  doIds: string[],
  basis: DoPendingBasis,
  /* The DO list (lib/do-list-lines.ts) has just read these headers for the same
     ids; passing them skips step 1's identical read (HC-0002). */
  knownHeaders?: DoRemainingHeader[],
): Promise<DoRemainingResult> {
  const out = new Map<string, DoRemainingLine>();
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return { ok: true, lines: out };

  let doHeaders: DoRemainingHeader[];
  if (knownHeaders) {
    const wanted = new Set(ids);
    doHeaders = knownHeaders.filter((h) => wanted.has(h.id));
  } else {
    const head = await chunkIn<DoRemainingHeader>(ids, (batch, from, to) => sb
      .from('delivery_orders')
      .select('id, do_number, status, debtor_code, debtor_name')
      .in('id', batch)
      .range(from, to));
    if (head.error) return { ok: false, reason: `delivery_orders: ${head.error.message}` };
    doHeaders = head.data;
  }
  const headerById = new Map<
    string,
    { do_number: string; debtor_code: string | null; debtor_name: string | null }
  >();
  for (const d of doHeaders) {
    // LEAK GUARD (2026-06-25 anchoring diff vs 2990) — a DO that delivered
    // nothing must never reach the "Pending" pool the downstream pickers read.
    // WHICH states those are depends on the question: a CANCELLED or DRAFT DO is
    // out of both, and LOADED is out of the DELIVERED pool (its inventory OUT
    // has not fired, #2557) but IN the INVOICEABLE one (owner 2026-08-20). See
    // DoPendingBasis above — this guard used to answer only the first question,
    // for every caller.
    if (!inPendingPool(basis, d.status)) continue;
    headerById.set(d.id, { do_number: d.do_number, debtor_code: d.debtor_code, debtor_name: d.debtor_name });
  }
  const activeDoIds = [...headerById.keys()];
  if (activeDoIds.length === 0) return { ok: true, lines: out };

  const { data: doLines, error: lineErr } = await chunkIn(activeDoIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select(
      'id, delivery_order_id, item_code, item_group, description, description2, uom, qty, ' +
      'unit_price_sen, unit_cost_sen, discount_sen, variants, line_delivery_date, ' +
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

  const invoicedByDoItem = new Map<string, number>();
  {
    const { data: siLines, error: siErr } = await chunkIn<{ do_item_id: string | null; qty: number; sales_invoice_id: string }>(
      doItemIds, (batch, from, to) => sb
        .from('sales_invoice_items')
        .select('do_item_id, qty, sales_invoice_id')
        .in('do_item_id', batch)
        .range(from, to));
    if (siErr) return { ok: false, reason: `sales_invoice_items: ${siErr.message}` };
    const siRows = siLines;
    const siIds = [...new Set(siRows.map((l) => l.sales_invoice_id).filter(Boolean))];
    const activeSiIds = new Set<string>();
    if (siIds.length > 0) {
      const { data: sis, error: sErr } = await chunkIn<{ id: string; status: string | null }>(siIds, (batch, from, to) =>
        sb.from('sales_invoices').select('id, status').in('id', batch).range(from, to));
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

  const returnedByDoItem = new Map<string, number>();
  {
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
      lineDeliveryDate: (l.line_delivery_date as string | null) ?? null,
      delivered,
      invoiced,
      returned,
      remaining: delivered - invoiced - returned,
      unitPriceSen: Number(l.unit_price_sen ?? 0),
      unitCostSen: Number(l.unit_cost_sen ?? 0),
      discountSen: Number(l.discount_sen ?? 0),
      variants: l.variants ?? null,
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
 * Re-key a Pending ledger onto the RETURN pool: remaining = delivered − returned,
 * independent of invoicing (owner 2026-09-20). `doLineRemaining` computes
 * `remaining` as the INVOICE pool (delivered − invoiced − returned); returning is
 * about goods that physically shipped, so a fully-invoiced DO line must still be
 * returnable up to what was delivered and not yet returned — otherwise a customer
 * who paid, was invoiced, and then sends part back can never have a return raised.
 * Every other field (delivered / invoiced / returned) is preserved; only the
 * derived `remaining` changes. doReturnableRemaining (routes/delivery-returns.ts)
 * is the one caller, and feeds it into the picker and every over-return guard.
 */
export function returnableRemainingFrom(lines: Map<string, DoRemainingLine>): Map<string, DoRemainingLine> {
  const out = new Map<string, DoRemainingLine>();
  for (const [id, l] of lines) out.set(id, { ...l, remaining: l.delivered - l.returned });
  return out;
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
  basis: DoPendingBasis,
): Promise<DoRemainingQtyResult> {
  const ids = [...new Set(doItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return { ok: true, remaining: out };
  const { data, error } = await chunkIn<{ delivery_order_id: string | null }>(ids, (batch, from, to) =>
    sb.from('delivery_order_items').select('delivery_order_id').in('id', batch).range(from, to));
  if (error) return { ok: false, reason: `delivery_order_items: ${error.message}` };
  const doIds = [...new Set((data as Array<{ delivery_order_id: string | null }>).map((r) => r.delivery_order_id).filter((d): d is string => !!d))];
  const remaining = await doLineRemaining(sb, doIds, basis);
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
  basis: DoPendingBasis,
): Promise<CandidateDoIdsResult> {
  if (doIdsParam && doIdsParam.trim()) {
    return { ok: true, doIds: [...new Set(doIdsParam.split(',').map((d) => d.trim()).filter(Boolean))] };
  }
  const { data: dos, error } = await paginateAll<{ id: string; status: string }>((from, to) => {
    let q = sb
      .from('delivery_orders')
      .select('id, status')
      /* WHICH DELIVERIES THIS PICKER OFFERS, per the question being asked. The
         two lists differ on exactly one status and the owner has ruled on it:

           invoiceable — DRAFT and CANCELLED only. A LOADED delivery IS offered
             for invoicing (owner 2026-08-20, 不要拦 —— 人自己知道: the invoice is
             raised by hand by someone who knows whether the goods arrived).
             #2557 excluded it here as a side effect of its stock fix; that half
             is reverted, its over-delivery half is untouched.
           delivered   — DRAFT, LOADED and CANCELLED. The returnable picker keeps
             this: goods still on the lorry never left, so nothing can come back.

         This is the picker HALF of the rule; siTransferRefusal is the create
         gate, and both now read the same declaration, so the picker cannot
         advertise a delivery the create path then refuses — nor hide one it
         would have accepted, which is the direction that was wrong. */
      .not('status', 'in', basis === 'invoiceable' ? DO_NOT_INVOICEABLE_IN_LIST : DO_NOT_DELIVERED_IN_LIST);
    if (companyId != null) q = q.eq('company_id', companyId);
    return q.order('do_date', { ascending: false }).range(from, to);
  });
  if (error) return { ok: false, reason: `delivery_orders: ${error.message}` };
  return { ok: true, doIds: ((dos ?? []) as Array<{ id: string }>).map((d) => d.id).filter(Boolean) };
}

/** Same-customer key — debtor_code when present, else debtor_name. Matches the
 *  SO→DO picker's rule so behaviour is identical across all three flows. */
export const custKeyOf = (l: { debtorCode: string | null; debtorName: string | null }): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

export type SiOverRemainingRefusal =
  | { status: 409; body: { error: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } }
  | { status: 503; body: { error: string; message: string } }
  /* The identity refusal — docs/bugs/0672 site 15. It carries `reason` rather
     than `lines`, the shape soLinkTargetRefusal already answers with. */
  | { status: 409 | 503; body: { error: string; reason: string } & Record<string, unknown> };

/* The identity half of checkSiOverRemaining, kept separate so the quantity
   ceiling and the product assertion each read as one thing.

   A LINE WHOSE SOURCE CANNOT BE READ BACK IS REFUSED, NOT SKIPPED. An id that
   resolved to nothing cannot be asserted equal to anything, and treating "not
   found" as "nothing to compare" is precisely the false negative docs/bugs/0672
   is made of. `checkSiReopenOverRemaining` is the one caller that cannot supply
   an item code (it reads `do_item_id, qty` off the stored invoice); it now reads
   `item_code` too, so every caller can be compared. */
async function siLinkedItemCodes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  lines: Array<Record<string, unknown>>,
): Promise<SiOverRemainingRefusal | null> {
  const claims = lines
    .filter((l) => l.doItemId)
    .map((l) => ({ linkId: String(l.doItemId), itemCode: l.itemCode }));
  if (claims.length === 0) return null;
  const { data, error } = await sb.from('delivery_order_items')
    .select('id, item_code').in('id', [...new Set(claims.map((cl) => cl.linkId))]);
  if (error) {
    return { status: 503, body: { error: 'link_identity_unavailable', reason: `delivery_order_items: ${error.message}` } };
  }
  const byId = new Map<string, string | null>(
    ((data ?? []) as Array<{ id: string; item_code: string | null }>).map((r) => [r.id, r.item_code]),
  );
  const bad = lineLinkItemMismatch(claims, byId, { source: 'Delivery Order line' });
  return bad ? { status: 409, body: bad } : null;
}

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
  const remaining = await doRemainingByItemId(sb, [...wanted.keys()], 'invoiceable');
  if (!remaining.ok) return { status: 503, body: remainingUnavailableResponse(remaining.reason) };
  /* IDENTITY BEFORE QUANTITY — docs/bugs/0672 site 15.
     This guard proved for months that a line does not take MORE than the
     delivery has left. It never asked whether the delivery line is the SAME
     PRODUCT. A sales-invoice line for product B naming a delivery line for
     product A passes every check on this path: valid foreign key, nothing
     dangling, no constraint broken — and `doLineRemaining` then draws that
     invoice down against the WRONG delivery line, leaving the right one open to
     be invoiced a second time. probe-link-identity.mjs run 34172468269 counted
     2 such rows live on `sales_invoice_items.do_item_id`.

     It belongs HERE rather than at the two call sites for the reason this
     file's own header gives about the reopen path: "a guard whose inputs are
     assembled somewhere else is a guard that can be starved." Both the create
     and the add-line path already funnel through this function, so putting the
     rule here makes it impossible to reach one of them without it.

     Asserted BEFORE the cap: a ceiling computed against the wrong line is a
     number about the wrong thing, and reporting it sends the operator to fix a
     quantity when the real fault is the source they picked. Costs no extra
     read — doLineRemaining already selects `item_code` for every DO line. */
  {
    const codes = await siLinkedItemCodes(sb, lines);
    if (codes) return codes;
  }
  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) {
    const cap = (remaining.remaining.get(doItemId) ?? 0) + (excludeByDoItem?.get(doItemId) ?? 0);
    if (requested > cap) offenders.push({ doItemId, requested, remaining: cap });
  }
  return offenders.length > 0 ? { status: 409, body: { error: 'over_remaining', lines: offenders } } : null;
}

export async function checkSiReopenOverRemaining(
  sb: any,
  salesInvoiceId: string,
): Promise<SiOverRemainingRefusal | null> {
  const { data, error } = await sb
    .from('sales_invoice_items')
    .select('do_item_id, qty, item_code')
    .eq('sales_invoice_id', salesInvoiceId);
  if (error) return { status: 503, body: remainingUnavailableResponse(`sales_invoice_items: ${error.message}`) };
  const lines = ((data ?? []) as Array<{ do_item_id: string | null; qty: number; item_code: string | null }>)
    .filter((l) => l.do_item_id)
    .map((l) => ({ doItemId: l.do_item_id as string, qty: l.qty, itemCode: l.item_code }));
  return checkSiOverRemaining(sb, lines);
}

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

/* THE SERVER'S ANSWER TO "MAY THIS DELIVERY BE INVOICED", AND UNTIL 2026-08-18
   THERE WAS NONE. The rule lived only in clients, so it had been re-derived four
   times and the four disagreed:
     · here — refused only CANCELLED, so the API and the mobile shell would
       invoice anything else;
     · resolveCandidateDoIds (do-line-remaining.ts) — everything except CANCELLED
       and DRAFT;
     · the desktop footer — a hand-typed ['signed','delivered'];
     · the same page's line edit-lock — the five shipped states.
   A restriction only one client enforces is not a restriction: the desktop
   greyed the button out while the same transfer went through from a phone.

   That narrowest spelling was also a MULTI-ORGANISATION defect rather than a
   status one. It carries no company term and never did; it bit one organisation
   because of DATA — 2990's source system has no "delivered" step, so its
   deliveries sit at DISPATCHED, while HOUZS's AutoCount carry-overs arrived as
   literal 'DELIVERED'. One build, one permission set, and 2990 was told the
   transfer did not exist.

   The owner ruled DISPATCHED/IN_TRANSIT/SIGNED/DELIVERED on 2026-08-18; #2485
   widened it next day to every CONFIRMED delivery, LOADED included.
   SI_TRANSFERABLE_DO_STATES is that rule's one home and here it is ENFORCED.
   BOTH Sales-Invoice entry points call it — POST /from-dos and the append
   path — because a gate enforced on one of two doors is a gate with a hole.
   The create path refused exactly CANCELLED before this function; it now also
   refuses DRAFT (#2485 keeps Confirm a prerequisite) and INVOICED (nothing
   writes it). LOADED is NOT refused: that would invent a new restriction. */
export function siTransferRefusal(status: string | null | undefined): { error: string; reason: string } | null {
  const s = String(status ?? '').trim().toUpperCase();
  if ((SI_TRANSFERABLE_DO_STATES as readonly string[]).includes(s)) return null;
  if (s === 'CANCELLED') {
    return { error: 'do_cancelled', reason: 'This delivery order was cancelled, so it cannot be invoiced. Raise a new delivery order to deliver these goods again.' };
  }
  if (s === 'DRAFT') {
    return { error: 'do_not_confirmed', reason: 'This delivery order is still a draft — confirm it before raising a Sales Invoice.' };
  }
  return { error: 'do_not_transferable', reason: `A Sales Invoice can only be raised from a confirmed delivery order (${SI_TRANSFERABLE_DO_STATES.join(', ')}).` };
}

/** SQLSTATE raised by scm.assert_do_line_not_over_invoiced (mig
 *  20261014T1410): the write would push a DO line's live invoiced total past
 *  its delivered qty net of returns. Callers answer it with a 409, not a 500. */
export const DO_LINE_OVER_INVOICED = 'P0413';
export const isDoLineOverInvoiced = (err: unknown): boolean =>
  (err as { code?: unknown } | null | undefined)?.code === DO_LINE_OVER_INVOICED;
