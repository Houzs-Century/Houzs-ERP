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
 * Which ERP item codes a migrated purchase-order line may claim on the sales
 * order AutoCount says it came from — and whether the sales-order line names a
 * DIFFERENT product than the purchase-order line does.
 *
 * The order matters, and so does what is NOT in it. `soBase` — the ERP code of
 * the SALES ORDER line's AutoCount ItemCode — used to be a blanket third
 * attempt, defended by a comment claiming it was "the same derivation, so the
 * link lands on the same line the importer would have chosen". That was wrong
 * twice over: import-ac-so-linked-pos.mjs uses ONLY soBase and never the PO
 * row's own code, so the first attempt is one the importer never makes; and
 * FromSODtlKey can name a sales-order line for a different product entirely
 * (PO-000290's two keys resolve to "MYLATEX LUMBARIA (K)" and "NB-KHJ57(K)" on
 * the same order). Taking soBase blindly binds a PO line for product A to an SO
 * line for product B — a wrong link, which is worse than the blank it replaces.
 *
 * So soBase is offered only when it names the product this PO row already names
 * (or that row's sofa placeholder). Otherwise the row is left blank and the
 * caller reports it for the owner to adjudicate.
 *
 * @param poCode       the PO row's material_code (for a sofa, the compartment)
 * @param soBase       ERP code of the SO line's AutoCount ItemCode, "" if unmapped
 * @param placeholder  sofa placeholder derived from THIS PO line's own AutoCount
 *                     item (`<model>-1S`), or null — same product by construction
 * @returns { attempts, crossProduct }
 */
export function dedicationCandidates(poCode, soBase, placeholder) {
  const base = soBase || "";
  const sameProduct =
    !!base && (norm(base) === norm(poCode) || (!!placeholder && norm(base) === norm(placeholder)));
  const attempts = [...new Set(
    [poCode, sameProduct ? base : null, placeholder].filter(Boolean).map(String),
  )];
  return { attempts, crossProduct: !!base && !sameProduct };
}

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
  const knownDocs = new Set();
  for (const it of soItems ?? []) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
    knownDocs.add(it.ac);
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
    if (!knownDocs.has(acSoDoc)) return `AutoCount sales order ${acSoDoc} has no live line in the ERP (never imported, or every line cancelled)`;
    const k = `${acSoDoc}|${norm(erpCode)}`;
    const cands = byKey.get(k);
    if (!cands) return `${acSoDoc} is in the ERP but carries no line with code ${erpCode}`;
    return `every ${erpCode} line on ${acSoDoc} is already dedicated (${cands.length} line(s))`;
  };

  return { take, explain, taken, knownDocs, size: byKey.size };
}
