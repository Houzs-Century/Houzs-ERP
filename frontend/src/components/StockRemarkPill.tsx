// ----------------------------------------------------------------------------
// StockRemarkPill — the ONE renderer for a Sales Order's `stock_remark`.
//
// The value is the owner's own vocabulary (2026-08-16), produced in exactly one
// place on the server (scm/lib/so-readiness.ts):
//
//   ''                            no live lines — nothing to say
//   'READY'                       everything that must be allocated IS
//   'SHORT: MATTRESS'             the named categories are not all allocated
//   'SHORT: BEDFRAME, ACCESSORY'  main categories first, ACCESSORY last
//
// WHY A COMPONENT AND NOT THREE COLUMN DEFS. Until 2026-08-17 the same string
// was rendered three different ways. ConsignmentOrders.tsx had a designed pill —
// mint for READY, the app's amber WARNING pair for SHORT — with a semantic sort
// and a real export value. MfgSalesOrdersListV2.tsx, which is the column the
// owner actually has on screen (the 2990 layout preset switches it on), printed
// `<span className="text-[12.5px] text-ink-secondary">` — grey body text, no
// colour, no sort. So the system told him a mattress was short and it looked
// like an incidental note, which is why he reported it as "the system wrote the
// words short mattress" rather than as a warning appearing.
// DeliveryPlanningBoard.tsx had a third pair of hard-coded hexes.
//
// This is the same class that produced the 'READY (PARTIAL)' leak the day
// before: the readiness rollup was corrected and delivery-planning.ts kept
// emitting the retired string from its own inline copy, so one screen showed
// the corrected label and the retired one at the same moment. One rule, one
// expression.
//
// The palette is ConsignmentOrders' verbatim — the design of record. The amber
// is deliberate and is the app's intentional warning slot, NOT a 2990 brand
// remnant (the interactive burnt-orange accents elsewhere were swept to
// primary). Do not invent a second one here.
// ----------------------------------------------------------------------------

const isReady = (remark: string) => remark === "READY";
const isShort = (remark: string) => remark.startsWith("SHORT:");

/** The pill. A blank remark renders an em dash, never an empty cell — "this SO
 *  has no lines" is an answer and it should look like one. */
export function StockRemarkPill({ remark }: { remark: string | null | undefined }) {
  const value = (remark ?? "").trim();
  if (!value) return <span style={{ color: "var(--fg-muted)" }}>—</span>;
  const ready = isReady(value);
  const short = isShort(value);
  return (
    <span
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "var(--fs-11)",
        fontWeight: ready || short ? 700 : 600,
        background: ready ? "var(--c-mint, #d4edda)" : short ? "rgba(232, 107, 58, 0.15)" : "var(--c-cream)",
        color: ready ? "var(--c-green, #1a7a3a)" : short ? "#b0592f" : "var(--c-ink)",
        padding: "2px 10px",
        borderRadius: "var(--radius-pill, 999px)",
        letterSpacing: 0.5,
        border: ready || short ? "none" : "1px solid var(--line)",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </span>
  );
}

/** Sort rank. READY first, then the SHORT labels, then blank. Within SHORT a
 *  longer remark (more categories missing) sorts after a shorter one, so "one
 *  thing away" floats above "waiting on everything".
 *
 *  Alphabetical order over this vocabulary would put `SHORT: ACCESSORY` above
 *  `SHORT: BEDFRAME` — an accessory the customer barely notices ranked over a
 *  missing bed — which is why the rank is not just the string. */
export function stockRemarkSortScore(remark: string | null | undefined): number {
  const value = (remark ?? "").trim();
  if (isReady(value)) return 3000;
  if (!value) return 0;
  return 1000 - value.length;
}

/** Descending by rank: the comparator both grids use. */
export function stockRemarkSortFn(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return stockRemarkSortScore(b) - stockRemarkSortScore(a);
}

/** Lowercased for the search box. Export keeps the REAL remark — see the
 *  callers; a lowercased CSV column would be a second vocabulary again. */
export function stockRemarkSearchValue(remark: string | null | undefined): string {
  return (remark ?? "").toLowerCase();
}

export function stockRemarkExportValue(remark: string | null | undefined): string {
  return (remark ?? "").trim();
}
