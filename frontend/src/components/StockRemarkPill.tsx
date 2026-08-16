// ----------------------------------------------------------------------------
// StockRemarkPill — the ONE renderer for a Sales Order's `stock_remark`.
//
// The value is the owner's vocabulary, produced in exactly one place on the
// server (scm/lib/so-readiness.ts). It names what IS ready (his evening ruling
// of 2026-08-16, confirmed against worked examples, restored by #2334 after
// #2295 had inverted it for a day):
//
//   ''                     nothing is ready yet, or the SO has no live lines
//   'READY'                everything that must be allocated IS
//   'PARTIAL'              every MAIN line is in, an accessory is not
//   'BEDFRAME'             the categories that ARE ready, '/'-joined
//   'MATTRESS/ACC'
//
// WHY A COMPONENT AND NOT THREE COLUMN DEFS. Until 2026-08-17 the same string
// was rendered three different ways. ConsignmentOrders.tsx had a designed pill —
// mint for READY, the app's amber WARNING pair for everything short of it.
// MfgSalesOrdersListV2.tsx, which is the column the owner actually has on screen
// (the 2990 layout preset switches it on), printed
// `<span className="text-[12.5px] text-ink-secondary">` — grey body text, no
// colour, no meaningful sort. DeliveryPlanningBoard.tsx had a third pair of
// hard-coded hexes keyed off a different field again.
//
// That is the same class as the `READY (PARTIAL)` leak: one rule expressed
// twice, corrected in one expression and left standing in the other. #2334 had
// to hand-carry a vocabulary change into ConsignmentOrders' private copy; with
// this module a fourth vocabulary change lands in one place.
//
// The palette and the ordering are ConsignmentOrders' verbatim — the design of
// record. Do not invent a second one here.
//
// NOTE THE NEGATIVE BRANCH, it is deliberate (#2334): everything that is not
// exactly 'READY' takes the WARNING colours. A vocabulary that grows a new token
// must not be able to fall through into a neutral slot and read as "fine".
// ----------------------------------------------------------------------------

/** The pill. A blank remark renders an em dash, never an empty cell — "nothing
 *  is ready yet" is an answer and it should look like one. */
export function StockRemarkPill({ remark }: { remark: string | null | undefined }) {
  const value = (remark ?? "").trim();
  if (!value) return <span style={{ color: "var(--fg-muted)" }}>—</span>;
  const full = value === "READY";
  return (
    <span
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "var(--fs-11)",
        fontWeight: 700,
        background: full ? "var(--c-mint, #d4edda)" : "rgba(232, 107, 58, 0.15)",
        color: full ? "var(--c-green, #1a7a3a)" : "#b0592f",
        padding: "2px 10px",
        borderRadius: "var(--radius-pill, 999px)",
        letterSpacing: 0.5,
        border: "none",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </span>
  );
}

/** Sort rank — by how much of the order is IN. READY first, then PARTIAL (every
 *  MAIN line in, one accessory away from shipping), then the category lists,
 *  then blank (nothing in). The label names what IS ready, so a LONGER list
 *  means MORE is ready and sorts higher. */
export function stockRemarkSortScore(remark: string | null | undefined): number {
  const value = (remark ?? "").trim();
  if (value === "READY") return 3000;
  if (value === "PARTIAL") return 2000;
  if (!value) return 0;
  return 1000 + value.length;
}

/** Descending by rank: the comparator every grid uses. */
export function stockRemarkSortFn(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return stockRemarkSortScore(b) - stockRemarkSortScore(a);
}

/** Lowercased for the search box. Export keeps the REAL remark — a lowercased
 *  CSV column would be a second vocabulary again. */
export function stockRemarkSearchValue(remark: string | null | undefined): string {
  return (remark ?? "").toLowerCase();
}

export function stockRemarkExportValue(remark: string | null | undefined): string {
  return (remark ?? "").trim();
}
