// amendment-lane-handover — may an approver pass an open SO amendment to the
// OTHER desk? (owner 2026-09-17, option B: "not mine to approve" moves the
// request instead of only leaving a note for an administrator.)
//
// The approver's judgement decides WHO signs. It must not decide whether the
// Purchase Order follows: only the LINES lane's approval raises the follow-up
// PO Amendment (routes/so-amendments.ts, `if (lane === 'LINES')`), so a goods
// change signed on the DELIVERY lane would revise the Sales Order and leave
// the supplier building the old one. Hence the asymmetry:
//
//   DELIVERY -> LINES   always allowed. The Purchaser's path does strictly
//                       more; raisePoFollowUps raises nothing for a change the
//                       PO does not carry.
//   LINES -> DELIVERY   refused when the request holds anything the PO has to
//                       follow — a LINES-lane header key (Processing Date), or
//                       a PO-relevant change to a line that is not a service
//                       line. Judged with raisePoFollowUps' OWN predicates, so
//                       "would have raised a follow-up" has one definition.
//
// Either way the target lane must be free: uq_so_amendment_open_lane allows one
// open request per order per lane, and saying so beats a constraint error.
// Every refusal stays under 200 characters: the client's humanApiError replaces a
// longer server sentence with a generic one, and the reason is the whole point.
// A failed read refuses — an empty identity reads as "not a service line", but
// an empty LINE LIST reads as "nothing for the PO", which is the unsafe answer.

import type { Context } from 'hono';
import { classifyHeaderKey, type AmendmentLane } from '../shared/amendment-lane';
import { activeCompanyId, scopeToCompany } from './companyScope';
import { catalogCategoriesByCode } from './validate-item-codes';
import { poRelevant, serviceOnlyChange, type SoAmendLine, type SoLineIdentity } from './amendment-po-followup';

export type LaneHandoverVerdict =
  | { ok: true; toLane: AmendmentLane }
  | { ok: false; status: 409 | 500; error: string; reason: string };

// PRICE is here only for type-completeness: the flag-lane route refuses a
// handover on a PRICE amendment (Finance approves or rejects it in place), so
// judgeLaneHandover / otherLane never receive it.
const DESK: Record<AmendmentLane, string> = { LINES: 'Purchaser', DELIVERY: 'Logistic', PRICE: 'Sales Director' };

export const otherLane = (lane: AmendmentLane): AmendmentLane => (lane === 'LINES' ? 'DELIVERY' : 'LINES');

export async function judgeLaneHandover(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client and Hono context are untyped across this tree.
  sb: any, c: Context<any>,
  amendment: { id: string; so_doc_no: string; lane: AmendmentLane; header_changes: Record<string, unknown> | null },
): Promise<LaneHandoverVerdict> {
  const toLane = otherLane(amendment.lane);
  const readFailed = (what: string): LaneHandoverVerdict => ({
    ok: false, status: 500, error: 'handover_check_failed',
    reason: `Could not check ${what}, so the request was left where it is. Please try again.`,
  });

  const { data: busy, error: busyErr } = await scopeToCompany(
    sb.from('so_amendments').select('id, amendment_no')
      .eq('so_doc_no', amendment.so_doc_no).eq('lane', toLane).eq('status', 'REQUESTED'),
    c,
  ).limit(1);
  if (busyErr) return readFailed(`the ${DESK[toLane]} desk's open requests`);
  const siblings = (busy ?? []) as Array<{ amendment_no?: string | null }>;
  if (siblings.length > 0) {
    const sibling = siblings[0];
    return {
      ok: false, status: 409, error: 'target_lane_busy',
      reason: `The ${DESK[toLane]} desk already has an open amendment on this order (${sibling.amendment_no ?? 'pending'}). `
        + 'That one has to be approved or rejected first.',
    };
  }

  if (toLane === 'LINES') return { ok: true, toLane };

  const poHeaderKeys = Object.keys(amendment.header_changes ?? {}).filter((k) => {
    try { return classifyHeaderKey(k) === 'LINES'; } catch { return true; }
  });

  const { data: lineRows, error: lineErr } = await sb.from('so_amendment_lines')
    .select('sales_order_item_id, change_type, new_item_code, new_variants, new_qty, new_unit_price_sen')
    .eq('amendment_id', amendment.id);
  if (lineErr) return readFailed("this amendment's lines");
  const changed = ((lineRows ?? []) as SoAmendLine[]).filter(poRelevant);

  let goods = 0;
  if (changed.length > 0) {
    const { data: soItems, error: soItemErr } = await sb.from('mfg_sales_order_items')
      .select('id, item_code, item_group').eq('doc_no', amendment.so_doc_no);
    if (soItemErr) return readFailed("the order's lines");
    const identityById = new Map<string, SoLineIdentity>();
    for (const r of (soItems ?? []) as Array<{ id: string } & SoLineIdentity>) {
      identityById.set(r.id, { item_code: r.item_code, item_group: r.item_group });
    }
    const categoryByCode = await catalogCategoriesByCode(sb, changed.map((l) => l.new_item_code), activeCompanyId(c));
    if (!categoryByCode) return readFailed('the catalogue');
    goods = changed.filter((l) => !serviceOnlyChange(
      l, (id) => identityById.get(id), (code) => categoryByCode.get(code.trim()) ?? null,
    )).length;
  }

  if (goods > 0 || poHeaderKeys.length > 0) {
    const what = goods > 0
      ? `${goods} product line change${goods === 1 ? '' : 's'}`
      : 'the Processing Date';
    return {
      ok: false, status: 409, error: 'po_must_follow',
      reason: `It has ${what} the Purchase Order must follow, which only the Purchaser's approval does. `
        + 'If it should not go ahead, reject it with a reason.',
    };
  }
  return { ok: true, toLane };
}
