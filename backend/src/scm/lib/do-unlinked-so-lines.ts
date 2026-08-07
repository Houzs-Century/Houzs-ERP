// ----------------------------------------------------------------------------
// do-unlinked-so-lines — close the back door that let one Sales Order ship twice.
//
// WHAT WENT WRONG. 2990-DO-2607-005 and 2990-DO-2607-017 both name
// 2990-SO-2606-019 on their header, both are DISPATCHED, and both moved the same
// six items. The stock ledger shows the pillow leaving twice: -2 on 13/07 under
// DO-005, -2 on 23/07 under DO-017. Owner, 2026-08-04, pointing at the screen
// after a link-based check had told him there was only one DO: "你在说瞎话吗？
// 昨天明明两个 DO 都是送了一次，明明已经 duplicated 了啊".
//
// WHY NOTHING STOPPED IT. DO-005's six lines carry no so_item_id. An unlinked
// line is a full citizen of the stock ledger — deductInventoryForDo reads the
// DO's OWN lines, so the goods leave — but it belongs to no Sales Order line, so
// soDeliverableRemaining cannot count it and the over-delivery guard cannot see
// it. The create path says as much in its own comment: "Ad-hoc lines (no
// soItemId) are uncapped."
//
// Uncapped was the intent, and for a genuinely ad-hoc delivery it is right: a
// replacement part, a sample, a goodwill item. What was never intended is using
// it to ship the SAME goods a Sales Order already ordered, WITHOUT consuming
// that order's quantity — which is exactly what typing an SO number into the
// header and adding the lines by hand does. `so_doc_no` is free text; nothing
// required the lines beneath it to point at the order it names.
//
// THE RULE, and why it is drawn here rather than "every line must link".
// An unlinked line is refused only when the named SO ALREADY ORDERS THAT ITEM.
//
//   header names no SO           -> nothing to bypass, allowed (unchanged)
//   item is NOT on the named SO  -> genuinely ad-hoc, allowed (unchanged)
//   item IS on the named SO      -> REFUSED: link it, and consume the quantity
//
// A blanket "every line must link" would break the legitimate case of adding
// something to a delivery that the order never contained. This rule blocks only
// the bypass: you may still deliver anything you like, but you may not deliver
// what the order asked for while pretending the order did not ask for it.
//
// The comparison is on item_code alone, deliberately. A variant mismatch would
// let the same product slip through on a whitespace or option difference, and
// the operator's answer in every real case is the same — pick the line from the
// order instead of typing it in.
// ----------------------------------------------------------------------------

export type UnlinkedCandidate = {
  /** Caller's handle for the line (array index, row id — whatever it can map back). */
  lineRef: string;
  itemCode: string;
  qty: number;
  /** null / '' = not linked to a Sales Order line. */
  soItemId: string | null;
};

export type UnlinkedOffender = {
  lineRef: string;
  itemCode: string;
  qty: number;
  /** The SO this DO's header names, which already orders this item. */
  soDocNo: string;
};

/** item_code comparison key. Trimmed + upper-cased so a stray space or a
 *  lower-case paste does not read as a different product. */
const codeKey = (v: string | null | undefined): string => String(v ?? '').trim().toUpperCase();

/**
 * PURE. Which posted lines are unlinked while the named SO already orders that
 * item?
 *
 * `soItemCodes` is every item_code on the named Sales Order (non-cancelled
 * lines). Empty means the SO has no lines we could match — no offenders, so a
 * mistyped or foreign SO number never blocks a delivery.
 */
export function findUnlinkedSoItemLines(
  soDocNo: string | null | undefined,
  lines: UnlinkedCandidate[],
  soItemCodes: Iterable<string>,
): UnlinkedOffender[] {
  const doc = String(soDocNo ?? '').trim();
  if (!doc) return [];

  const ordered = new Set<string>();
  for (const c of soItemCodes) {
    const k = codeKey(c);
    if (k) ordered.add(k);
  }
  if (ordered.size === 0) return [];

  const out: UnlinkedOffender[] = [];
  for (const l of lines) {
    if (l.soItemId) continue;                 // linked — the ceiling already sees it
    const k = codeKey(l.itemCode);
    if (!k || !ordered.has(k)) continue;      // not on this order — genuinely ad-hoc
    out.push({ lineRef: l.lineRef, itemCode: l.itemCode, qty: Number(l.qty ?? 0), soDocNo: doc });
  }
  return out;
}

/** Every item_code the named Sales Order orders, cancelled lines excluded (they
 *  order nothing, so shipping against them is not a bypass of anything). */
export async function soItemCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soDocNo: string | null | undefined,
): Promise<Set<string>> {
  const doc = String(soDocNo ?? '').trim();
  if (!doc) return new Set();
  const { data } = await sb
    .from('mfg_sales_order_items')
    .select('item_code, cancelled')
    .eq('doc_no', doc);
  const rows = (data ?? []) as Array<{ item_code: string | null; cancelled?: boolean | null }>;
  const out = new Set<string>();
  for (const r of rows) {
    if (r.cancelled === true) continue;
    const k = codeKey(r.item_code);
    if (k) out.add(k);
  }
  return out;
}

/** Convenience: load the SO's item codes and apply the rule in one call. */
export async function findUnlinkedSoLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soDocNo: string | null | undefined,
  lines: UnlinkedCandidate[],
): Promise<UnlinkedOffender[]> {
  if (!String(soDocNo ?? '').trim()) return [];
  if (!lines.some((l) => !l.soItemId)) return [];   // nothing unlinked — skip the read
  return findUnlinkedSoItemLines(soDocNo, lines, await soItemCodesOf(sb, soDocNo));
}

/** The 409 body. Names the offending lines so the UI can point at the rows
 *  rather than making the operator hunt for which one is wrong. */
export function unlinkedSoLinesResponse(offenders: UnlinkedOffender[]) {
  const doc = offenders[0]?.soDocNo ?? '';
  const list = [...new Set(offenders.map((o) => o.itemCode))].join(', ');
  return {
    error: 'unlinked_so_lines',
    message:
      `This delivery names Sales Order ${doc}, but ${offenders.length} line(s) are not linked to it: ${list}. ` +
      `Pick those items from the Sales Order instead of adding them by hand — an unlinked line still ships the ` +
      `goods but takes no quantity off the order, so the same items can be delivered again on a second DO.`,
    soDocNo: doc,
    offenders,
  };
}

/** Exported for the GRN side's mirror of this rule, so both sides share one
 *  definition of "the same item". */
export { codeKey as itemCodeKey };
