// ---------------------------------------------------------------------------
// do-so-link-repair — decide which orphaned Delivery-Order lines may be
// re-pointed at the Sales-Order line they were raised from.
//
// THE DEFECT THIS HEALS. `delivery_order_items.so_item_id` is the ONLY key the
// two "has this order shipped?" engines read:
//
//   · soDeliverableRemaining (delivery-orders-mfg.ts) sums delivered qty with
//     `.in('so_item_id', soItemIds)` — MRP subtracts that from demand;
//   · isSoFullyCovered (so-delivery-sync.ts) opens with `if (!d.soItemId)
//     continue;` — that decides CONFIRMED -> DELIVERED.
//
// So a DO line whose so_item_id is NULL is invisible to both: the goods left
// the building (inventory_movements carries the OUT), the SO stays CONFIRMED,
// and MRP keeps asking Procurement to buy the item again. On 2026-08-17 that
// was 26 live lines across 8 non-cancelled DOs on 2990 — the "已经出货了为什么
// MRP 还叫我下单" report.
//
// The FK is `ON DELETE SET NULL`, which is why the column can go from a real id
// to NULL under a document nobody edited. so-line-relink.ts already carries the
// forward-looking half of this story (freeze the links before a delete-and-
// reinsert); this module is the backward-looking half — re-derive a link that
// is already gone, from evidence rather than from a guess.
//
// PURE, so the decision is testable without a database
// (backend/tests/doSoLinkRepair.test.ts).
//
// NO `#!/usr/bin/env node` HERE, deliberately. A test imports this module and
// on Windows vitest INLINES it — a `#!` no longer at byte 0 is a hard
// SyntaxError that reports as a failed FILE with zero tests and no line number
// (#2062). Runnable scripts keep their shebang; imported libs never get one.
// ---------------------------------------------------------------------------

/** Case/space-insensitive item-code identity — the same normalisation
 *  so-line-relink.ts matches on, so the two agree about what "same SKU" means. */
const normCode = (code) => String(code ?? '').trim().toUpperCase();

/**
 * PURE. Decide, per orphaned DO line, whether it can be re-pointed.
 *
 * A repair is offered ONLY when the answer is forced — one and only one
 * candidate SO line, and no competing claim. Everything else is REFUSED and
 * returned with a reason, because a wrong link is worse than a missing one:
 * every consumer downstream (MRP coverage, the DELIVERED flip, drop-ship batch
 * resolution, costing) reads the link as "this shipment IS that order line".
 *
 * @param {Array<{id: string, itemCode: string, qty: number, doNumber?: string|null}>} orphanLines
 *        DO lines with so_item_id IS NULL, all belonging to DOs that name
 *        `soDocNo` in their header.
 * @param {Array<{id: string, itemCode: string, qty: number}>} soLines
 *        The SO's NON-CANCELLED lines.
 * @param {Iterable<string>} claimedSoItemIds
 *        SO line ids some OTHER DO line already points at. A claimed line is
 *        already accounted for; re-pointing a second shipment at it would book
 *        the same order line as delivered twice.
 * @returns {{restore: Array<{doItemId: string, soItemId: string, itemCode: string, qty: number}>,
 *            refused: Array<{doItemId: string, itemCode: string, qty: number, reason: string}>}}
 */
export function planDoSoLinkRepair(orphanLines, soLines, claimedSoItemIds = []) {
  const claimed = new Set(claimedSoItemIds);
  const restore = [];
  const refused = [];

  /* Candidates are consumed as they are matched: two orphan lines of the same
     SKU cannot both take the same SO line. Without this the "unique candidate"
     test passes twice over one row and the repair invents a double delivery. */
  const taken = new Set();

  for (const line of orphanLines) {
    const code = normCode(line.itemCode);
    const sameCode = soLines.filter((s) => normCode(s.itemCode) === code);

    if (sameCode.length === 0) {
      refused.push({ ...pick(line), reason: 'no_so_line_with_that_item_code' });
      continue;
    }

    /* QTY IS PART OF THE IDENTITY, not a sanity check bolted on after. A DO may
       legitimately ship a partial qty, so an unequal qty does NOT prove the
       lines are unrelated — it proves we cannot tell WHICH of several same-SKU
       lines this shipment served, and a partial shipment re-pointed at the
       wrong one silently moves qty between two customers' order lines. Equal
       qty is the evidence that makes the match forced; anything else is a
       human's call. */
    const exact = sameCode.filter((s) => Number(s.qty) === Number(line.qty));
    if (exact.length === 0) {
      refused.push({ ...pick(line), reason: 'no_so_line_with_matching_qty' });
      continue;
    }

    const free = exact.filter((s) => !claimed.has(s.id) && !taken.has(s.id));
    if (free.length === 0) {
      /* Every candidate is spoken for by another DO line. On 2026-08-17 this
         was exactly one row — 2990-SO-2606-030's pillow, ordered qty 1, already
         delivered by 2990-DO-2608-010 while 2990-DO-2607-013 carries a second
         orphaned line for the same pillow. Linking it would report 2 delivered
         against 1 ordered. That is a real business question (a re-delivery? a
         duplicate DO?), so it is handed back, not decided here. */
      refused.push({ ...pick(line), reason: 'all_candidate_so_lines_already_delivered' });
      continue;
    }
    if (free.length > 1) {
      refused.push({ ...pick(line), reason: 'ambiguous_multiple_candidate_so_lines' });
      continue;
    }

    taken.add(free[0].id);
    restore.push({ doItemId: line.id, soItemId: free[0].id, itemCode: line.itemCode, qty: Number(line.qty) });
  }

  return { restore, refused };
}

const pick = (line) => ({ doItemId: line.id, itemCode: line.itemCode, qty: Number(line.qty) });
