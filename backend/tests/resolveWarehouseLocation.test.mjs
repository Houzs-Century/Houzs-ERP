/* Unit test for the SO-header warehouse backfill resolution rule — the tested
   SPEC of the SQL backfill in the `..._so_header_warehouse_id_backfill.sql`
   migration. Pure: no DB, runs in the light suite. */
import { describe, expect, it } from "vitest";
import { resolveWarehouseLocation } from "../scripts/lib/resolve-warehouse-location.mjs";

const WH = [
  { id: "kl", code: "KL WAREHOUSE", name: "Balakong Warehouse" },
  { id: "pg", code: "PG WAREHOUSE", name: "Penang Warehouse" },
  { id: "showroom", code: "PJ SHOWROOM", name: "PJ Showroom" },
];

describe("resolveWarehouseLocation", () => {
  it("resolves by CODE when exactly one code matches", () => {
    expect(resolveWarehouseLocation("KL WAREHOUSE", WH)).toEqual({
      id: "kl",
      matchedBy: "code",
      reason: "resolved",
    });
  });

  it("falls back to NAME when no code matches and exactly one name matches", () => {
    expect(resolveWarehouseLocation("Penang Warehouse", WH)).toEqual({
      id: "pg",
      matchedBy: "name",
      reason: "resolved",
    });
  });

  it("prefers CODE over NAME when both could match different rows", () => {
    // A location that is one row's code and ANOTHER row's name must resolve to
    // the code row — code is authoritative (sales_location is written from it).
    const rows = [
      { id: "a", code: "PJ SHOWROOM", name: "Main Store" },
      { id: "b", code: "MAIN", name: "PJ SHOWROOM" },
    ];
    expect(resolveWarehouseLocation("PJ SHOWROOM", rows)).toEqual({
      id: "a",
      matchedBy: "code",
      reason: "resolved",
    });
  });

  it("does NOT resolve when the code is ambiguous (>1 match)", () => {
    const rows = [
      { id: "a", code: "DUP", name: "One" },
      { id: "b", code: "DUP", name: "Two" },
    ];
    expect(resolveWarehouseLocation("DUP", rows)).toEqual({
      id: null,
      matchedBy: null,
      reason: "ambiguous_code",
    });
  });

  it("does NOT resolve when the name is ambiguous (>1 match, no code hit)", () => {
    const rows = [
      { id: "a", code: "C1", name: "SHARED" },
      { id: "b", code: "C2", name: "SHARED" },
    ];
    expect(resolveWarehouseLocation("SHARED", rows)).toEqual({
      id: null,
      matchedBy: null,
      reason: "ambiguous_name",
    });
  });

  it("does NOT resolve when nothing matches", () => {
    expect(resolveWarehouseLocation("NO SUCH PLACE", WH)).toEqual({
      id: null,
      matchedBy: null,
      reason: "no_match",
    });
  });

  it("treats empty / whitespace / null / undefined as empty (unresolved)", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(resolveWarehouseLocation(v, WH)).toEqual({
        id: null,
        matchedBy: null,
        reason: "empty",
      });
    }
  });

  it("trims surrounding whitespace on both sides before matching", () => {
    expect(resolveWarehouseLocation("  KL WAREHOUSE  ", WH).id).toBe("kl");
    const rows = [{ id: "x", code: "  KL WAREHOUSE  ", name: null }];
    expect(resolveWarehouseLocation("KL WAREHOUSE", rows).id).toBe("x");
  });

  it("is case-sensitive (mirrors the SQL `=`)", () => {
    expect(resolveWarehouseLocation("kl warehouse", WH).reason).toBe("no_match");
  });

  it("handles an empty candidate list", () => {
    expect(resolveWarehouseLocation("KL WAREHOUSE", []).reason).toBe("no_match");
  });
});
