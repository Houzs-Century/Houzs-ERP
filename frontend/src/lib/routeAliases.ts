// ---------------------------------------------------------------------------
// routeAliases.ts — URL standardisation, step 1: make reasonable guesses work.
//
// Owner ruling (2026-07): "是的 整理過 整個讓系統更加standardise", with the
// non-negotiable condition that EVERY OLD PATH KEEPS WORKING. Staff have
// bookmarks, links are already pasted into chats and emails, and the PWA
// service worker caches by URL.
//
// ── WHY THIS SHIPS ALIASES AND RENAMES NOTHING ────────────────────────────
// The paths in this app are not merely addresses — several are IDENTIFIERS,
// and renaming one without renaming every mirror of it fails SILENTLY and,
// in two places, fails OPEN (a gated screen becomes visible to everyone):
//
//   · `frontend/src/mobile/MobileApp.tsx` resolves a mobile row's permission by
//     matching its full destination (including a declared query) in `NAV_TABS`.
//     Renaming only one side now fails CLOSED, but still silently removes the
//     row for its intended cohort unless the mirrors move together.
//   · `/scm/reports/fulfillment-costing` carries `requireFinanceViewer` on the
//     Sidebar entry ONLY; the mobile row has no gate of its own and borrows it
//     by path. Same for `/reports/fair-report` (`requireFairReport`) and
//     `/scm/delivery-returns` (`hideForSales`).
//   · `gateVia: "/scm/fleet"` IS the permission for the mobile Drivers and
//     Helpers screens.
//   · `mobileRoute.ts` `SO_RESERVED_SEGMENTS` contains the bare string
//     `"maintenance"` — it is the only thing stopping
//     `/scm/sales-orders/maintenance` being parsed as a document number.
//
// A rename touching any of those is a permission regression that nobody
// reports — the screen just quietly stops appearing, or quietly appears for
// everyone. So step 1 is purely ADDITIVE: no `to:` value changes, no gate key
// moves, no route is removed or renamed. The proposed renames are documented
// and sequenced for a later, dedicated PR.
//
// ── WHAT THIS FIXES TODAY ─────────────────────────────────────────────────
// The reported pain was a route 404-ing "purely because a /scm prefix was
// missing from a reasonable guess". These aliases make the guess RESOLVE
// instead of hitting the not-found page — the practical half of
// standardisation, with none of the identifier risk.
//
// ── SAFETY PROPERTY ───────────────────────────────────────────────────────
// Desktop renders `<Navigate replace>` to the canonical path; the mobile shell
// applies this same table before its own route + gate resolution. An alias
// grants NO access of its own: authorization is enforced entirely by the
// canonical destination, exactly as if the user had typed that URL. Desktop's
// `replace` keeps the alias out of session history so Back behaves.
//
// When the renames in step 2 land, entries here flip direction (the old path
// becomes the alias, the new one canonical) and this table is where that
// happens — one file, already covered by tests.
// ---------------------------------------------------------------------------

export interface RouteAlias {
  /** The guessable path that does not exist today. */
  from: string;
  /** The canonical path it should resolve to. */
  to: string;
}

/**
 * Guessable → canonical. Ordered by area for readability; order does not
 * affect matching (React Router ranks static segments deterministically).
 *
 * INVARIANT (asserted in routeAliases.test.ts): no `from` may collide with a
 * real route in App.tsx, or the alias would shadow a working page.
 */
export const ROUTE_ALIASES: readonly RouteAlias[] = [
  // ── Reports: the app has TWO report trees (`/reports/*` for cross-module
  // reports, `/scm/reports/*` for SCM document listings). That split is the
  // single most likely source of a wrong guess, so bridge it both ways.
  // NOTE: no `/reports/fulfillment-costing` alias — the Fulfillment Costing
  // module was removed in #846, so there is no destination to resolve to; a
  // guess at that path correctly reaches the not-found page.
  { from: "/scm/reports/fair-report", to: "/reports/fair-report" },
  { from: "/reports/sales-order-detail-listing", to: "/scm/reports/sales-order-detail-listing" },
  { from: "/reports/delivery-order-detail-listing", to: "/scm/reports/delivery-order-detail-listing" },
  { from: "/reports/sales-invoice-detail-listing", to: "/scm/reports/sales-invoice-detail-listing" },
  { from: "/reports/delivery-return-detail-listing", to: "/scm/reports/delivery-return-detail-listing" },

  // ── Sales documents: the bare name without the `/scm` prefix is the
  // natural guess, and every one of these 404s today.
  { from: "/sales-orders", to: "/scm/sales-orders" },
  { from: "/sales-orders/maintenance", to: "/scm/sales-orders/maintenance" },
  { from: "/delivery-orders", to: "/scm/delivery-orders" },
  { from: "/sales-invoices", to: "/scm/sales-invoices" },
  { from: "/delivery-returns", to: "/scm/delivery-returns" },
  { from: "/amendments", to: "/scm/amendments" },

  // ── Procurement.
  { from: "/purchase-orders", to: "/scm/purchase-orders" },
  { from: "/purchase-invoices", to: "/scm/purchase-invoices" },
  { from: "/purchase-returns", to: "/scm/purchase-returns" },
  { from: "/grns", to: "/scm/grns" },
  { from: "/suppliers", to: "/scm/suppliers" },
  { from: "/products", to: "/scm/products" },
  { from: "/mrp", to: "/scm/mrp" },

  // ── Warehouse.
  { from: "/warehouses", to: "/scm/warehouses" },
  { from: "/inventory", to: "/scm/inventory" },
  { from: "/stock-transfers", to: "/scm/stock-transfers" },
  { from: "/stock-takes", to: "/scm/stock-takes" },
  { from: "/stock-adjustments", to: "/scm/stock-adjustments" },

  // ── Finance.
  { from: "/accounting", to: "/scm/accounting" },
  { from: "/outstanding", to: "/scm/outstanding" },
  { from: "/payment-vouchers", to: "/scm/payment-vouchers" },

  // ── Transportation.
  { from: "/delivery-planning", to: "/scm/delivery-planning" },
  { from: "/trips", to: "/scm/trips" },
  { from: "/fleet", to: "/scm/fleet" },

  // ── Service cases: `/my-cases` sits at the top level while the rest of the
  // service module lives under `/assr`. Accept the grouped guess.
  { from: "/assr/my-cases", to: "/my-cases" },
  { from: "/scm/my-cases", to: "/my-cases" },
];

/** Lookup used by tests and by any caller that needs to resolve an alias. */
export function resolveAlias(path: string): string | null {
  const hit = ROUTE_ALIASES.find((a) => a.from === path);
  return hit ? hit.to : null;
}
