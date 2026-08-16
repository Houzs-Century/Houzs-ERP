/* Fill in a DO line's so_item_id when the client did not send one.
   ---------------------------------------------------------------------------
   THE HOLE THIS CLOSES. buildItemRow takes so_item_id straight off the request
   body and defaults it to null, so a client that forgets the field writes a
   delivery the system can never attribute — silently, and permanently. Nothing
   downstream can recover it: the remaining-qty guard, the sofa batch guard, the
   SO header's status flip and MRP's delivered-netting all resolve on that
   column, and MRP re-reports a shipped order as demand (owner 2026-08-14, on 24
   such lines across 11 sales orders; repaired by
   scripts/backfill-do-so-item-link.mjs).

   PR #1395 had already fixed the DO-create page to send the field, and lines
   written a week later were still unlinked. A client fix cannot close a hole
   that lives in the server accepting the omission — POST /from-sos never had
   the problem precisely because it derives the link itself. This gives the
   other two paths the same shape.

   THE RULE, and why each branch is what it is:

     · item code on the SO, resolvable  -> link it. This is the case that was
       being lost; 22 of the 24 repaired lines were the SO's ONLY line of that
       code, and the other two resolved on the variant identity both documents
       carry.
     · item code on the SO, ambiguous   -> REFUSE (400). The client is the only
       one that knows which line it meant. A silent null here is precisely the
       defect; a coin flip is worse, because a wrong link credits one line's
       shipment against another and cannot be told from a fact afterwards.
     · item code NOT on the SO          -> allow the null. This is the ad-hoc
       line the delivery paths already document ("ad-hoc lines with no
       so_item_id" in the warehouse resolver). Prod carries none today, but it
       is a supported shape and closing a hole is not a licence to break it.

   The pairing itself lives in scripts/lib/do-so-item-pairing.mjs, imported
   rather than mirrored, so the repair script and this guard cannot drift into
   two opinions about what a link means. */

// @ts-expect-error - plain .mjs, shared with the backfill script
import { pairDoLinesToSoLines } from '../../../scripts/lib/do-so-item-pairing.mjs';

export const DO_LINE_AMBIGUOUS_SO_LINE = 'do_line_ambiguous_so_line';

type Item = Record<string, unknown>;

export type ClaimedResult =
  | { ok: true; ids: Array<string | null> }
  | { ok: false; error: string; message: string };

/**
 * The so_item_ids the lines already ON this delivery order have claimed.
 *
 * Lives here rather than inline in the route because the ERROR branch is the
 * whole point and it is the branch an inline `data ?? []` throws away. This
 * list is what stops a second line on the SAME delivery order being paired to
 * an SO line the DO is already shipping; if the read fails and we call that
 * "nothing claimed", the exclusion silently empties and the guard that this
 * feeds becomes a no-op — the exact defect shape derive-do-so-item-id exists to
 * close, reintroduced one level up. So a failed read is refused, not defaulted.
 */
export async function claimedSoItemIdsOnDo(
  sb: any,
  deliveryOrderId: string,
): Promise<ClaimedResult> {
  const { data, error } = await sb
    .from('delivery_order_items')
    .select('so_item_id')
    .eq('delivery_order_id', deliveryOrderId);
  if (error) {
    return {
      ok: false,
      error: 'do_lines_unreadable',
      message: `Could not read this delivery's existing lines to link the new one — try again (${error.message}).`,
    };
  }
  return {
    ok: true,
    ids: ((data ?? []) as Array<{ so_item_id: string | null }>).map((r) => r.so_item_id),
  };
}

export type DeriveResult =
  | { ok: true; items: Item[]; derived: number }
  | { ok: false; error: string; message: string };

/**
 * Return `items` with `soItemId` filled in wherever it was missing and could be
 * read from the sales order. Items that already carry one are untouched.
 *
 * @param excludeSoItemIds so_item_ids already used by OTHER lines on this same
 *   delivery order. One DO must not put two lines against one SO line; two
 *   DIFFERENT delivery orders against one SO line is ordinary partial delivery
 *   and is NOT excluded here.
 */
export async function fillMissingSoItemIds(
  sb: any,
  soDocNo: string | null | undefined,
  items: Item[],
  excludeSoItemIds: Array<string | null | undefined> = [],
): Promise<DeriveResult> {
  const missing = items.filter((it) => !it.soItemId);
  if (!soDocNo || missing.length === 0) return { ok: true, items, derived: 0 };

  const { data, error } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, item_code, qty, variants, description2')
    .eq('doc_no', soDocNo)
    .eq('cancelled', false);
  /* A failed read is not an empty sales order. Leaving the link null here would
     reintroduce the very defect this exists to prevent, so say so instead. */
  if (error) {
    return {
      ok: false,
      error: 'so_lines_unreadable',
      message: `Could not read ${soDocNo}'s lines to link this delivery — try again (${error.message}).`,
    };
  }

  const claimed = new Set(excludeSoItemIds.filter(Boolean) as string[]);
  const soLines = ((data ?? []) as Array<{ id: string }>).filter((l) => !claimed.has(l.id));

  const { pairs, unresolved } = pairDoLinesToSoLines(
    missing.map((it, i) => ({
      id: `idx:${i}`,
      so_doc_no: soDocNo,
      item_code: it.itemCode,
      qty: Number(it.qty ?? 1),
      variants: it.variants ?? null,
      description2: it.description2 ?? null,
    })),
    soLines,
  );

  /* Only an ambiguity WITHIN the sales order is a refusal. "no SO line with
     this item code" is the ad-hoc line, which keeps its null. */
  const blocking = unresolved.filter((u: { reason: string }) => u.reason !== 'no SO line with this item code');
  if (blocking.length > 0) {
    const which = blocking.map((u: { item_code: string }) => u.item_code).join(', ');
    return {
      ok: false,
      error: DO_LINE_AMBIGUOUS_SO_LINE,
      message:
        `${soDocNo} has more than one line of ${which} and this delivery does not say which one it ships. ` +
        `Send soItemId on the line, or open the delivery from the sales order so it is carried for you.`,
    };
  }

  const bySlot = new Map<string, string>(
    pairs.map((p: { doItemId: string; soItemId: string }) => [p.doItemId, p.soItemId]),
  );
  let derived = 0;
  const out = items.map((it) => {
    if (it.soItemId) return it;
    const slot = `idx:${missing.indexOf(it)}`;
    const found = bySlot.get(slot);
    if (!found) return it;
    derived++;
    return { ...it, soItemId: found };
  });
  return { ok: true, items: out, derived };
}
