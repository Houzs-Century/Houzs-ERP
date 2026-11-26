import type { QueryClient } from "@tanstack/react-query";


const bump = (qc: QueryClient, keys: string[]) => {
  for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
};

const SO_ROOTS = ["mfg-sales-orders", "mfg-sales-orders-paged", "mfg-sales-order-detail"];
const DO_ROOTS = ["mfg-delivery-orders", "mfg-delivery-orders-paged", "mfg-delivery-order-detail", "delivery-planning", "mfg-delivery-order-pod"];
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

const CONVERT_PICKER_ROOTS = ["convert-source", "convert-lines", "convert-grn-lines"];

export function invalidateMobileLists(qc: QueryClient) {
  bump(qc, ["mobile-module", "mobile-module-paged"]);
}

export function invalidateConvertShared(qc: QueryClient) {
  invalidateSoShared(qc);
  invalidateDoShared(qc);
  invalidateInventoryShared(qc);
  bump(qc, ["sales-invoices", "sales-invoices-paged", "mfg-purchase-orders", "mfg-purchase-orders-paged", "grns", "grns-paged"]);
  bump(qc, CONVERT_PICKER_ROOTS);
}

const STOCK_ROOTS = ["inventory", ...SO_ROOTS];

const MODULE_SHARED_ROOTS: Record<string, string[]> = {
  "delivery-orders-mfg": [...DO_ROOTS, ...STOCK_ROOTS],
  "sales-invoices":      ["sales-invoices", "sales-invoices-paged", "sales-invoice-detail"],
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
