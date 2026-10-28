// ----------------------------------------------------------------------------
// costing-enabled — THE backend-authoritative switch for cost/margin DISPLAY.
//
// The frontend has carried a build-time `COSTING_DISPLAY_ENABLED` const
// (frontend/src/vendor/shared/costing-enabled.ts) since #649. That const only
// ever hid the FE column: `canViewScmCosting = COSTING_DISPLAY_ENABLED &&
// scm.finance.view`. The BACKEND gate `canViewScmFinance` had NO matching term,
// so the wire kept SHIPPING cost/margin to every finance-viewer regardless — a
// two-rule split (FE `switch && position`, BE `position` only). Owner ruled the
// switch must TRULY withhold cost, not just blank a column.
//
// This is the missing backend half, and it is now the AUTHORITATIVE switch:
//   • canViewScmFinance (scm/lib/houzs-perms) ANDs it in — OFF strips cost/margin
//     from EVERY sales-document response, for EVERYONE, because that gate is the
//     single chokepoint the ~9 SCM sales routes call to decide whether to emit
//     the SO_FINANCE_KEYS / SO_ITEM_FINANCE_KEYS vocabulary.
//   • resolveCapabilities (services/capabilities) drops scm.finance.view when it
//     is OFF, so the FE's canViewScmCosting (which reads that capability) hides
//     the columns/nav without a rebuild — the same switch on both sides of the
//     wire, so they can no longer disagree.
//
// It is DELIBERATELY not the product-cost path. canViewScmProductCost
// (cost_price_sen — the SKU master) stays OFF this switch, exactly as the FE's
// canViewProductCost does: cost ENTRY must not ride a switch whose whole purpose
// is to hide cost DISPLAY, or flipping it OFF would strand the very column an
// admin needs to flip it back on (see frontend salesAccess.canViewProductCost).
//
// Read from an env var (config, mirroring AUTOCOUNT_SYNC_DISABLED) rather than a
// build-time const so it is flippable in wrangler.toml without a code edit —
// same redeploy either way, but the toggle lives in config next to the sync
// kill switch. DEFAULTS ON: an absent / non-"false" value keeps the current prod
// behaviour, so a missing var can never silently hide cost (no regression). Only
// the exact string "false" (case/space-insensitive) turns it off.
// ----------------------------------------------------------------------------

/** The env shape this reads — just the one string var. Structurally satisfied by
 *  the full worker `Env` (COSTING_DISPLAY_ENABLED?: string) and by a test literal.
 *  A null/undefined env resolves to ON, the no-regression default. */
export interface CostingDisplayEnv {
  COSTING_DISPLAY_ENABLED?: string;
}

/** Whether SCM sales-document cost/margin may be DISPLAYED at all. ON unless the
 *  var is explicitly "false" — see this file's header for why the default is ON
 *  and why the product-cost path is deliberately excluded. */
export function isCostingDisplayEnabled(env: CostingDisplayEnv | null | undefined): boolean {
  const raw = env?.COSTING_DISPLAY_ENABLED;
  if (raw == null) return true; // absent = ON (no-regression default)
  return raw.trim().toLowerCase() !== "false";
}
