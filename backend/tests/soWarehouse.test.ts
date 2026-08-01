import { describe, expect, test } from "vitest";
import {
  canonicalizeStateKey,
  warehouseIdFromSalesLocation,
  warehouseIdFromState,
  resolveSoWarehouseId,
  resolveLineWarehouseId,
  type SoWarehouseMasters,
} from "../src/scm/lib/so-warehouse";

// Owner, 2026-07-31: "我们的 item 都不会有仓库, 还是跟着 SO 的" — an item never
// carries a warehouse; the warehouse comes from the Sales Order.
//
// The bug: 2990-SO-2607-028's two-module LOTTI set split into TWO MRP rows
// because line 1 had warehouse_id NULL while line 0 had KL WAREHOUSE, and
// Mrp.tsx's groupBySo keys on `${warehouseId ?? WH_NONE}|${soDocNo}`. 7 of 116
// active sofa lines carried a NULL warehouse.
//
// The fix resolves a NULL line's warehouse from the SO's OWN header — never
// from a SIBLING LINE, which would pool stock across the warehouse boundary the
// WH_NONE bucket exists to keep apart.

const KL = "11111111-1111-1111-1111-111111111111";
const PG = "22222222-2222-2222-2222-222222222222";

const masters: SoWarehouseMasters = {
  warehouses: [
    { id: KL, code: "KL", name: "KL WAREHOUSE" },
    { id: PG, code: "PG", name: "PENANG WAREHOUSE" },
  ],
  stateMappings: [
    { state: "Kuala Lumpur", warehouse_id: KL },
    { state: "Pulau Pinang", warehouse_id: PG },
  ],
};

describe("warehouseIdFromSalesLocation — the SO's warehouse of record", () => {
  test("matches the warehouse CODE, which is what warehouseLabel writes", () => {
    expect(warehouseIdFromSalesLocation("KL", masters.warehouses)).toBe(KL);
  });

  test("matches the NAME too, and is case- and whitespace-insensitive", () => {
    expect(warehouseIdFromSalesLocation("kl warehouse", masters.warehouses)).toBe(KL);
    expect(warehouseIdFromSalesLocation("  PG  ", masters.warehouses)).toBe(PG);
  });

  test("an unknown or empty location resolves to nothing — never a near match", () => {
    expect(warehouseIdFromSalesLocation("KL WAREHOUSE 2", masters.warehouses)).toBe(null);
    expect(warehouseIdFromSalesLocation("", masters.warehouses)).toBe(null);
    expect(warehouseIdFromSalesLocation(null, masters.warehouses)).toBe(null);
  });
});

describe("warehouseIdFromState — the derivation the SO write path uses", () => {
  test("canonicalises the known aliases the same way deriveWarehouseIdFromState does", () => {
    expect(canonicalizeStateKey("Wilayah Persekutuan Kuala Lumpur")).toBe("kuala lumpur");
    expect(canonicalizeStateKey("  PENANG ")).toBe("pulau pinang");
    expect(canonicalizeStateKey("Malacca")).toBe("melaka");
  });

  test("resolves through the mapping table tolerantly", () => {
    expect(warehouseIdFromState("KUALA LUMPUR", masters.stateMappings)).toBe(KL);
    expect(warehouseIdFromState("Penang", masters.stateMappings)).toBe(PG);
    expect(warehouseIdFromState("Sabah", masters.stateMappings)).toBe(null);
    expect(warehouseIdFromState(null, masters.stateMappings)).toBe(null);
  });
});

describe("resolveSoWarehouseId — recorded value first, derivation only as fallback", () => {
  test("sales_location wins over the state mapping", () => {
    expect(
      resolveSoWarehouseId({ sales_location: "PG", customer_state: "Kuala Lumpur" }, masters),
    ).toBe(PG);
  });

  test("falls back to customer_state when sales_location is blank or unknown", () => {
    expect(resolveSoWarehouseId({ sales_location: null, customer_state: "Penang" }, masters)).toBe(PG);
    expect(resolveSoWarehouseId({ sales_location: "GONE", customer_state: "Penang" }, masters)).toBe(PG);
  });

  test("an SO carrying neither resolves to nothing — honest, not guessed", () => {
    expect(resolveSoWarehouseId({ sales_location: null, customer_state: null }, masters)).toBe(null);
    expect(resolveSoWarehouseId(null, masters)).toBe(null);
  });
});

describe("resolveLineWarehouseId — the whole rule", () => {
  test("a line that HAS a warehouse keeps it; the SO never overrides the line", () => {
    expect(resolveLineWarehouseId(PG, { sales_location: "KL" }, masters)).toBe(PG);
  });

  test("2990-SO-2607-028: the NULL line inherits the SO's warehouse, so the set groups as ONE row", () => {
    const so = { sales_location: "KL", customer_state: "Kuala Lumpur" };
    const line0 = resolveLineWarehouseId(KL, so, masters);   // already bound
    const line1 = resolveLineWarehouseId(null, so, masters); // was NULL -> WH_NONE
    expect(line1).toBe(KL);
    // groupBySo keys on `${warehouseId ?? WH_NONE}|${soDocNo}`; equal keys = one row.
    const key = (wh: string | null) => `${wh ?? "NOWH"}|2990-SO-2607-028`;
    expect(key(line1)).toBe(key(line0));
  });

  test("NOT a sibling-line fallback: with nothing on the SO header the line stays NULL", () => {
    // The sibling line's KL warehouse is deliberately invisible here — pooling
    // across a warehouse boundary is the thing the WH_NONE bucket prevents.
    expect(resolveLineWarehouseId(null, { sales_location: null, customer_state: null }, masters)).toBe(null);
  });

  test("a line under an SO whose warehouse was deactivated resolves to nothing rather than guessing", () => {
    const noWarehouses: SoWarehouseMasters = { warehouses: [], stateMappings: [] };
    expect(resolveLineWarehouseId(null, { sales_location: "KL" }, noWarehouses)).toBe(null);
  });
});
