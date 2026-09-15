import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DATA_TABLE_LAYOUT_FAMILIES } from "./dataTableLayoutFamilies";

describe("DataTable document-family layout manifest", () => {
  test("contains exactly eight unique, stable document family identities", () => {
    const keys = Object.values(DATA_TABLE_LAYOUT_FAMILIES);
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => !/\d/.test(key))).toBe(true);
  });

  /* A document's lines open in the document's own order — the order its editor,
     its PDF and AutoCount show — every time. The family shares one layout across
     every document of the kind, so a saved sort or funnel re-ordered or hid the
     lines of every document opened after it (owner 2026-09-15). */
  test("every document line table keeps its sort and funnels for the visit only", () => {
    const dir = "src/pages/scm-v2";
    const uses = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) =>
        [...readFileSync(`${dir}/${f}`, "utf8").matchAll(/layoutFamily=\{DATA_TABLE_LAYOUT_FAMILIES\.(\w+)\}([^\n]*)/g)]
          .map((m) => ({ file: f, family: m[1], rest: m[2] })),
      );
    expect(uses.map((u) => u.family).sort()).toEqual(Object.keys(DATA_TABLE_LAYOUT_FAMILIES).sort());
    for (const u of uses) {
      expect(`${u.file} ${u.rest}`).toContain("persistSort={false}");
      expect(`${u.file} ${u.rest}`).toContain("persistFilters={false}");
    }
  });
});
