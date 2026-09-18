/* "Add line" on the phone detail — who is offered it, and what is sent.
 *
 * FAILS ON THE PRE-FIX CODE — the module did not exist; the phone could not add
 * a line to any document.
 *
 * The gate is two SHARED answers ANDed (may this person write the document;
 * is it still open for a line), so both halves are pinned per document, and the
 * bodies are pinned to what the desktop add rows send.
 */
import { describe, expect, it } from "vitest";
import {
  MODULE_TO_ADD_LINE_DOC,
  addLineBlockers,
  addLinePayload,
  mayAddLine,
  type AddLineAccess,
  type AddLineDraft,
} from "./mobile-add-line";
import type { AccessLevel, AuthUser } from "../types";

const officeUser = { id: 1, email: "o@x.test", name: "O", role_id: 1, role_name: "user", status: "active", permissions: [], position_name: "Account Executive", department_name: "Account Department" } as unknown as AuthUser;
const salesUser = { ...officeUser, position_name: "Sales Executive", department_name: "Sales Department" } as unknown as AuthUser;

const access = (levels: Record<string, AccessLevel>, user: AuthUser = officeUser): AddLineAccess => ({
  user,
  can: () => false,
  pageAccess: (page) => levels[page] ?? "none",
});
const editAll = access({
  "scm.procurement.po": "edit",
  "scm.procurement.grn": "edit",
  "scm.procurement.pi": "edit",
  "scm.sales.invoices": "edit",
});

describe("mayAddLine — the operate half", () => {
  it("offers each document to someone who may edit THAT document", () => {
    expect(mayAddLine("po", { status: "SUBMITTED", has_children: false }, editAll)).toBe(true);
    expect(mayAddLine("grn", { status: "POSTED", has_children: false }, editAll)).toBe(true);
    expect(mayAddLine("pi", { status: "POSTED", paid_sen: 0 }, editAll)).toBe(true);
    expect(mayAddLine("si", { status: "DRAFT" }, editAll)).toBe(true);
  });

  it("offers none of them to a view-only holder", () => {
    const viewAll = access({ "scm.procurement.po": "view", "scm.procurement.grn": "view", "scm.procurement.pi": "view", "scm.sales.invoices": "view" });
    expect(mayAddLine("po", { status: "SUBMITTED", has_children: false }, viewAll)).toBe(false);
    expect(mayAddLine("grn", { status: "DRAFT", has_children: false }, viewAll)).toBe(false);
    expect(mayAddLine("pi", { status: "DRAFT", paid_sen: 0 }, viewAll)).toBe(false);
    expect(mayAddLine("si", { status: "DRAFT" }, viewAll)).toBe(false);
  });

  it("does not lend one document's edit right to another", () => {
    const poOnly = access({ "scm.procurement.po": "edit" });
    expect(mayAddLine("pi", { status: "DRAFT", paid_sen: 0 }, poOnly)).toBe(false);
  });

  it("keeps the owner's rule that Sales only LOOKS at a sales invoice", () => {
    /* canOperateSalesInvoices — Sales cohort is refused even with edit access. */
    const salesEdit = access({ "scm.sales.invoices": "edit" }, salesUser);
    expect(mayAddLine("si", { status: "DRAFT" }, salesEdit)).toBe(false);
  });
});

describe("mayAddLine — the lock half (shared with the desktop editors)", () => {
  it("closes a PO once a goods receipt exists, or once RECEIVED / CANCELLED", () => {
    expect(mayAddLine("po", { status: "SUBMITTED", has_children: true }, editAll)).toBe(false);
    expect(mayAddLine("po", { status: "RECEIVED", has_children: false }, editAll)).toBe(false);
  });
  it("closes a POSTED goods receipt with a downstream invoice or return", () => {
    expect(mayAddLine("grn", { status: "POSTED", has_children: true }, editAll)).toBe(false);
  });
  it("closes a purchase invoice once anything is paid (paid_sen may arrive as text)", () => {
    expect(mayAddLine("pi", { status: "POSTED", paid_sen: "100" }, editAll)).toBe(false);
  });
  it("closes an issued sales invoice", () => {
    expect(mayAddLine("si", { status: "ISSUED" }, editAll)).toBe(false);
  });
  it("offers nothing on a header that has not loaded", () => {
    for (const doc of ["po", "grn", "pi", "si"] as const) {
      expect(mayAddLine(doc, null, editAll), doc).toBe(false);
    }
  });
});

describe("the modules that carry it", () => {
  it("is exactly the four documents the desktop offers it on — never a delivery order", () => {
    expect(MODULE_TO_ADD_LINE_DOC).toEqual({ "mfg-purchase-orders": "po", grns: "grn", "purchase-invoices": "pi", "sales-invoices": "si" });
  });
});

describe("addLinePayload — the desktop add rows' bodies", () => {
  const draft: AddLineDraft = { itemCode: " PILLOW-STD ", name: "Standard Pillow", itemGroup: "accessory", qty: 3, unitPriceSen: 1250 };

  it("PO: PurchaseOrderDetail's new-line insert", () => {
    expect(addLinePayload("po", "po-1", draft, null)).toEqual({ poId: "po-1", materialKind: "mfg_product", itemCode: "PILLOW-STD", materialName: "Standard Pillow", qty: 3, unitPriceSen: 1250, itemGroup: "accessory", soItemId: null });
  });
  it("GRN: GoodsReceivedDetail's manual add — qty, no PO item, the receipt date", () => {
    expect(addLinePayload("grn", "grn-1", draft, "2026-09-13")).toEqual({ grnId: "grn-1", purchaseOrderItemId: null, materialKind: "mfg_product", itemCode: "PILLOW-STD", materialName: "Standard Pillow", itemGroup: "accessory", qty: 3, unitPriceSen: 1250, deliveryDate: "2026-09-13" });
  });
  it("PI: PurchaseInvoiceDetail's free-entry line", () => {
    expect(addLinePayload("pi", "pi-1", draft, null)).toEqual({ id: "pi-1", materialKind: "mfg_product", itemCode: "PILLOW-STD", materialName: "Standard Pillow", qty: 3, unitPriceSen: 1250, discountSen: 0, itemGroup: "accessory" });
  });
  it("SI: SalesInvoiceAddLine's submit", () => {
    expect(addLinePayload("si", "si-1", draft, null)).toEqual({ id: "si-1", itemCode: "PILLOW-STD", description: "Standard Pillow", qty: 3, unitPriceSen: 1250, discountSen: 0, uom: "UNIT" });
  });
  it("sends 0 for a price never typed — never a catalog price", () => {
    for (const doc of ["po", "grn", "pi", "si"] as const) {
      expect(addLinePayload(doc, "d", { ...draft, unitPriceSen: null }, null).unitPriceSen, doc).toBe(0);
    }
  });
});

describe("addLineBlockers", () => {
  it("needs an item and a positive quantity", () => {
    expect(addLineBlockers({ itemCode: "", name: "", itemGroup: "", qty: 1, unitPriceSen: null })).toEqual(["Pick an item."]);
    expect(addLineBlockers({ itemCode: "X", name: "", itemGroup: "", qty: 0, unitPriceSen: null })).toEqual(["Quantity must be more than zero."]);
    expect(addLineBlockers({ itemCode: "X", name: "", itemGroup: "", qty: 1, unitPriceSen: null })).toEqual([]);
  });
});
