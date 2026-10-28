import { describe, expect, test } from "vitest";
import { DATA_GRID_LAYOUT_KEYS } from "./dataGridLayoutKeys";

describe("DataGrid layout key ownership manifest", () => {
  test("assigns a unique stable key to every registered grid", () => {
    const keys = Object.values(DATA_GRID_LAYOUT_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("keeps Fleet and the retired standalone Drivers surface isolated", () => {
    expect(DATA_GRID_LAYOUT_KEYS.fleetDrivers).toBe("dg-drivers");
    expect(DATA_GRID_LAYOUT_KEYS.driversStandalone).toBe("dg-drivers-standalone");
    expect(DATA_GRID_LAYOUT_KEYS.fleetDrivers).not.toBe(DATA_GRID_LAYOUT_KEYS.driversStandalone);
  });
});
