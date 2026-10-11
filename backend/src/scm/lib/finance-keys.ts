// ----------------------------------------------------------------------------
// finance-keys.ts — the Sales Order finance column vocabulary: the header and
// line keys that may reach ONLY a finance-viewer (lib/houzs-perms.
// canViewScmFinance, mirroring pmsAccess.isFinanceViewer).
//
// WHY THIS FILE EXISTS: the list used to be re-declared per route, and every
// copy drifted from the others. #574 (list columns), #600 (DO + SI detail),
// #625 (SO detail), #632 (DR detail) are four instances of ONE bug — "the strip
// was authored for one payload and the sibling never got it". /reports was the
// fifth and widest: it had no copy at all, so it shipped Cost / Margin /
// Margin% for every salesperson's every order, company-wide, to any Sales
// Executive. Keep ONE list, imported everywhere, so a newly-exposed finance
// column cannot be gated on some surfaces and silently open on others.
//
// Adding a column here gates it EVERYWHERE at once. If you add a cost/margin
// column to a SELECT, add its key here in the same PR.
// ----------------------------------------------------------------------------

/* Header-level: cost / margin / per-category revenue+cost subtotals + deposit.
   Order totals shown to EVERYONE who passes the access gate (local_total_centi
   / balance_centi / paid_centi / paid_total_centi / total_revenue_centi) are
   deliberately NOT listed here — that is the line #625 drew and this keeps. */
export const SO_FINANCE_KEYS = [
  'mattress_sofa_centi', 'bedframe_centi', 'accessories_centi', 'others_centi', 'service_centi',
  'mattress_sofa_cost_centi', 'bedframe_cost_centi', 'accessories_cost_centi', 'others_cost_centi', 'service_cost_centi',
  'total_cost_centi', 'total_margin_centi', 'margin_pct_basis', 'deposit_centi',
] as const;

/* Per-LINE cost/margin (the ITEM row carries unit_cost_centi / line_cost_centi
   / line_margin_centi). All snake_case — these routes emit PostgREST column
   names verbatim. A camelCase surface (e.g. `unitCostCenti`) would escape this
   list, so a route that camelCases its payload must strip in ITS vocabulary. */
export const SO_ITEM_FINANCE_KEYS = ['unit_cost_centi', 'line_cost_centi', 'line_margin_centi'] as const;

/* PRODUCT / SKU cost — the CATALOG vocabulary, not the document one above.
   mfg_products.cost_price_sen is not derived and is not an artifact: it is
   exactly what someone typed into the SKU master, and it is confidential.
   #669 made it director-only on BOTH screens (desktop ProductModelDetail,
   mobile MobileModuleList + MobileModuleDetail) and named the hole it left in
   its own commit message — "the wire still carries cost_price_sen to any
   products reader (mfg-products.ts has no finance strip)". This list is that
   ruling's payload half, and the gate is the same one the screens use:
   canViewScmProductCost ⇄ FE canViewProductCost, both the COST cohort
   (pmsAccess.isProductCostViewer: director + Purchasing, owner 2026-07-17).

   The gate here is canViewScmProductCost and NOT canViewScmFinance, and the
   difference is a shipped bug, not a preference. This docblock read "both
   project_finance_viewer" until 2026-07-17: true when written, false 26 minutes
   later. #699 moved the FE to the cost cohort; #673 added this strip on the
   director gate; each was correct against the main it branched from and neither
   could see the other. On the merged result Purchasing was told he could see
   cost by the screen and handed a payload with the key deleted. Cost is ONE
   question — ask it with ONE function on both sides, or the screen and the wire
   drift again. MARGIN is the other question and it keeps canViewScmFinance:
   SO_FINANCE_KEYS below, the /reports listing, and sales-analysis's
   customer-level margin are all still director-only.

   ONE key, and that is the point. master_price_history.field stores the COLUMN
   NAME verbatim ('cost_price_sen'), so this same list gates the live column AND
   its history row (stripProductPriceHistory below) — the "stripping the detail
   while leaving the history just moves the leak one endpoint over" shape that
   AUDIT_FINANCE_FIELDS had to be invented to name, closed here by construction
   instead of by a second list that can drift out of sync with this one.

   NOT listed, deliberately: base_price_sen / price1_sen. syncAnchorBindingFromProduct
   calls them a product's COST, so they read like they belong — but #669's
   approved screen prints base_price_sen to EVERY caller ("Price 2" on the Model
   Detail variants table, "Base Price" on the mobile card). Listing them here
   would blank a column the owner ruled visible.

   THE LIMIT, stated so the next reader re-checks rather than re-derives:
   seat_height_prices (JSONB) carries priceSen = COST per height (mfg-products.ts
   PATCH says so verbatim), and it rides the /mfg-products LIST select to every
   caller. It is NOT here because #669 did not rule on it and because the sofa
   pricing chain resolves a CHARGED price through the same cost fields
   (shared/sofa-build.ts: "else flat base_price_sen, else cost_price_sen") — add
   the key blind and a salesperson's build silently reprices. Trace that chain
   first, then add it here and gate it everywhere at once. */
export const PRODUCT_FINANCE_KEYS = ['cost_price_sen'] as const;

/** Drop the finance rows from a master_price_history payload. Non-finance rows
 *  stay — that a selling price changed, by whom, when, is not cost data. The
 *  row is dropped whole rather than blanked: an entry with old/new nulled still
 *  says a cost exists and that someone moved it. Caller decides WHETHER to run
 *  it (canViewScmFinance); this only does it. */
export function stripProductPriceHistory<T extends { field?: string }>(rows: readonly T[]): T[] {
  const finance: ReadonlySet<string> = new Set(PRODUCT_FINANCE_KEYS);
  return rows.filter((r) => !finance.has(String(r?.field ?? '')));
}

/* AUDIT-LOG vocabulary — the camelCase escape hatch warned about above, made
   concrete. The line PATCH records `cmp('unitCostCenti', prev.unit_cost_centi,
   unitCost)` into mfg_so_audit_log.field_changes, so the HISTORY carries the
   old AND new unit cost in plain sight — keyed by the API's camelCase names,
   which is precisely why it never matched the snake_case lists above. Stripping
   the detail while leaving the history just moves the leak one endpoint over.
   BOTH /mfg-sales-orders/:docNo/audit-log and /consignment-orders/:docNo/audit-log
   read this SAME table — gate them together or repeat the #600/#625/#632 shape. */
export const AUDIT_FINANCE_FIELDS: ReadonlySet<string> = new Set([
  'unitCostCenti', 'lineCostCenti', 'lineMarginCenti', 'depositCenti',
]);

/** Drop the finance entries from every row's `field_changes`, in place. The
 *  audit entry itself stays — who changed what, when, is not finance data.
 *  Caller decides WHETHER to run it (canViewScmFinance); this only does it. */
export function stripAuditFinance(entries: Array<Record<string, unknown>>): void {
  for (const e of entries) {
    const fc = e.field_changes;
    if (!Array.isArray(fc)) continue;
    e.field_changes = (fc as Array<{ field?: string }>).filter(
      (ch) => !AUDIT_FINANCE_FIELDS.has(String(ch?.field ?? '')),
    );
  }
}
