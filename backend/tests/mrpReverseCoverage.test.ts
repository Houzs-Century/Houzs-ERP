import { describe, expect, test } from "vitest";
import { mrpReverseCoverage, type MrpResult } from "../src/scm/routes/mrp";

// Reverse of the forward SO→PO coverage: mrpReverseCoverage groups the SAME
// allocation by the COVERING PO number, so a purchase document can show which
// outstanding SO line(s) its supply is floating-assigned to, matched by SKU.
// Pure function over a computeMrp result — no DB.

// Minimal builders: fill only the fields the reverse mapper reads, cast the rest.
const sku = (itemCode: string, variantLabel: string | null, warehouseName: string | null, lines: any[]) =>
  ({ itemCode, variantLabel, warehouseName, lines } as any);
const line = (over: Record<string, unknown>) =>
  ({ soItemId: "si", soDocNo: "SO-X", deliveryDate: null, debtorName: null, qty: 1, source: "stock", poNumber: null, ...over } as any);
const sofaSet = (over: Record<string, unknown>) =>
  ({ soItemId: "ss", soDocNo: "SO-S", itemCode: "SOFA-1", variantLabel: "SOFA-1", warehouseName: "KL", deliveryDate: null, debtorName: null, qty: 1, poNumber: null, ...over } as any);

const result = (skus: any[], sofaSets: any[] = []): MrpResult =>
  ({ asOf: "", categories: [], warehouses: [], skus, sofaSets, totals: {} as any } as MrpResult);

describe("mrpReverseCoverage", () => {
  test("groups PO-covered lines under the covering PO number, by SKU", () => {
    const r = result([
      sku("BF-15", "BF-15 / SEAT 24", "KL", [
        line({ soItemId: "a", soDocNo: "SO-2606-033", deliveryDate: "2026-08-01", debtorName: "Ali", qty: 2, source: "po", poNumber: "PO-1" }),
        line({ soItemId: "b", soDocNo: "SO-2606-034", deliveryDate: "2026-08-05", debtorName: "Bob", qty: 1, source: "po", poNumber: "PO-1" }),
      ]),
    ]);
    const map = mrpReverseCoverage(r);
    const forPo = map.get("PO-1");
    expect(forPo).toBeDefined();
    expect(forPo!.map((a) => a.soDocNo)).toEqual(["SO-2606-033", "SO-2606-034"]);
    expect(forPo![0]).toMatchObject({ itemCode: "BF-15", deliveryDate: "2026-08-01", debtorName: "Ali", qty: 2, warehouseName: "KL" });
  });

  test("excludes stock and shortage lines (only source==='po' with a poNumber)", () => {
    const r = result([
      sku("BF-15", null, "KL", [
        line({ source: "stock", poNumber: null }),
        line({ source: "shortage", poNumber: null }),
        line({ source: "po", poNumber: null }), // defensive: 'po' but no number => skip
      ]),
    ]);
    expect(mrpReverseCoverage(r).size).toBe(0);
  });

  test("includes sofa SETS with a covering PO, ignores uncovered sets", () => {
    const r = result([], [
      sofaSet({ soDocNo: "SO-S1", itemCode: "SOFA-A", deliveryDate: "2026-09-01", poNumber: "PO-2", qty: 1 }),
      sofaSet({ soDocNo: "SO-S2", itemCode: "SOFA-B", poNumber: null }), // uncovered
    ]);
    const map = mrpReverseCoverage(r);
    expect([...map.keys()]).toEqual(["PO-2"]);
    expect(map.get("PO-2")![0]).toMatchObject({ soDocNo: "SO-S1", itemCode: "SOFA-A", deliveryDate: "2026-09-01" });
  });

  test("one PO covering two SKUs collects both assignments", () => {
    const r = result([
      sku("BF-15", null, "KL", [line({ soDocNo: "SO-1", source: "po", poNumber: "PO-9" })]),
      sku("MAT-7", null, "KL", [line({ soDocNo: "SO-2", source: "po", poNumber: "PO-9" })]),
    ]);
    const forPo = mrpReverseCoverage(r).get("PO-9")!;
    expect(forPo.map((a) => a.itemCode).sort()).toEqual(["BF-15", "MAT-7"]);
  });
});
