// ---------------------------------------------------------------------------
// ac-source-hop — WHICH DOCUMENT THE BOOK RAISED A LINE FROM, and which of
// those documents we actually hold.
//
// WHY THIS IS A MODULE AND NOT TWO CLOSURES IN THE RECONCILE. It was both, for
// one afternoon, and the file-size gate refused it at 2,064 lines against a cap
// of 2,000 — correctly: the gate's own advice is "move the new code into its own
// module", and this code is not about reconciling anything. It answers one
// question about the ACCOUNT BOOK's shape, `lib/ac-not-a-difference.mjs` decides
// what the answer means, and neither should have to be read to change the other.
//
// The move also bought the thing that was missing: the hop is a RULE about the
// book's edges, and while it lived inline it had no test of its own. The only
// evidence it worked was a production run's summary line.
//
// NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
// Windows vitest reason).
// ---------------------------------------------------------------------------

/**
 * The source documents of one type the ERP ACTUALLY holds.
 *
 * READ off the ERP rows, never off `SCOPE`. `SCOPE` states the population the
 * migration was DEFINED to carry; this must state the one it did, or a gap gets
 * read out as a decision — `docs/bugs/0668`, 30 documents.
 *
 * Returns null where the type has no rows at all, so the caller refuses rather
 * than reading an unread table as an empty one. An unproven decision is not a
 * decision.
 *
 * @param {Record<string,{docs?:{ac_no?:string}[]}>} erp
 * @param {string} sourceType
 * @returns {Set<string>|null}
 */
export function sourceCoverage(erp, sourceType) {
  const rows = erp?.[sourceType]?.docs;
  if (!Array.isArray(rows) || !rows.length) return null;
  const held = new Set();
  for (const d of rows) if (d.ac_no) held.add(String(d.ac_no).trim());
  return held.size ? held : null;
}

/**
 * Which documents the book raised one LINE from — as a LIST, because the answer
 * is not always one document.
 *
 * `PIDTL.FromDocType` is `GR` on every purchase-invoice line in the committed
 * cut, so the purchase ORDER is one hop further up and is found by matching the
 * invoice line's item against the receipt's own lines. Measured on that cut over
 * the 1,349 lines of the 189 in-scope invoices: 827 resolve to exactly one
 * order, 493 to MORE than one because the receipt took that item against
 * several, 25 to a receipt naming no order for that item, and 4 to no source at
 * all.
 *
 * Collapsing the 493 to one would be the checker inventing a correspondence,
 * which is what `docs/bugs/0690` was paid for — two identical bedframes, two
 * receipts, paired backwards. So every candidate is returned and the RULE
 * requires all of them to hold.
 *
 * An unresolvable line returns `[]`, which every caller must read as "unproven",
 * never as "no source, therefore nothing to hold".
 *
 * @param {Record<string,{byDtlKey?:Map<string,object>,lines?:Map<string,object[]>}>} book
 * @param {string} type  the CHILD type whose line is being asked about
 * @returns {(bookDocNo:string,bookDtlKey:string)=>{type:string,docNo:string}[]}
 */
export function bookSourceOf(book, type) {
  return (_bookDocNo, bookDtlKey) => {
    const line = book?.[type]?.byDtlKey?.get(bookDtlKey);
    if (!line) return [];
    const ft = String(line.fromDocType ?? "").trim().toUpperCase();
    const fd = String(line.fromDocNo ?? "").trim();
    if (!ft || !fd) return [];
    /* The book names the source document itself. No hop, nothing to guess. */
    if (ft !== "GR") return [{ type: ft, docNo: fd }];
    const receiptLines = book?.GR?.lines?.get(fd);
    /* The receipt is not in the snapshot: unresolved, and unresolved never
       moves. Reading it as "no purchase order" would be the opposite answer. */
    if (!receiptLines) return [];
    const orders = new Set();
    for (const g of receiptLines) {
      if (g.itemKey !== line.itemKey) continue;
      if (String(g.fromDocType ?? "").trim().toUpperCase() !== "PO") continue;
      const po = String(g.fromDocNo ?? "").trim();
      if (po) orders.add(po);
    }
    return [...orders].map((docNo) => ({ type: "PO", docNo }));
  };
}
