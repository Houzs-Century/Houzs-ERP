/* Turn AutoCount's GrQty into a per-line received quantity.
 *
 * GrQty is NOT per line. It is a per-(DocNo, ItemCode) received ROLLUP that the
 * extract stamps identically onto every detail line of the group. Reading it as
 * a per-line receipt is what put 65 production PO lines over their ordered qty
 * (73 excess units): every line of a repeated item claimed the whole group's
 * receipt. PO-009018 is the canonical shape — two lines, Qty 1 each, GrQty 2
 * each: ordered 2, received 2, but both lines claiming 2.
 *
 * The rule here pours the group's receipt across its lines in order, each line
 * taking at most its own qty. Two properties matter, and both are asserted in
 * backend/tests/apportionReceived.test.ts against the committed snapshot:
 *
 *   · NO line ever exceeds its own ordered qty          (the ceiling)
 *   · the group's TOTAL is preserved exactly            (no invented units)
 *
 * A blanket min(GrQty, qty) clamp satisfies the first and FAILS the second: on
 * PO-009620 HOK-1052 (Q) — GrQty 1 across two Qty-1 lines — the clamp records 2
 * received where AutoCount received 1, inventing a unit and flipping the PO to
 * fully-received while a real unit is still outstanding.
 */

/**
 * @param {Array<{ DtlKey: string|number, ItemCode: string, Qty: number|string, GrQty: number|string }>} lines
 *   All detail lines of ONE AutoCount purchase order.
 * @param {(msg: string) => void} [warn] Called if the rollup assumption breaks.
 * @returns {Map<string, number>} DtlKey (as string) -> received qty for that line.
 */
export function apportionReceived(lines, warn) {
  const byItem = new Map();
  for (const l of lines) {
    const k = String(l.ItemCode ?? '').trim().toUpperCase();
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(l);
  }

  const out = new Map();
  for (const [code, grp] of byItem) {
    const seen = [...new Set(grp.map((l) => Math.round(Number(l.GrQty ?? 0))))];
    /* If the extract ever stops replicating the rollup, the shape this
       apportionment assumes is gone — say so rather than silently mis-splitting.
       Taking the largest keeps the total conservative meanwhile. */
    if (seen.length > 1 && warn) {
      warn(`${code}: GrQty differs across the group (${seen.join('/')}) — the rollup assumption may no longer hold; apportioning the largest`);
    }
    let rem = Math.max(0, ...seen);
    for (const l of grp) {
      const q = Math.round(Number(l.Qty ?? 0));
      const take = Math.max(0, Math.min(rem, q));
      out.set(String(l.DtlKey), take);
      rem -= take;
    }
  }
  return out;
}
