import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_DATA_GRID_LAYOUT,
  decodeDataGridLayout,
  readDataGridLayout,
  serializeDataGridLayout,
} from "./dataGridLayoutStorage";

afterEach(() => localStorage.clear());

describe("DataGrid layout storage schema", () => {
  test("migrates a valid legacy layout to the versioned envelope", () => {
    localStorage.setItem("legacy-grid", JSON.stringify({
      order: ["name", "code"],
      hidden: ["phone"],
      widths: { name: 220 },
      groupBy: [],
      pinned: ["code"],
      sort: { key: "name", dir: "asc" },
    }));

    expect(readDataGridLayout("legacy-grid")).toEqual({
      order: ["name", "code"],
      hidden: ["phone"],
      widths: { name: 220 },
      groupBy: [],
      pinned: ["code"],
      sort: { key: "name", dir: "asc" },
    });
    expect(JSON.parse(localStorage.getItem("legacy-grid")!)).toMatchObject({
      version: 1,
      layout: { order: ["name", "code"] },
    });
  });

  test.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ unrelated: true }),
    JSON.stringify({ version: 999, layout: { order: ["name"] } }),
    JSON.stringify({ version: 1, layout: "wrong-shape" }),
  ])("fails soft for corrupt or unsupported input: %s", (raw) => {
    expect(decodeDataGridLayout(raw)).toEqual({
      layout: DEFAULT_DATA_GRID_LAYOUT,
      legacy: false,
      valid: false,
    });
  });

  test("sanitizes each persisted field instead of trusting parsed JSON", () => {
    const decoded = decodeDataGridLayout(JSON.stringify({
      version: 1,
      layout: {
        order: ["name", "name", 42, "code"],
        hidden: "not-an-array",
        widths: { name: 10, code: 99_999, bad: "wide", constructor: 100 },
        groupBy: ["team", null],
        pinned: ["code"],
        sort: { key: "name", dir: "sideways" },
      },
    }));

    expect(decoded).toEqual({
      legacy: false,
      valid: true,
      layout: {
        order: ["name", "code"],
        hidden: [],
        widths: { name: 40, code: 10_000 },
        groupBy: ["team"],
        pinned: ["code"],
        sort: null,
      },
    });
    expect(JSON.parse(serializeDataGridLayout(decoded.layout))).toMatchObject({ version: 1 });
  });
});
