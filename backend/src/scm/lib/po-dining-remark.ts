/* ----------------------------------------------------------------------------
   po-dining-remark — a DINING order's remarks reach the SUPPLIER on its PO.

   Owner 2026-11-10 ("2990 - for dining remark 需要带进 PO remark - 给 Supplier
   mention"): when an SO is converted to a PO, a DINING line must carry
     · the SO header NOTE  -> the PO header "Remarks:" block, and
     · the line's own `remark` -> that PO line's "Remark:".
   Scope is DINING category only, BOTH companies.

   Lives in its own module because `mfg-purchase-orders.ts` sits at its file-size
   ceiling (scripts/file-size-ceilings.json, may only fall) — the repo's rule for
   that is a new module, not a bigger number. `convertSosToPosCore` is the only
   caller; the rule is unit-tested here (po-dining-remark.test.ts) rather than
   only through the convert's fake-PostgREST harness.

   `item_group` is the RAW SO-line group, matching the sofa test in the convert's
   grouping loop — a dining SKU is catalogued DINING, so the SO line carries it.
   -------------------------------------------------------------------------- */

/** DINING is the only category whose PO carries the order's remarks. */
export const isDiningGroup = (g: string | null | undefined): boolean =>
  (g ?? '').trim().toLowerCase() === 'dining';

/** The PO line's own remark: the SO line's `remark`, DINING lines only. Null
 *  otherwise (every non-dining line, or a dining line with a blank remark). */
export const diningLineNote = (
  itemGroup: string | null | undefined,
  remark: string | null | undefined,
): string | null => (isDiningGroup(itemGroup) ? (remark ?? '').trim() || null : null);

/** One converted line, as far as the header-note rule needs to read it. */
export interface DiningRemarkLine {
  itemGroup: string | null;
  soDocNo: string | null;
  /** The source SO's header NOTE (`mfg_sales_orders.note`). */
  soNote: string | null;
}

/**
 * The PO HEADER notes for one bucket: the `provenance` line kept FIRST (the
 * stored contract — `parseProvenanceNote` reads line 1 and its readers stay
 * byte-identical), with each DINING source order's header NOTE appended below.
 *
 * One note per source SO, deduped in line order; labelled with the SO number
 * only when the PO draws from more than one order (`sourceSoCount > 1`), so a
 * single-order PO reads the note plainly. No dining note -> the bare provenance.
 */
export function diningPoHeaderNotes(
  provenance: string,
  lines: readonly DiningRemarkLine[],
  sourceSoCount: number,
): string {
  const bySo = new Map<string, string>();
  for (const l of lines) {
    if (!isDiningGroup(l.itemGroup)) continue;
    const n = (l.soNote ?? '').trim();
    if (n && l.soDocNo) bySo.set(l.soDocNo, n);
  }
  if (bySo.size === 0) return provenance;
  const label = sourceSoCount > 1;
  return `${provenance}\n${[...bySo.entries()]
    .map(([doc, n]) => (label ? `${doc}: ${n}` : n))
    .join('\n')}`;
}
