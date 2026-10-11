// ----------------------------------------------------------------------------
// costing-enabled — the ONE switch for Houzs cost/margin display.
//
// ON. Owner 2026-07-17: "margin 給2990開啊 houzs的也是啊 是看什麽position 的".
// WHO sees it is the position gate (canViewScmCosting -> project_finance_viewer
// -> Super Admin / Sales Director / Finance Manager / Owner). This switch is
// only WHETHER the surface exists at all, and it now does — for both companies.
//
// ─── Read this before trusting a number it renders ──────────────────────────
//
// This was OFF from 2026-07-16 (#649) to 2026-07-17, and the reason has NOT
// gone away — the owner was shown it twice and decided anyway, which is his
// call to make. Recorded so nobody re-derives it as a "bug":
//
//   company 2 (2990) — real costs. The SKU master carried cost_price_sen
//     through the import, so its margins are true (a live order: cost RM 2,079
//     on RM 3,445, 39.6%). This is the half the owner asked for.
//
//   company 1 (HOUZS) — the catalog was seeded WITHOUT prices (owner
//     2026-06-22: "不需要價格先"), so cost_price_sen is empty across ~1326 SKUs:
//       cost_price_sen empty
//         -> snapshotUnitCostSen falls through to 0 on every SO line
//         -> total_cost_centi = 0
//         -> margin_pct_basis = round((margin/total) * 10000) = 10000
//         -> "100.0% margin", in GREEN, on every order.
//     #649's evidence: prod SO-2607-018, a real RM 3,888 mattress order.
//     Until HOUZS costs are seeded, treat a 100% figure as "not recorded",
//     never as profit. Seeding the catalog is what makes this honest; nothing
//     in the code will.
//
// Deliberately still a build-time constant, not a data-derived check ("does any
// product have a cost?"). A derived check flips on the FIRST seeded SKU while
// the rest are empty — same lie, intermittent and harder to see. If the 100%
// becomes a problem before HOUZS is costed, the fix is per-DOCUMENT (hide the
// margin when a product category has revenue but zero cost — the header already
// carries mattress_sofa_cost_centi/bedframe_cost_centi/... alongside their
// revenue twins, and service_cost_centi is separate because a service line
// legitimately has none), NOT a global flag and NOT a company gate.
// ----------------------------------------------------------------------------

/** Whether cost / margin may be DISPLAYED anywhere in the Houzs document UI.
 *  ON since 2026-07-17 — see the header for what a HOUZS 100% still means.
 *
 *  NO LONGER THE AUTHORITATIVE switch (fix/cost-display-backend-gate). The
 *  BACKEND now carries a twin — the env var COSTING_DISPLAY_ENABLED (backend
 *  scm/lib/costing-enabled) — which IS authoritative: when it is off the server
 *  strips cost/margin from every SCM sales-document response (canViewScmFinance)
 *  AND drops the scm.finance.view capability, so canViewScmCosting already
 *  returns false and the columns vanish. It used to be that "the server computed
 *  and stored cost/margin regardless" and this const only blanked the FE column
 *  — that was the two-rule split. This const now stays as a build-time
 *  defence-in-depth term ANDed on top (canViewScmCosting): it can only ever hide
 *  MORE, never re-show cost the server withheld. To actually withhold cost, flip
 *  the BACKEND var; flipping this alone only blanks the FE column.
 *
 *  The position gate (scm.finance.view capability, backend isFinanceViewer)
 *  applies independently on top: BOTH the switch and the position must pass, so a
 *  salesperson sees nothing either way. */
// Typed `boolean`, NOT left to infer a literal. With a literal type every
// `COSTING_DISPLAY_ENABLED && x` narrows away, and the strict `tsc -b` the CI
// runs can then flag the gated branches as unreachable — the annotation keeps
// this a value, not a type.
export const COSTING_DISPLAY_ENABLED: boolean = true;
