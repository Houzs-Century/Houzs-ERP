// Hand out the ERP sales-order line that a migrated purchase-order line
// dedicates to — ONE implementation, shared by every writer.
//
// Extracted from import-ac-so-linked-pos.mjs, where it was the only correct
// copy. import-ac-outstanding-po.mjs had no copy at all: its INSERT column list
// simply had no so_item_id, so 267 documents came in undedicated and the
// SO-linked import then skipped those documents whole as "already in ERP", so
// nothing ever went back for them. A rule that lives in one script and is
// merely IMPLIED in the other is the class BUG-HISTORY.md already names —
// copy the FILE, not the lines.
//
// THE RULE, and the only one: a sales-order line may be claimed ONCE. Two PO
// lines for the same SKU on one order bind to two DIFFERENT SO lines rather
// than both claiming the first; a line some other purchase order already
// dedicated is never handed out again.

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * @param soItems  ERP sales-order lines: { id, item_code, ac } where `ac` is
 *                 the AutoCount SO DocNo the order was imported from. Pass them
 *                 in line order — that is the order they are handed out in.
 * @param taken    so_item_ids already claimed by SOME purchase-order line.
 *                 Mutated as lines are handed out, so one taker can be shared
 *                 across a whole run and never double-claim.
 */
export function makeSoLineTaker(soItems, taken = new Set()) {
  const byKey = new Map();
  for (const it of soItems ?? []) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  const handedOut = new Map();

  /** The next free SO line for (AutoCount SO DocNo, ERP item code), or null. */
  const take = (acSoDoc, erpCode) => {
    if (!acSoDoc || !erpCode) return null;
    const k = `${acSoDoc}|${norm(erpCode)}`;
    const cands = byKey.get(k);
    if (!cands) return null;
    const used = handedOut.get(k) ?? 0;
    const pick = cands.find((c, i) => i >= used && !taken.has(c.id));
    if (!pick) return null;
    handedOut.set(k, cands.indexOf(pick) + 1);
    taken.add(pick.id);
    return pick.id;
  };

  /** Why a take() failed, for the report. Never guesses a replacement. */
  const explain = (acSoDoc, erpCode) => {
    if (!acSoDoc) return "no AutoCount sales order behind this PO line";
    if (!erpCode) return "PO line carries no item code";
    const k = `${acSoDoc}|${norm(erpCode)}`;
    const cands = byKey.get(k);
    if (!cands) return `${acSoDoc} has no ERP line with code ${erpCode}`;
    return `every ${erpCode} line on ${acSoDoc} is already dedicated (${cands.length} line(s))`;
  };

  return { take, explain, taken, size: byKey.size };
}
