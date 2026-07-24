import { describe, expect, test } from "vitest";
import { parseFromSosNote } from "../src/scm/routes/document-flow";
import { buildSkuOrigins } from "../src/scm/routes/po-so-coverage";

// The owner's bug (2026-07-24 → refined 2026-07-25): a PO RAISED from a Sales
// Order showed "Floating stock — not yet assigned to a Sales Order", because the
// old view recomputed a floating MRP pool instead of reading the PO's stored
// origin. These tests pin the two pure pieces of the real-origin resolver:
//   parseFromSosNote — extract the source SO doc numbers from a PO's note
//   buildSkuOrigins  — match the PO's SKUs to those SOs' lines + delivery date

describe("parseFromSosNote", () => {
  test("extracts the SO doc numbers a bulk PO records in its note", () => {
    expect(parseFromSosNote("From SOs: SO-2606-033, SO-2606-034"))
      .toEqual(["SO-2606-033", "SO-2606-034"]);
    // No space after the comma is how the writer can emit it too.
    expect(parseFromSosNote("From SOs: SO-2606-033,SO-2606-034"))
      .toEqual(["SO-2606-033", "SO-2606-034"]);
  });

  test("accepts the singular 'From SO:' label and de-dupes", () => {
    expect(parseFromSosNote("From SO: SO-9")).toEqual(["SO-9"]);
    expect(parseFromSosNote("From SOs: SO-1, SO-1, SO-2")).toEqual(["SO-1", "SO-2"]);
  });

  test("a plain note with no 'From SOs:' label, or empty input, yields nothing", () => {
    expect(parseFromSosNote("Deliver to loading bay 3")).toEqual([]);
    expect(parseFromSosNote("")).toEqual([]);
    expect(parseFromSosNote(null)).toEqual([]);
    expect(parseFromSosNote(undefined)).toEqual([]);
  });
});

describe("buildSkuOrigins", () => {
  const hdr = (doc_no: string, over: Partial<{ customer_delivery_date: string | null; amended_delivery_date: string | null }> = {}) =>
    ({ doc_no, customer_delivery_date: null, amended_delivery_date: null, ...over });

  test("a PO raised from an SO returns its REAL origin SO + effective delivery date", () => {
    const origins = buildSkuOrigins(
      ["BF-15"],
      [hdr("SO-2606-033", { customer_delivery_date: "2026-08-01" })],
      [{ doc_no: "SO-2606-033", item_code: "BF-15" }],
    );
    expect(origins).toEqual([
      { itemCode: "BF-15", assignments: [{ soDocNo: "SO-2606-033", deliveryDate: "2026-08-01" }] },
    ]);
    // The regression this fixes: it must NOT be empty / "not yet assigned".
    expect(origins.length).toBeGreaterThan(0);
  });

  test("amended_delivery_date wins over customer_delivery_date (effective date)", () => {
    const origins = buildSkuOrigins(
      ["MAT-7"],
      [hdr("SO-1", { customer_delivery_date: "2026-08-01", amended_delivery_date: "2026-09-15" })],
      [{ doc_no: "SO-1", item_code: "MAT-7" }],
    );
    expect(origins[0].assignments[0].deliveryDate).toBe("2026-09-15");
  });

  test("a genuine stock PO with no matching origin SO yields NO assignment (UI shows a dash)", () => {
    // The SKU on the PO is absent from every candidate SO line → not returned.
    expect(buildSkuOrigins(["STOCK-99"], [hdr("SO-1")], [{ doc_no: "SO-1", item_code: "BF-15" }]))
      .toEqual([]);
    // And no candidate SOs at all (a true floating buy) → empty.
    expect(buildSkuOrigins(["BF-15"], [], [])).toEqual([]);
  });

  test("one SKU raised across two SOs lists both, earliest delivery date first", () => {
    const origins = buildSkuOrigins(
      ["BF-15"],
      [
        hdr("SO-A", { customer_delivery_date: "2026-08-10" }),
        hdr("SO-B", { customer_delivery_date: "2026-08-02" }),
      ],
      [
        { doc_no: "SO-A", item_code: "BF-15" },
        { doc_no: "SO-B", item_code: "BF-15" },
      ],
    );
    expect(origins[0].assignments.map((a) => a.soDocNo)).toEqual(["SO-B", "SO-A"]);
  });

  test("null-safe on undefined inputs", () => {
    expect(buildSkuOrigins(undefined as never, undefined as never, undefined as never)).toEqual([]);
  });
});
