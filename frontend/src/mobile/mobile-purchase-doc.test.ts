/* The phone's direct create for PO / GRN / PI — what it refuses and what it sends.
 *
 * FAILS ON THE PRE-FIX CODE — the module did not exist; the phone could only
 * convert from a source document.
 *
 * The load-bearing assertions are the ones that would let a WRONG document be
 * created without anyone noticing:
 *   - the PO variant gate must be the SHARED rule, including the DIVAN ONLY
 *     exemption that keys off the item code (dropping the code would demand a
 *     Gap the owner ruled a divan-only line does not have);
 *   - the unit price must be the TYPED number, never the picker's catalog
 *     SELLING price — on a purchase document that would be booked as cost.
 */
import { describe, expect, it } from "vitest";
import {
  MODULE_TO_PURCHASE_DOC,
  buildGrnPayload,
  buildPiPayload,
  buildPoPayload,
  convertInsteadFor,
  createBlockers,
  mayCreatePurchaseDoc,
  poConfirmVariantGaps,
  realLines,
  variantGapMessage,
  type PurchaseHeaderDraft,
  type PurchaseLineDraft,
} from "./mobile-purchase-doc";
import { missingRequiredVariants } from "../vendor/scm/components/SoLineCard";
import { MODULE_CONFIGS } from "./MobileModuleList";
import type { AccessLevel } from "../types";

const header = (over: Partial<PurchaseHeaderDraft> = {}): PurchaseHeaderDraft => ({
  supplierId: "sup-1",
  docDate: "2026-09-13",
  secondDate: "",
  warehouseId: "wh-1",
  reference: "",
  notes: "",
  ...over,
});

const line = (over: Partial<PurchaseLineDraft> = {}): PurchaseLineDraft => ({
  key: "l1",
  itemCode: "PILLOW-STD",
  name: "Standard Pillow",
  itemGroup: "accessory",
  qty: 2,
  unitPriceSen: 1250,
  remark: "",
  ...over,
});

describe("createBlockers — mirrors of refusals the server already makes", () => {
  it("is empty when supplier, warehouse and a real line are present", () => {
    expect(createBlockers("po", header(), [line()])).toEqual([]);
    expect(createBlockers("grn", header(), [line()])).toEqual([]);
    expect(createBlockers("pi", header(), [line()])).toEqual([]);
  });

  it("asks for the supplier on every document", () => {
    for (const kind of ["po", "grn", "pi"] as const) {
      expect(createBlockers(kind, header({ supplierId: "" }), [line()])).toContain("Pick the supplier.");
    }
  });

  it("asks for a warehouse on PO and GRN only — a purchase invoice has none", () => {
    expect(createBlockers("po", header({ warehouseId: "" }), [line()])).toEqual(["Pick the purchase location."]);
    expect(createBlockers("grn", header({ warehouseId: "" }), [line()])).toEqual(["Pick the receive into."]);
    expect(createBlockers("pi", header({ warehouseId: "" }), [line()])).toEqual([]);
  });

  it("does not count a line with no code or no quantity", () => {
    const blank = [line({ itemCode: "  " }), line({ key: "l2", qty: 0 })];
    expect(realLines(blank)).toEqual([]);
    expect(createBlockers("grn", header(), blank)).toEqual(["Add at least one item with a quantity."]);
  });
});

describe("poConfirmVariantGaps — the SHARED PO variant gate", () => {
  it("answers exactly what the desktop PO page's rule answers", () => {
    const lines = [
      line({ key: "a", itemCode: "TRION (A) (HB STR)-(K)", itemGroup: "bedframe" }),
      line({ key: "b", itemCode: "5535-3S", itemGroup: "sofa" }),
      line({ key: "c", itemCode: "PILLOW-STD", itemGroup: "accessory" }),
    ];
    const phone = poConfirmVariantGaps(lines);
    const desktop = lines
      .map((l) => ({ itemCode: l.itemCode, missing: missingRequiredVariants(l.itemGroup, {}, l.itemCode) }))
      .filter((g) => g.missing.length > 0);
    expect(phone).toEqual(desktop);
    expect(phone.map((g) => g.itemCode)).toEqual(["TRION (A) (HB STR)-(K)", "5535-3S"]);
  });

  it("names the bedframe options a supplier needs", () => {
    const [gap] = poConfirmVariantGaps([line({ itemCode: "TRION (A) (HB STR)-(K)", itemGroup: "bedframe" })]);
    expect(gap.missing).toEqual(["Divan Height", "Leg Height", "Gap", "Fabrics"]);
  });

  it("keeps the DIVAN ONLY exemption, which needs the item code", () => {
    const [gap] = poConfirmVariantGaps([line({ itemCode: "AKEMI DIVAN ONLY (Q)", itemGroup: "bedframe" })]);
    expect(gap.missing).not.toContain("Gap");
  });

  it("does not gate a line with no required options", () => {
    expect(poConfirmVariantGaps([line()])).toEqual([]);
  });

  it("tells the buyer every gap at once, and the way out", () => {
    const msg = variantGapMessage(poConfirmVariantGaps([
      line({ key: "a", itemCode: "TRION (A) (HB STR)-(K)", itemGroup: "bedframe" }),
      line({ key: "b", itemCode: "5535-3S", itemGroup: "sofa" }),
    ]));
    expect(msg.body).toContain("• TRION (A) (HB STR)-(K): Divan Height, Leg Height, Gap, Fabrics");
    expect(msg.body).toContain("• 5535-3S: Seat Size, Fabrics");
    expect(msg.body).toContain("draft");
  });
});

describe("request bodies — the field names each endpoint reads", () => {
  it("PO: supplier, purchase location, draft flag, typed price, blank lines dropped", () => {
    const body = buildPoPayload(
      header({ secondDate: "", notes: "  urgent  " }),
      [line({ unitPriceSen: 4200 }), line({ key: "blank", itemCode: "" })],
      true,
    );
    expect(body).toMatchObject({
      supplierId: "sup-1",
      purchaseLocationId: "wh-1",
      poDate: "2026-09-13",
      expectedAt: undefined,
      notes: "urgent",
      asDraft: true,
      currency: "MYR",
    });
    expect(body.items).toEqual([
      expect.objectContaining({ materialKind: "mfg_product", itemCode: "PILLOW-STD", materialName: "Standard Pillow", qty: 2, unitPriceSen: 4200, soItemId: null }),
    ]);
  });

  it("GRN: a manual receipt — no PO, accepted follows received, into the chosen warehouse", () => {
    const body = buildGrnPayload(header({ reference: "DN-7781" }), [line({ qty: 3, unitPriceSen: 900 })], false);
    expect(body).toMatchObject({ purchaseOrderId: null, warehouseId: "wh-1", receivedAt: "2026-09-13", deliveryNoteRef: "DN-7781", asDraft: false });
    expect(body.items[0]).toMatchObject({ purchaseOrderItemId: null, qtyReceived: 3, qtyAccepted: 3, qtyRejected: 0, unitPriceSen: 900 });
  });

  it("PI: a manual invoice — no GRN, no PO, supplier's own invoice number carried", () => {
    const body = buildPiPayload(header({ reference: "INV-55", secondDate: "2026-10-13" }), [line()], false);
    expect(body).toMatchObject({ grnId: null, purchaseOrderId: null, supplierInvoiceRef: "INV-55", invoiceDate: "2026-09-13", dueDate: "2026-10-13" });
    expect(body.items[0]).toMatchObject({ grnItemId: null, qty: 2, unitPriceSen: 1250 });
    expect(body).not.toHaveProperty("warehouseId");
  });

  it("sends 0 for a line whose price was never typed, as a desktop line with no price is", () => {
    for (const build of [buildPoPayload, buildGrnPayload, buildPiPayload]) {
      const body = build(header(), [line({ unitPriceSen: null })], false);
      expect(body.items[0].unitPriceSen).toBe(0);
    }
  });

  it("sends the TYPED price even when it is zero — never a catalog selling price", () => {
    for (const build of [buildPoPayload, buildGrnPayload, buildPiPayload]) {
      const body = build(header(), [line({ unitPriceSen: 0 })], false);
      expect(body.items[0].unitPriceSen).toBe(0);
    }
  });
});

describe("who gets the phone's \"+\" — the same per-document helpers", () => {
  const noPerms = () => false;
  const onlyArea = (area: string) => (page: string) => (page === area ? "edit" : "view") as AccessLevel;

  it("each document reads ITS OWN procurement area", () => {
    expect(mayCreatePurchaseDoc("po", noPerms, onlyArea("scm.procurement.po"))).toBe(true);
    expect(mayCreatePurchaseDoc("grn", noPerms, onlyArea("scm.procurement.grn"))).toBe(true);
    expect(mayCreatePurchaseDoc("pi", noPerms, onlyArea("scm.procurement.pi"))).toBe(true);
    expect(mayCreatePurchaseDoc("pi", noPerms, onlyArea("scm.procurement.po"))).toBe(false);
    expect(mayCreatePurchaseDoc("grn", noPerms, onlyArea("scm.procurement.pi"))).toBe(false);
  });

  it("a view-only holder gets no \"+\" on any of the three", () => {
    for (const kind of ["po", "grn", "pi"] as const) {
      expect(mayCreatePurchaseDoc(kind, noPerms, () => "view")).toBe(false);
    }
  });

  it("maps onto real mobile list configs whose endpoints are the documents it creates", () => {
    const endpointFor = { po: "/mfg-purchase-orders", grn: "/grns", pi: "/purchase-invoices" } as const;
    for (const [moduleKey, kind] of Object.entries(MODULE_TO_PURCHASE_DOC)) {
      const cfg = MODULE_CONFIGS[moduleKey];
      expect(cfg, moduleKey).toBeTruthy();
      expect(cfg.endpoint.split("?")[0]).toBe(endpointFor[kind]);
    }
  });

  it("keeps convert one tap away where the phone has it, and not where it does not", () => {
    expect(convertInsteadFor("po")).toEqual({ target: "po", label: "From a Sales Order instead" });
    expect(convertInsteadFor("grn")).toEqual({ target: "grn", label: "From a Purchase Order instead" });
    expect(convertInsteadFor("pi")).toBeNull();
  });
});
