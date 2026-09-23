import { describe, expect, test } from "vitest";
import { matchesProductQuery } from "./mfg-products-queries";

/* The SKU pickers filter the CACHED catalog with this instead of firing a
   `/mfg-products?search=` request per keystroke (owner 2026-09-23: "product code
   search slow"). It must match the SAME fields the server filter matches —
   code / name / description / barcode, case-insensitive substring
   (backend routes/mfg-products.ts:204) — or a code that worked before the
   change would stop finding its row. */

const row = (over: Partial<Parameters<typeof matchesProductQuery>[0]> = {}) => ({
  code: "SF-5540-3S",
  name: "3 Seater Sofa",
  description: "Leather, Chaise",
  barcode: "9551234567890",
  ...over,
});

describe("matchesProductQuery", () => {
  test("matches on code, case-insensitively", () => {
    expect(matchesProductQuery(row(), "sf-5540")).toBe(true);
    expect(matchesProductQuery(row(), "SF-5540")).toBe(true);
  });

  test("matches on name, description and barcode", () => {
    expect(matchesProductQuery(row(), "seater")).toBe(true);
    expect(matchesProductQuery(row(), "chaise")).toBe(true);
    expect(matchesProductQuery(row(), "955123")).toBe(true);
  });

  test("returns false when nothing contains the query", () => {
    expect(matchesProductQuery(row(), "mattress")).toBe(false);
  });

  test("an empty or whitespace query never matches (the >=2-char gate lives in the caller)", () => {
    expect(matchesProductQuery(row(), "")).toBe(false);
    expect(matchesProductQuery(row(), "   ")).toBe(false);
  });

  test("null description and barcode are treated as empty, not crashed on", () => {
    const sparse = row({ description: null, barcode: null });
    expect(matchesProductQuery(sparse, "sofa")).toBe(true); // still hits name
    expect(matchesProductQuery(sparse, "chaise")).toBe(false); // description gone
  });

  test("the query is trimmed before matching", () => {
    expect(matchesProductQuery(row(), "  5540  ")).toBe(true);
  });
});
