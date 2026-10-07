import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { cancelledDocNoClass, cancelledRowClass, isCancelledDocStatus } from "../../lib/scm";

// Owner 2026-10-06: 「全系统 - Cancelled bill 我要有横线的」. A cancelled document's
// NUMBER is struck through on every list, the way the Purchase Orders list
// already did it, and the row is faded. Six lists had it, seventeen did not,
// and the mobile card only faded. One predicate (isCancelledDocStatus), two
// class helpers (lib/scm), two CSS rules (index.css dt-row-cancelled /
// dt-cancel-strike). This enumerates every document list so a new one, or a
// rewrite of an old one, cannot quietly drop the treatment.

const SRC = resolve(__dirname, "../..");

/* Every desktop list that shows document rows with a cancelled state. Adding a
   document list means adding it here. */
const DOCUMENT_LISTS = [
  "pages/scm-v2/MfgSalesOrdersListV2.tsx",
  "pages/scm-v2/MfgDeliveryOrdersListV2.tsx",
  "pages/scm-v2/SalesInvoicesListV2.tsx",
  "pages/scm-v2/PurchaseOrdersListV2.tsx",
  "pages/scm-v2/GoodsReceivedListV2.tsx",
  "pages/scm-v2/PurchaseInvoicesListV2.tsx",
  "pages/scm-v2/PurchaseReturnsListV2.tsx",
  "pages/scm-v2/DeliveryReturnsListV2.tsx",
  "pages/scm-v2/ConsignmentOrders.tsx",
  "pages/scm-v2/ConsignmentNotes.tsx",
  "pages/scm-v2/ConsignmentReturns.tsx",
  "pages/scm-v2/PurchaseConsignmentOrders.tsx",
  "pages/scm-v2/PurchaseConsignmentReceives.tsx",
  "pages/scm-v2/PurchaseConsignmentReturns.tsx",
  "pages/scm-v2/StockTakesListV2.tsx",
  "pages/scm-v2/StockTransfersListV2.tsx",
  "pages/scm-v2/PaymentVouchers.tsx",
  "pages/scm-v2/CreditNotes.tsx",
  "pages/scm-v2/DepositInvoices.tsx",
  "pages/scm-v2/ApInvoices.tsx",
  "pages/scm-v2/ArInvoices.tsx",
  "pages/scm-v2/Receipts.tsx",
  "pages/scm-v2/DpOrders.tsx",
];

const STRIKE = /dt-cancel-strike|cancelledDocNoClass\(/;
const ROW = /dt-row-cancelled|cancelledRowClass\(/;

describe("a cancelled document number is struck through on every list", () => {
  it("the predicate reads every spelling the backends use for cancelled", () => {
    for (const s of ["CANCELLED", "cancelled", "Cancelled", "cancel", "VOID", "Voided"]) {
      expect(isCancelledDocStatus(s), s).toBe(true);
    }
    for (const s of ["POSTED", "DRAFT", "COMPLETED", "", null, undefined]) {
      expect(isCancelledDocStatus(s), String(s)).toBe(false);
    }
  });

  it("the helpers resolve to the two index.css classes and to nothing otherwise", () => {
    expect(cancelledRowClass("CANCELLED")).toBe("dt-row-cancelled");
    expect(cancelledDocNoClass("CANCELLED")).toBe("dt-cancel-strike");
    expect(cancelledRowClass("POSTED")).toBeUndefined();
    expect(cancelledDocNoClass("POSTED")).toBeUndefined();
    const css = readFileSync(resolve(SRC, "index.css"), "utf8");
    expect(css).toMatch(/\.dt-cancel-strike\s*\{[^}]*line-through/);
    expect(css).toMatch(/\.dt-row-cancelled/);
  });

  it("DataGridCompat forwards getRowClassName, so the SCM grid lists can fade a row", () => {
    const src = readFileSync(resolve(SRC, "components/DataGridCompat.tsx"), "utf8");
    expect(src).toContain("getRowClassName?: (row: T) => string | undefined");
    expect(src).toContain("getRowClassName={getRowClassName}");
  });

  for (const file of DOCUMENT_LISTS) {
    it(`${file} strikes the cancelled number and fades the row`, () => {
      const src = readFileSync(resolve(SRC, file), "utf8");
      expect(src, `${file}: the document-number cell does not carry dt-cancel-strike`).toMatch(STRIKE);
      expect(src, `${file}: the row does not carry dt-row-cancelled`).toMatch(ROW);
    });
  }

  it("the mobile generic card strikes the number, not only the card", () => {
    const src = readFileSync(resolve(SRC, "mobile/MobileModuleList.tsx"), "utf8");
    const hits = src.match(/cancelled \? \{ textDecoration: "line-through"/g) ?? [];
    expect(hits.length, "both card layouts (SO-style and generic)").toBeGreaterThanOrEqual(2);
  });
});
