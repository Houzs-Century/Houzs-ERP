import type { QueryClient } from "@tanstack/react-query";

/* Several mobile screens still mutate via raw authedFetch + private ["mobile-*"]
 * query keys, so a DESKTOP tab reads a stale DO / board / inventory / SO list
 * after a mobile save / deliver / convert / status change. These helpers
 * invalidate the canonical shared roots (React Query prefix-match covers every
 * ?page/status/id variant), single-sourced here. Additive + generous:
 * invalidating a query that isn't mounted is a no-op.
 *
 * NOTE: MobileSODetail IS converged onto the vendored shared mutation hooks
 * (useUpdateMfgSalesOrderStatus / the amendment gates), so it does not need
 * these. MobileNewSO is NOT: its header PATCH, line diff, photo and payment
 * writes are raw authedFetch, so it calls invalidateSoShared at each save exit.
 *
 * Raw authedFetch is doubly invisible: it neither invalidates a shared key nor
 * trips the global MutationCache onSuccess in lib/queryClient.ts, which is what
 * broadcasts a write to OTHER TABS (lib/cross-tab-sync). A useMutation hook gets
 * both for free — prefer routing a write through the vendored hook over calling
 * these helpers when the hook's invalidation is complete. */

const bump = (qc: QueryClient, keys: string[]) => {
  for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
};

const SO_ROOTS = ["mfg-sales-orders", "mfg-sales-orders-paged", "mfg-sales-order-detail"];
const DO_ROOTS = ["mfg-delivery-orders", "mfg-delivery-orders-paged", "mfg-delivery-order-detail", "delivery-planning"];
const INVENTORY_ROOTS = ["inventory", "stock-transfers"];

export function invalidateSoShared(qc: QueryClient) {
  bump(qc, SO_ROOTS);
}

export function invalidateDoShared(qc: QueryClient) {
  bump(qc, DO_ROOTS);
}

export function invalidateInventoryShared(qc: QueryClient) {
  bump(qc, INVENTORY_ROOTS);
}

/* The three PRIVATE roots `MobileConvertWizard` reads its pickable lines under.
 *
 * They are the hazard this file's own header describes, pointed the other way.
 * The wizard invented them, nothing else knew them, and they were in nobody's
 * invalidation set — so a convert completed ANYWHERE (a desktop picker, another
 * mobile flow, or the wizard itself a moment earlier) left a mounted phone
 * wizard still offering lines that had already been consumed. Picking one gets
 * an `over_remaining` refusal at best; where the pool only partly shrank, a
 * wrong quantity goes through instead.
 *
 * Listed HERE rather than fixed with a fourth private key at the call site,
 * which is the mistake that produced the first three. Prefix-match covers every
 * target / source-id / poIds variant. */
const CONVERT_PICKER_ROOTS = ["convert-source", "convert-lines", "convert-grn-lines"];

/* A convert touches source + target doc lists (SO/DO/SI/PO/GRN) and, for a GRN,
 * inventory — invalidate the union so no desktop picker/list is left stale. */
export function invalidateConvertShared(qc: QueryClient) {
  invalidateSoShared(qc);
  invalidateDoShared(qc);
  invalidateInventoryShared(qc);
  /* Same `-paged` omission as MODULE_SHARED_ROOTS' PO entry had, in the second
     caller: SI and GRN list both roots here, PO listed only the bare one. Fixed
     in the same change so the two callers cannot disagree about which PO keys a
     write touches. */
  bump(qc, ["sales-invoices", "sales-invoices-paged", "mfg-purchase-orders", "mfg-purchase-orders-paged", "grns", "grns-paged"]);
  bump(qc, CONVERT_PICKER_ROOTS);
}

/* Roots for a module whose actions write inventory_movements. Every stock-moving
 * backend route also re-walks SO stock allocation (recomputeSoStockAllocation),
 * which flips SO line READY/PENDING — so posting a GRN changes SO list rows that
 * never mention the GRN, and the SO roots have to ride along. Not INVENTORY_ROOTS:
 * none of these documents touch a stock-transfer row. */
const STOCK_ROOTS = ["inventory", ...SO_ROOTS];

/* The shared roots each generic module screen's status/payment writes touch,
 * keyed by the MODULE_CONFIGS / statusActionsFor key. Only the SCM DOCUMENT
 * modules are listed: the master-data modules (suppliers/drivers/positions/…)
 * either have no desktop react-query twin or cache under hooks/useQuery's
 * ["uq", <callsite key>, ...deps].
 *
 * Those uq keys DO have an invalidable name now — the key is caller-supplied
 * rather than derived from the fetcher's source text — so wiring the master-data
 * modules in here is finally possible. Deliberately NOT done in the same change
 * that fixed the keying: adding roots here changes what refetches and when, and
 * that deserves its own diff. */
const MODULE_SHARED_ROOTS: Record<string, string[]> = {
  "delivery-orders-mfg": [...DO_ROOTS, ...STOCK_ROOTS],
  "sales-invoices":      ["sales-invoices", "sales-invoices-paged", "sales-invoice-detail"],
  /* `-paged` is the key the DESKTOP list actually reads
     (vendor/scm/lib/suppliers-queries.ts:533); the bare root is a different
     query. Omitting it here - alone among the five document modules on either
     side of it - meant a mobile PO status write left the desktop PO list showing
     the old status until a manual refresh. */
  "mfg-purchase-orders": ["mfg-purchase-orders", "mfg-purchase-orders-paged", "mfg-purchase-order-detail"],
  "grns":                ["grns", "grns-paged", "grn-detail", ...STOCK_ROOTS],
  "delivery-returns":    ["delivery-returns", "delivery-return-detail", ...STOCK_ROOTS],
  "purchase-returns":    ["purchase-returns", "purchase-return-detail", ...STOCK_ROOTS],
  "purchase-invoices":   ["purchase-invoices", "purchase-invoices-paged", "purchase-invoice-detail"],
};

export function invalidateModuleShared(qc: QueryClient, moduleKey: string) {
  const roots = MODULE_SHARED_ROOTS[moduleKey];
  if (roots) bump(qc, roots);
}
