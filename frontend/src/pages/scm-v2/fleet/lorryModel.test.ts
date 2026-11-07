import { describe, expect, it } from "vitest";
import { alsoServes, boxOf, byHome, groupWarehouses, lorryHome, lorryMatches, warehouseRegion } from "./lorryModel";
import type { LorryRow } from "../../../vendor/scm/lib/lorries-queries";

const wh = (id: string, code: string, name: string) => ({ id, code, name });
const lorry = (o: Partial<LorryRow>) => ({ id: "l", plate: "VQE9058", type: "LORRY_17FT", active: true, notes: null, created_at: "", ...o }) as LorryRow;

describe("warehouses by region", () => {
  it("puts each warehouse in its region, a Penang display with Penang", () => {
    expect(warehouseRegion(wh("1", "BKG", "BALAKONG WAREHOUSE"))).toBe("Klang Valley");
    expect(warehouseRegion(wh("2", "PG-WH", "PENANG WAREHOUSE"))).toBe("Penang");
    expect(warehouseRegion(wh("3", "PG-D", "PENANG DISPLAY"))).toBe("Penang");
    expect(warehouseRegion(wh("4", "SUN", "SUNWAY SHOWROOM"))).toBe("Showrooms");
    expect(warehouseRegion(wh("5", "GZ", "GUANGZHOU WAREHOUSE"))).toBe("China");
    expect(warehouseRegion(wh("6", "SRW", "SARAWAK WAREHOUSE"))).toBe("Sarawak");
  });
  it("groups in a fixed region order and drops empty regions", () => {
    expect(groupWarehouses([wh("2", "PG", "PENANG WAREHOUSE"), wh("1", "BKG", "BALAKONG WAREHOUSE")]).map((g) => g.region)).toEqual(["Klang Valley", "Penang"]);
  });
});

describe("a lorry's home and box", () => {
  it("home is the chosen warehouse, else the first served; the rest are also-serves", () => {
    expect(lorryHome(lorry({ warehouse_id: "a", warehouse_ids: ["a", "b"] }))).toBe("a");
    expect(lorryHome(lorry({ warehouse_id: null, warehouse_ids: ["b"] }))).toBe("b");
    expect(alsoServes(lorry({ warehouse_id: "a", warehouse_ids: ["a", "b"] }))).toEqual(["b"]);
  });
  it("box needs all three sides; m3 from feet", () => {
    expect(boxOf(lorry({ length_ft: "17", width_ft: 7, height_ft: 7.5 }))).toEqual({ length: 17, width: 7, height: 7.5, m3: 25.3 });
    expect(boxOf(lorry({ length_ft: 17, width_ft: null, height_ft: 7 }))).toBeNull();
  });
  it("lorries sit under their home, a lorry with none last", () => {
    const g = byHome([lorry({ id: "1", plate: "W1591T", warehouse_ids: ["pg"] }), lorry({ id: "2", plate: "X1" }), lorry({ id: "3", plate: "VQE9058", warehouse_id: "kl" })], [wh("kl", "KL", "BALAKONG WAREHOUSE"), wh("pg", "PG", "PENANG WAREHOUSE")]);
    expect(g.map((x) => [x.label, x.lorries.map((l) => l.plate)])).toEqual([["BALAKONG WAREHOUSE", ["VQE9058"]], ["PENANG WAREHOUSE", ["W1591T"]], ["No home warehouse set", ["X1"]]]);
  });
  it("search reads plate, model and the usual driver", () => {
    expect(lorryMatches(lorry({ model: "ISUZU NPR75" }), "isuzu", null)).toBe(true);
    expect(lorryMatches(lorry({}), "umar", "UMAR FARHAN")).toBe(true);
    expect(lorryMatches(lorry({}), "zzz", null)).toBe(false);
  });
});
