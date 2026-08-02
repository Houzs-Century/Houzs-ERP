import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = (relative: string) =>
  readFileSync(resolve(process.cwd(), "src", relative), "utf8");

describe("list search scope contracts", () => {
  test.each([
    ["pages/scm-v2/Amendments.tsx", 500],
    ["pages/scm-v2/PaymentVouchers.tsx", 500],
    ["pages/scm-v2/PurchaseConsignmentReturns.tsx", 300],
    ["pages/scm-v2/PurchaseConsignmentOrders.tsx", 1000],
    ["pages/scm-v2/PurchaseConsignmentReceives.tsx", 1000],
    ["pages/scm-v2/ProductModels.tsx", 1000],
  ])("declares the loaded-only upstream cap for %s", (file, limit) => {
    expect(source(file)).toContain(`loadedSearchLimit={${limit}}`);
  });

  // Pages whose list moved from DataGrid to DataTable (batch 2 of the table
  // unification) declare the same cap through the DataTable `search` config —
  // the table renders the scope hint itself, so the marker is the config
  // field, not the DataGrid JSX attribute. Conversions migrate entries from
  // the roster above into this one.
  test.each([["pages/scm-v2/Accounting.tsx", 500]])(
    "declares the loaded-only cap via DataTable search config for %s",
    (file, limit) => {
      expect(source(file)).toContain(`loadedLimit: ${limit}`);
    }
  );

  test.each([
    ["pages/scm-v2/DeliveryReturnsListV2.tsx", 500],
    ["pages/scm-v2/PurchaseReturnsListV2.tsx", 300],
  ])("declares the loaded-only cap on custom and DataTable search for %s", (file, limit) => {
    const contents = source(file);
    expect(contents).toContain(`loadedLimit: ${limit}`);
    expect(contents).toContain(`loadedLimit={${limit}}`);
  });

  test("does not promise joined fields that the current server search cannot query", () => {
    expect(source("pages/scm-v2/GoodsReceivedListV2.tsx")).not.toMatch(/Search GRN[^\n]*(supplier|PO)/i);
    expect(source("pages/scm-v2/PurchaseOrdersListV2.tsx")).not.toMatch(/Search PO[^\n]*supplier/i);
    expect(source("pages/scm-v2/PurchaseInvoicesListV2.tsx")).not.toMatch(/Search PI[^\n]*(supplier, source|supplier and source)/i);
  });

  test.each([
    "pages/scm-v2/StockTakesListV2.tsx",
    "pages/scm-v2/StockTransfersListV2.tsx",
    "pages/scm-v2/UnbilledDeliveriesV2.tsx",
  ])("declares complete accessible-result search for %s", (file) => {
    expect(source(file)).toContain('scope: "server"');
  });

  test("reports mobile module endpoint caps instead of implying global search", () => {
    const contents = source("mobile/MobileModuleList.tsx");
    // The cap is what this test is about. Assert it CLOSED, not with a trailing
    // `&`: that only passed because a second param happened to follow, so
    // removing an unrelated query param broke a test about limits.
    expect(contents).toContain('endpoint: "/delivery-returns?limit=500"');
    expect(contents).toContain('endpoint: "/purchase-returns?limit=300"');
    expect(contents).toContain("loadedLimit={loadedSearchLimit}");
  });

  test("reports the mobile conversion source cap", () => {
    const contents = source("mobile/MobileConvertWizard.tsx");
    expect(contents.match(/limit=200/g)).toHaveLength(3);
    expect(contents).toContain('scope="loaded"');
    expect(contents).toContain("loadedLimit={200}");
  });

  test("separates complete inventory product search from capped lot-derived batches", () => {
    const contents = source("pages/scm-v2/Inventory.tsx");
    expect(contents).toContain('scope="server"');
    expect(contents).toContain("Searches batches assembled from up to 1,000 loaded lot rows only");
    expect(contents).toContain("searchTransition.resultsAreStale || isPlaceholderData");
    expect(contents).toContain("resultsAreStale ? [] : rows");
  });

  // The rows are blanked while a search is in flight (above), which zeroes every
  // aggregate computed from them. Each headline tile must therefore declare the
  // unknown state rather than print a settled-looking figure.
  test("never states a money aggregate derived from rows it blanked", () => {
    const inventory = source("pages/scm-v2/Inventory.tsx");
    expect(inventory).toContain("const statsPending =");
    expect(inventory).toContain('value={fmtRm(stats.totalValue)} pending={statsPending}');
    expect(inventory).toContain("pending={breakdownPending}");

    const soDetail = source("pages/scm-v2/SalesOrderDetailListing.tsx");
    expect(soDetail).toMatch(/pending=\{query\.isLoading[^}]*\}/);
  });

  // Every paginated SCM list swaps its rows for a pending panel mid-search. The
  // KPI strip above summarises the same payload, so it has to declare the same
  // unknown state - otherwise "Outstanding RM 0.00" outlives the rows it
  // describes, on the six money-carrying lists at once.
  test.each([
    "pages/scm-v2/MfgSalesOrdersListV2.tsx",
    "pages/scm-v2/SalesInvoicesListV2.tsx",
    "pages/scm-v2/PurchaseOrdersListV2.tsx",
    "pages/scm-v2/PurchaseInvoicesListV2.tsx",
    "pages/scm-v2/MfgDeliveryOrdersListV2.tsx",
    "pages/scm-v2/GoodsReceivedListV2.tsx",
    // Loaded-scope lists: no search transition, but the same [] -> RM 0.00 on
    // the first paint and on a failed fetch.
    "pages/scm-v2/DeliveryReturnsListV2.tsx",
    "pages/scm-v2/PurchaseReturnsListV2.tsx",
    // Finance report, single fetch, no early return: an unloaded or failed
    // response painted "Not billed RM 0.00" on a page whose whole purpose is to
    // say how much is owed.
    "pages/scm-v2/UnbilledDeliveriesV2.tsx",
  ])("declares the unknown state on every KPI tile of %s", (file) => {
    const contents = source(file);
    expect(contents).toContain("const statsPending =");
    const tiles = contents.match(/<StatCard/g) ?? [];
    const declared = contents.match(/pending=\{statsPending\}/g) ?? [];
    expect(tiles.length).toBeGreaterThan(0);
    expect(declared).toHaveLength(tiles.length);
  });
});
