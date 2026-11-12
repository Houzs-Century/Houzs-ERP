// The DINING gate the PO quick-view uses to decide which line shows its Remark.
// The trap it guards: `purchase_order_items.notes` is populated on NON-dining
// lines too (in prod: bedframe / sofa / mattress lines all carry notes), so a
// panel that read `notes` directly would leak every sofa note into this slot.
// Mirrors the backend `isDiningGroup` (backend po-dining-remark.ts) so the
// on-screen remark and the printed "Remark:" agree on which lines qualify.
import { describe, expect, test } from "vitest";
import { isDiningGroup, diningLineRemark } from "./po-dining-remark";

describe("isDiningGroup", () => {
  test('only the "dining" group, case- and whitespace-insensitive', () => {
    expect(isDiningGroup("dining")).toBe(true);
    expect(isDiningGroup("DINING")).toBe(true);
    expect(isDiningGroup("  Dining  ")).toBe(true);
    for (const g of ["sofa", "bedframe", "mattress", "accessory", "service", "", "  ", null, undefined]) {
      expect(isDiningGroup(g)).toBe(false);
    }
  });
});

describe("diningLineRemark", () => {
  test("a dining line surfaces its own note, trimmed", () => {
    expect(diningLineRemark("dining", "MT-505OV 5.3ft")).toBe("MT-505OV 5.3ft");
    expect(diningLineRemark("DINING", "  7010 DC-LS  ")).toBe("7010 DC-LS");
  });

  test("a non-dining line with a note surfaces nothing (the trap)", () => {
    expect(diningLineRemark("sofa", "WOOD FRAME NOTE")).toBeNull();
    expect(diningLineRemark("bedframe", "SLATS x14")).toBeNull();
    expect(diningLineRemark(null, "orphan note")).toBeNull();
  });

  test("a dining line with a blank / absent note surfaces nothing", () => {
    expect(diningLineRemark("dining", "")).toBeNull();
    expect(diningLineRemark("dining", "   ")).toBeNull();
    expect(diningLineRemark("dining", null)).toBeNull();
    expect(diningLineRemark("dining", undefined)).toBeNull();
  });
});
