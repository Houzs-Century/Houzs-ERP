/* ── Zero-cost receipt guard ────────────────────────────────────────────────
   Houzs suppliers do not price a purchase order. The price appears on the
   supplier's GOODS RECEIVED document, so a PO line legitimately carries
   unit_price_sen = 0 (live AutoCount: HOOKKA 2,264/2,264 PO lines unpriced,
   OHANA 100%, DORSETTLOFT 100%). The GRN create paths copy that price verbatim
   onto the receipt line, and from there nothing ever puts a cost back:

     purchase_order_items.unit_price_sen = 0
      -> grn_items.unit_price_sen = 0
      -> postGrnAndRollup: unit_cost_sen = landedUnitCostMyr ?? toMyrSen(0, rate)
      -> the FIFO trigger's IN branch is COALESCE(NEW.unit_cost_sen, 0) — the
         weighted-average fallback exists ONLY in the ADJUSTMENT branch
      -> the OUT consumes that lot at RM0 COGS
      -> DO line cost 0 -> sales_invoice_items.line_cost_sen 0
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
import type { Context } from 'hono';
import { refuseWithoutWriting } from './no-write-refusal';
import { isServiceLine } from '../shared/service-sku';
import { pgrestIn } from './pgrest-in-list';
import { chunkIn } from './paginate-all';

/** One receipt line, as the guard needs to see it. `unitCostSen` is the LANDED
 *  MYR cost the post path would stamp on the movement — already through the FX
 *  conversion and the freight allocation, so a line rescued by allocated
 *  freight is correctly not an offender. */
export type ReceiptCostLine = {
  id?: string | null;
  itemCode: string;
  qtyAccepted: number;
  unitCostSen: number;
  itemGroup?: string | null;
  zeroCostAck?: boolean | null;
};

export type UncostedReceiptLine = {
  id: string | null;
  itemCode: string;
  qtyAccepted: number;
  knownUnitCostSen: number;
};

export const ZERO_COST_RECEIPT_ERROR = 'zero_cost_receipt';

/* ── The owner's ruling, 2026-09-10: a receipt SAVES without a price ────────
   His words, twice: 「GRN 没有amount 也要可以save」 and 「然后我要GRN 没有amount
   也可以save」, after a New Goods Receipt refused three bedframe lines.

   It is his standing philosophy applied to this screen — 「尽量放宽,不要有硬墙」 —
   and the refusal above WAS a hard wall: the receipt could not be saved at all
   until somebody either typed a price they did not have or ticked a box per
   line.

   WHAT IS GIVEN UP, said plainly, because the header of this file is the case
   AGAINST it and every word of that case is still true: a zero that reaches a
   lot is consumed at RM0 COGS, the margin then reads 100%, and once the unit
   ships the COGS is settled and must never be rewritten. This company has
   already paid that bill once — the 2026-09-02 clean-up moved 5,030 units off
   zero cost and put RM 1,038,168 back into the inventory value.

   WHAT IS KEPT, and it is the half that actually mattered. The old comment says
   the danger is that a zero is INVISIBLE — "nothing downstream distinguishes
   'free' from 'we forgot the price'". That is no longer true of these lines. A
   receipt saved without a price is STAMPED as one, with nobody's name on it:

     zero_cost_ack     = true   -> the post path proceeds
     zero_cost_ack_by  = NULL   -> NOBODY said this was free
     zero_cost_reason  = the sentence below

   So `zero_cost_ack = true AND zero_cost_ack_by IS NULL` is exactly the
   population "received with no price, unclaimed" — findable in one predicate,
   which is what `backfill-zero-cost-lots.mjs` needs to price them later. A
   line an operator really ticks still carries their id, and the two can never
   be confused. */
export const RECEIVED_WITH_NO_PRICE =
  'Received with no price on the supplier document (owner ruling 2026-09-10). '
  + 'Nobody has said this arrived free — price it when the supplier invoice comes in.';

/**
 * Stamp the lines that would have been refused, so the zero is recorded rather
 * than either refused or forgotten.
 *
 * NEVER THROWS, and never blocks the receipt. The point of the ruling is that
 * the save succeeds; a failure to write the marker must not undo that. It is
 * reported to the caller so a route can log it, and the receipt goes on.
 */
export async function recordReceivedWithNoPrice(
  sb: any,
  lines: ReadonlyArray<{ id: string | null }>,
  now: string = new Date().toISOString(),
): Promise<{ stamped: number; failed: number }> {
  const ids = lines.map((l) => l.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return { stamped: 0, failed: 0 };
  try {
    const { error } = await sb.from('grn_items')
      .update({
        zero_cost_ack: true,
        zero_cost_ack_by: null,
        zero_cost_ack_at: now,
        zero_cost_reason: RECEIVED_WITH_NO_PRICE,
      })
      .in('id', ids);
    return error ? { stamped: 0, failed: ids.length } : { stamped: ids.length, failed: 0 };
  } catch {
    return { stamped: 0, failed: ids.length };
  }
}

export function normalizeMaterialCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function zeroCostAckColumns(
  body: { zeroCostAck?: unknown; zeroCostReason?: unknown },
  userId: string | null,
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const reasonGiven = body.zeroCostReason !== undefined;
  const reason = reasonGiven ? (String(body.zeroCostReason ?? '').trim() || null) : undefined;
  if (body.zeroCostAck === undefined) {
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

export function findUncostedReceiptLines(
  lines: ReceiptCostLine[],
  knownCostSenByCode: Map<string, number>,
): UncostedReceiptLine[] {
  const out: UncostedReceiptLine[] = [];
  for (const line of lines) {
    if (isServiceLine({ itemGroup: line.itemGroup ?? null, itemCode: line.itemCode })) continue;
    if (!(Number(line.qtyAccepted) > 0)) continue;
    if (Number(line.unitCostSen) > 0) continue;
    if (line.zeroCostAck === true) continue;
    const known = knownCostSenByCode.get(normalizeMaterialCode(line.itemCode)) ?? 0;
    if (!(known > 0)) continue;
    out.push({
      id: line.id ?? null,
      itemCode: line.itemCode,
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
    ackField: 'zeroCostAck',
    lines,
  };
}

export function refuseZeroCostReceipt(
  c: Context,
  body: ReturnType<typeof zeroCostReceiptResponse> | Record<string, unknown>,
  proof: { nothingWritten: boolean },
): Response {
  if (proof.nothingWritten) return refuseWithoutWriting(c, body, 409);
  return c.json(body, 409);
}

export async function loadKnownPurchaseCostSen(
  sb: any,
  itemCodes: string[],
  companyId: number | null,
): Promise<Map<string, number>> {
  const codes = [...new Set(itemCodes.map((c) => (c ?? '').trim()).filter(Boolean))];
  const known = new Map<string, number>();
  if (codes.length === 0) return known;
  try {
    const { data, error } = await chunkIn(codes, (part, from, to) => {
      let q = pgrestIn(sb.from('inventory_lots')
        .select('item_code, unit_cost_sen, received_at'), 'item_code', part)
        .gt('unit_cost_sen', 0)
        .order('received_at', { ascending: false })
        .order('id');
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.range(from, to);
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[zero-cost-receipt-guard] inventory_lots priced-receipt read failed:', (error as { message?: unknown }).message ?? error);
    }
    for (const r of (data ?? []) as Array<{ item_code: string; unit_cost_sen: number | null }>) {
      const k = normalizeMaterialCode(r.item_code);
      if (!known.has(k) && Number(r.unit_cost_sen) > 0) known.set(k, Number(r.unit_cost_sen));
    }
  } catch {
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
      && !isServiceLine({ itemGroup: l.itemGroup ?? null, itemCode: l.itemCode }),
  );
  if (candidates.length === 0) return null;
  const known = await loadKnownPurchaseCostSen(sb, candidates.map((l) => l.itemCode), companyId);
  const offenders = findUncostedReceiptLines(candidates, known);
  if (offenders.length === 0) return null;
  /* THE OWNER'S RULING, 2026-09-10 — see RECEIVED_WITH_NO_PRICE above. The
     receipt is NOT refused. The offending lines are stamped as received with no
     price, with nobody's name on them, and this returns null so the post goes
     on. `zeroCostReceiptResponse` is kept because it is what an operator's own
     tick path still answers with, and because deleting the shape would take the
     `ackField` contract with it. */
  await recordReceivedWithNoPrice(sb, offenders);
  return null;
}
