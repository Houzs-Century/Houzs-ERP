// ----------------------------------------------------------------------------
// stock-take-grouping — the PURE fold behind the count sheet's model view
// (phase 1, owner-approved 2026-08-08).
//
// Variant-heavy categories (sofa / bedframe) put one LINE per (item_code,
// variant_key) on the sheet, so one model easily owns a dozen rows. The model
// view collapses those to one header row per MODEL — which, on this sheet, IS
// the item_code: migration 0035/0183 made the count variant-grained UNDER a
// single code, so "CODY · 12 lines · system 3" is exactly the code's bucket
// list. Expanding shows the variant lines; "all zero" fills the group.
//
// Pure and framework-free so the fold is testable beside itself (the same
// posture as backend/src/scm/shared/*): the page hands it draft rows, it hands
// back ordered groups. It never touches React state.
// ----------------------------------------------------------------------------

export type GroupableLine = {
  id: string;
  itemCode: string;
  productName: string | null;
  /* null while a blind take hides the figure from this viewer. */
  systemQty: number | null;
  /* '' = uncounted (the sheet's draft convention). */
  countedQtyInput: string;
};

export type ModelGroup<T extends GroupableLine> = {
  /* The grouping key — the product code (the model). */
  itemCode: string;
  productName: string | null;
  lines: T[];
  /* Sum of system qty across the group; null when ANY line hides it (blind) —
     a partial sum would leak the very number the blind flag withholds. */
  systemTotal: number | null;
  /* Sum of the counted entries typed so far (uncounted lines contribute 0). */
  countedTotal: number;
  countedLines: number;
};

const parseCounted = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Math.max(0, Math.floor(Number(s)));
  return Number.isFinite(n) ? n : null;
};

/**
 * Fold draft lines into model groups, preserving the incoming line order and
 * first-seen group order (the sheet is already sorted code-then-variant, so
 * groups arrive alphabetically without re-sorting here).
 */
export function groupByModel<T extends GroupableLine>(lines: readonly T[]): ModelGroup<T>[] {
  const byCode = new Map<string, ModelGroup<T>>();
  const out: ModelGroup<T>[] = [];
  for (const l of lines) {
    let g = byCode.get(l.itemCode);
    if (!g) {
      g = {
        itemCode: l.itemCode,
        productName: l.productName,
        lines: [],
        systemTotal: 0,
        countedTotal: 0,
        countedLines: 0,
      };
      byCode.set(l.itemCode, g);
      out.push(g);
    }
    g.lines.push(l);
    if (g.productName == null && l.productName != null) g.productName = l.productName;
    if (l.systemQty == null) g.systemTotal = null;
    else if (g.systemTotal != null) g.systemTotal += l.systemQty;
    const counted = parseCounted(l.countedQtyInput);
    if (counted != null) {
      g.countedTotal += counted;
      g.countedLines += 1;
    }
  }
  return out;
}
