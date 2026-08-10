/* ── Zero-cost receipt guard ────────────────────────────────────────────────
   Houzs suppliers do not price a purchase order. The price appears on the
   supplier's GOODS RECEIVED document, so a PO line legitimately carries
   unit_price_centi = 0 (live AutoCount: HOOKKA 2,264/2,264 PO lines unpriced,
   OHANA 100%, DORSETTLOFT 100%). The GRN create paths copy that price verbatim
   onto the receipt line, and from there nothing ever puts a cost back:

     purchase_order_items.unit_price_centi = 0
      -> grn_items.unit_price_centi = 0
      -> postGrnAndRollup: unit_cost_sen = landedUnitCostMyr ?? toMyrSen(0, rate)
      -> the FIFO trigger's IN branch is COALESCE(NEW.unit_cost_sen, 0) — the
         weighted-average fallback exists ONLY in the ADJUSTMENT branch
      -> the OUT consumes that lot at RM0 COGS
      -> DO line cost 0 -> sales_invoice_items.line_cost_centi 0
      -> the margin report reads 100%.

   A zero that reaches a lot is invisible: nothing downstream distinguishes
   "free" from "we forgot the price", and once the unit ships the COGS is
   settled and must never be rewritten. So the receipt is the last honest
   moment to ask, and this guard asks there.

   THE RULE, and why it cannot break the legitimate zeros. Free gifts, GWP and
   display stock are deliberately zero — and there is no is_free_gift flag on
   the PURCHASE side to key off (default_free_gifts lives entirely on the sales
   side: mfg_products / model_default_free_gifts / the SO claim path). What
   actually separates the two populations is their own purchase history, which
   is the same discriminator backfill-zero-cost-lots.mjs already uses and the
   owner already confirmed reading the zero-cost list ("可能是因为它是 GWP 免费的吧"):

     • a SKU that has NEVER been received at a non-zero cost is genuinely free —
       GWP pillows, DEMO units, display furniture. Zero IS its cost. Allowed,
       silently, forever.
     • a SKU that HAS been received at a non-zero cost before is not free. A
       zero on it is a missing price, and the receipt is refused.

   So the guard is self-maintaining: it needs no list to curate, no flag for
   anyone to set, and it can only ever fire on a SKU the system itself has
   already seen carry money.

   REFUSE, not warn. The choice was between refusing and requiring an explicit
   confirmation, and it is refuse-unless-explicitly-acknowledged: a warning on a
   receipt screen is read once and then never again, while the cost it lets
   through is silent for the rest of the unit's life. The acknowledgement exists
   because a hard refusal with no escape hatch gets worked around by typing a
   fake price, which is strictly worse than a recorded zero — so an operator who
   really is receiving something free ticks it, and grn_items.zero_cost_ack
   keeps that decision next to the line that carries it. */
import { isServiceLine } from '../shared/service-sku';

/** One receipt line, as the guard needs to see it. `unitCostSen` is the LANDED
 *  MYR cost the post path would stamp on the movement — already through the FX
 *  conversion and the freight allocation, so a line rescued by allocated
 *  freight is correctly not an offender. */
export type ReceiptCostLine = {
  id?: string | null;
  materialCode: string;
  qtyAccepted: number;
  unitCostSen: number;
  itemGroup?: string | null;
  /** Operator ticked "this really is free" for THIS line. */
  zeroCostAck?: boolean | null;
};

export type UncostedReceiptLine = {
  id: string | null;
  materialCode: string;
  qtyAccepted: number;
  /** What this SKU is known to have cost before — the evidence that the zero is
   *  a missing price rather than a free unit. */
  knownUnitCostSen: number;
};

export const ZERO_COST_RECEIPT_ERROR = 'zero_cost_receipt';

export function normalizeMaterialCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/* ── The acknowledgement, as it is written ─────────────────────────────────
   Every write path that can carry a tick goes through here, so the four
   columns can never drift apart: an ack with nobody's name on it, or a name
   left behind after the tick was removed, would both be worse than no column
   at all. `undefined` in means "the request did not mention it" — the caller
   spreads the result, so an untouched line keeps whatever it already had. */
export function zeroCostAckColumns(
  body: { zeroCostAck?: unknown; zeroCostReason?: unknown },
  userId: string | null,
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const reasonGiven = body.zeroCostReason !== undefined;
  const reason = reasonGiven ? (String(body.zeroCostReason ?? '').trim() || null) : undefined;
  if (body.zeroCostAck === undefined) {
    // A reason on its own is still worth keeping next to the line.
    if (reasonGiven) out.zero_cost_reason = reason;
    return out;
  }
  const ack = body.zeroCostAck === true || body.zeroCostAck === 'true' || body.zeroCostAck === 1;
  out.zero_cost_ack = ack;
  out.zero_cost_ack_by = ack ? userId : null;
  out.zero_cost_ack_at = ack ? now : null;
  if (reasonGiven) out.zero_cost_reason = reason;
  else if (!ack) out.zero_cost_reason = null;
  return out;
}

/* The pure rule, kept free of any client so it can be tested directly. Given
   the receipt's lines and what each SKU is known to have cost, return the lines
   that would open a zero-cost stock layer. Empty array = safe to post. */
export function findUncostedReceiptLines(
  lines: ReceiptCostLine[],
  knownCostSenByCode: Map<string, number>,
): UncostedReceiptLine[] {
  const out: UncostedReceiptLine[] = [];
  for (const line of lines) {
    // A SERVICE line (freight) creates no inventory movement, so it can never
    // open a lot — its amount is pooled into the goods lines' landed cost.
    if (isServiceLine({ itemGroup: line.itemGroup ?? null, itemCode: line.materialCode })) continue;
    if (!(Number(line.qtyAccepted) > 0)) continue;
    if (Number(line.unitCostSen) > 0) continue;
    if (line.zeroCostAck === true) continue;
    const known = knownCostSenByCode.get(normalizeMaterialCode(line.materialCode)) ?? 0;
    if (!(known > 0)) continue;
    out.push({
      id: line.id ?? null,
      materialCode: line.materialCode,
      qtyAccepted: Number(line.qtyAccepted),
      knownUnitCostSen: known,
    });
  }
  return out;
}

/** The 409 body. Shaped like the file's other refusals (`qty_exceeds_remaining`)
 *  so the frontend's existing error handling reads it without a special case.
 *
 *  `remedy` names the two ways out in the operator's own vocabulary, and
 *  `ackField` names the request field that carries the second one. A refusal
 *  that does not say what to do next is a dead end, and a dead end is what
 *  trains people to type a fake price — the one outcome this guard exists to
 *  prevent. */
export function zeroCostReceiptResponse(lines: UncostedReceiptLine[]) {
  return {
    error: ZERO_COST_RECEIPT_ERROR,
    message:
      'These lines would receive stock at zero cost, but the item has been purchased at a real price before. ' +
      'Enter the unit price from the supplier goods-received document, or tick "Received free" on the line.',
    remedy: [
      'Open the receipt, edit the line, and enter the unit price shown on the supplier goods-received document; or',
      'if the line really did arrive free (GWP, demo, display), tick "Received free" on that line and say why, then confirm again.',
    ],
    /* The line PATCH field the tick maps to: PATCH /scm/grns/:id/items/:itemId
       { zeroCostAck: true, zeroCostReason: "..." }. Named in the body so the
       remedy is discoverable from the refusal itself. */
    ackField: 'zeroCostAck',
    lines,
  };
}

/* What has this company actually paid for these SKUs? Read from the ledger the
   ERP owns rather than from any cutover snapshot, so the answer keeps working
   long after the AutoCount import is history.

   MOST RECENT non-zero lot cost per product, not the maximum: an audit of the
   AutoCount book measured MAX overstating 28 of 319 lines by RM14,244 (worst
   +123%) because one invoice can carry several builds of the same item code.
   Here the figure is only ever used as EVIDENCE that a non-zero price exists —
   never written to a lot — so its exact value cannot corrupt anything; it is
   shown to the operator so they can see what the item normally costs. */
export async function loadKnownPurchaseCostSen(
  sb: any,
  materialCodes: string[],
  companyId: number | null,
): Promise<Map<string, number>> {
  const codes = [...new Set(materialCodes.map((c) => (c ?? '').trim()).filter(Boolean))];
  const known = new Map<string, number>();
  if (codes.length === 0) return known;
  try {
    let q = sb.from('inventory_lots')
      .select('product_code, unit_cost_sen, received_at')
      .in('product_code', codes)
      .gt('unit_cost_sen', 0)
      .order('received_at', { ascending: false })
      .limit(2000);
    if (companyId != null) q = q.eq('company_id', companyId);
    const { data } = await q;
    for (const r of (data ?? []) as Array<{ product_code: string; unit_cost_sen: number | null }>) {
      const k = normalizeMaterialCode(r.product_code);
      // Rows arrive newest-first, so the first sighting of a code IS its most
      // recent priced receipt.
      if (!known.has(k) && Number(r.unit_cost_sen) > 0) known.set(k, Number(r.unit_cost_sen));
    }
  } catch {
    /* The guard must not be the reason a receipt cannot be posted. A read
       failure means "no evidence", which allows the post — the same posture
       verifyGrnOverReceipt takes for its own verification read. */
    return new Map();
  }
  return known;
}

/** Chokepoint helper: null when the receipt is safe to post, otherwise the 409
 *  body naming every line that would open a zero-cost layer. */
export async function checkReceiptCosts(
  sb: any,
  lines: ReceiptCostLine[],
  companyId: number | null,
): Promise<ReturnType<typeof zeroCostReceiptResponse> | null> {
  const candidates = lines.filter(
    (l) => Number(l.qtyAccepted) > 0
      && !(Number(l.unitCostSen) > 0)
      && l.zeroCostAck !== true
      && !isServiceLine({ itemGroup: l.itemGroup ?? null, itemCode: l.materialCode }),
  );
  // Nothing is zero-priced — do not spend a query.
  if (candidates.length === 0) return null;
  const known = await loadKnownPurchaseCostSen(sb, candidates.map((l) => l.materialCode), companyId);
  const offenders = findUncostedReceiptLines(candidates, known);
  return offenders.length > 0 ? zeroCostReceiptResponse(offenders) : null;
}
