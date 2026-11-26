
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetInVisitColFilters } from "./components/dataTableColFilterMemory";

afterEach(() => {
  cleanup();
  resetInVisitColFilters();
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const stale = [...url.searchParams.keys()].filter((k) => k.startsWith("cf."));
  if (stale.length > 0) {
    for (const k of stale) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url);
  }
});

// Product categories come from GET /mfg-products/categories (scm.acc_item_groups,
// HC-0258). Every test sees the rows the migrations seed, sorted by name as the
// server sends them, with no QueryClient or network needed.
vi.mock("./vendor/scm/lib/product-categories-store", async (importOriginal) => {
  const m = await importOriginal<typeof import("./vendor/scm/lib/product-categories-store")>();
  const seed = ([
    ["ACCESSORY", "Accessory"], ["BEDFRAME", "Bedframe"], ["BEDLINES", "Bedlines"], ["CARPET", "Carpet"],
    ["DIFFUSER", "Diffuser"], ["DINING", "Dining"], ["MATTRESS", "Mattress"], ["SERVICE", "Service"],
    ["SOFA", "Sofa"], ["FABRIC_ACCESSORY", "Sofa Accessory"],
  ] as const).map(([code, name]) => ({ code, name, isActive: true }));
  m.primeProductCategories(seed);
  return { ...m, useProductCategories: () => ({ all: seed, active: seed, isLoading: false }) };
});
