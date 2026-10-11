import { describe, expect, it } from "vitest";
import { BUCKETS, classifyOrder, lineKind, parseBuckets, parseDocList, selectForClose } from "../scripts/lib/stale-so-buckets.mjs";

const TODAY = "2026-09-15";
const line = (o = {}) => ({ delivery: "2026-08-01", liveDoLines: 0, liveDoQty: 0, draftDoLines: 0, book: "BOOK_OPEN", ...o });

describe("lineKind", () => {
  it("a DRAFT DO wins over everything: a delivery is being prepared", () => {
    expect(lineKind(line({ draftDoLines: 1, book: "BOOK_DELIVERED", liveDoLines: 1 }))).toBe("DRAFT_DO");
  });
  it("a live DO line at qty 0 is NOT delivered (owner rule 2)", () => {
    expect(lineKind(line({ liveDoLines: 1, liveDoQty: 0 }))).toBe("ON_DO_QTY_ZERO");
  });
  it("a live DO line with qty > 0 that MRP still plans for is partial", () => {
    expect(lineKind(line({ liveDoLines: 1, liveDoQty: 1 }))).toBe("PARTIAL_ON_DO");
  });
  it("book-delivered only counts when the ERP has no DO line for it", () => {
    expect(lineKind(line({ book: "BOOK_DELIVERED" }))).toBe("BOOK_DELIVERED");
    expect(lineKind(line({ book: "BOOK_DELIVERED", liveDoLines: 1 }))).toBe("ON_DO_QTY_ZERO");
  });
});

describe("classifyOrder", () => {
  it("bucket 1, closable only when EVERY planned line is book-delivered", () => {
    const all = classifyOrder({ orderLiveDoQty: 0, lines: [line({ book: "BOOK_DELIVERED" }), line({ book: "BOOK_DELIVERED", delivery: null })] }, TODAY);
    expect(all).toMatchObject({ bucket: BUCKETS.BOOK_DELIVERED, closable: true, bookDeliveredLines: 2 });
    const some = classifyOrder({ orderLiveDoQty: 0, lines: [line({ book: "BOOK_DELIVERED" }), line()] }, TODAY);
    expect(some).toMatchObject({ bucket: BUCKETS.BOOK_DELIVERED, closable: false, bookDeliveredLines: 1 });
  });

  it("bucket 1 ignores the delivery date — the book already delivered it", () => {
    expect(classifyOrder({ orderLiveDoQty: 0, lines: [line({ book: "BOOK_DELIVERED", delivery: "2026-12-01" })] }, TODAY).bucket).toBe(BUCKETS.BOOK_DELIVERED);
  });

  it("bucket 2: any line on a DO at qty 0 keeps the whole order open", () => {
    const r = classifyOrder({ orderLiveDoQty: 3, lines: [line({ liveDoLines: 1 }), line()] }, TODAY);
    expect(r).toMatchObject({ bucket: BUCKETS.DO_QTY_ZERO, closable: false, zeroQtyLines: 1 });
    expect(r.why).toContain("qty 0 = not delivered");
  });

  it("a DRAFT DO on a planned line is never closable", () => {
    expect(classifyOrder({ orderLiveDoQty: 2, lines: [line({ draftDoLines: 1 })] }, TODAY)).toMatchObject({ bucket: BUCKETS.DRAFT_DO, closable: false });
  });

  it("bucket 3: shipped something before, every planned line expired", () => {
    const r = classifyOrder({ orderLiveDoQty: 2, lines: [line({ delivery: "2026-08-01" }), line({ delivery: "2026-09-01" })] }, TODAY);
    expect(r).toMatchObject({ bucket: BUCKETS.HAD_DO_EXPIRED, closable: true, daysOverdue: 14 });
  });

  it("bucket 3 counts a partially delivered line, flagged", () => {
    const r = classifyOrder({ orderLiveDoQty: 1, lines: [line({ liveDoLines: 1, liveDoQty: 1 })] }, TODAY);
    expect(r).toMatchObject({ bucket: BUCKETS.HAD_DO_EXPIRED, partialLines: 1 });
  });

  it("bucket 4: no live DO, every planned line expired", () => {
    expect(classifyOrder({ orderLiveDoQty: 0, lines: [line()] }, TODAY)).toMatchObject({ bucket: BUCKETS.NO_DO_EXPIRED, closable: true, daysOverdue: 45 });
  });

  it("the delivery date equal to today is not expired", () => {
    expect(classifyOrder({ orderLiveDoQty: 0, lines: [line({ delivery: TODAY })] }, TODAY).bucket).toBe(BUCKETS.OUT_OF_SCOPE);
  });

  it("a mix of expired and future lines is out of scope — a header close would take the future line", () => {
    const r = classifyOrder({ orderLiveDoQty: 0, lines: [line(), line({ delivery: "2026-10-01" })] }, TODAY);
    expect(r).toMatchObject({ bucket: BUCKETS.OUT_OF_SCOPE, closable: false });
    expect(classifyOrder({ orderLiveDoQty: 0, lines: [line(), line({ delivery: null })] }, TODAY).bucket).toBe(BUCKETS.OUT_OF_SCOPE);
  });

  it("bucket 5: every planned line undated, never closable", () => {
    expect(classifyOrder({ orderLiveDoQty: 0, lines: [line({ delivery: null })] }, TODAY)).toMatchObject({ bucket: BUCKETS.UNDATED, closable: false, daysOverdue: null });
  });

  it("refuses an order with no planned lines", () => {
    expect(() => classifyOrder({ orderLiveDoQty: 0, lines: [] }, TODAY)).toThrow();
  });
});

describe("inputs", () => {
  it("parseDocList normalises bare numbers and SO- numbers", () => {
    expect(parseDocList("11850, SO-013276\nhc-so-001319 11850")).toEqual(["HC-SO-011850", "HC-SO-013276", "HC-SO-001319"]);
    expect(parseDocList("")).toEqual([]);
  });
  it("parseBuckets refuses the report-only buckets", () => {
    expect(parseBuckets("1, 3")).toEqual(["1", "3"]);
    expect(() => parseBuckets("2")).toThrow(/report-only/);
    expect(() => parseBuckets("5")).toThrow();
  });
});

describe("selectForClose", () => {
  const orders = [
    { doc_no: "A", bucket: "1", closable: true },
    { doc_no: "B", bucket: "1", closable: false },
    { doc_no: "C", bucket: "3", closable: true },
    { doc_no: "D", bucket: "4", closable: true },
    { doc_no: "E", bucket: "2", closable: false },
  ];
  it("selects closable orders of the chosen buckets", () => {
    expect(selectForClose(orders, { buckets: ["1", "3"], docs: [], exclude: [] }).map((o) => o.doc_no)).toEqual(["A", "C"]);
  });
  it("bucket 4 needs an explicit tick", () => {
    expect(selectForClose(orders, { buckets: ["4"], docs: [], exclude: [] })).toEqual([]);
    expect(selectForClose(orders, { buckets: ["4"], docs: ["D"], exclude: [] }).map((o) => o.doc_no)).toEqual(["D"]);
  });
  it("docs restricts and exclude removes", () => {
    expect(selectForClose(orders, { buckets: ["1", "3"], docs: ["C"], exclude: [] }).map((o) => o.doc_no)).toEqual(["C"]);
    expect(selectForClose(orders, { buckets: ["1", "3"], docs: [], exclude: ["A"] }).map((o) => o.doc_no)).toEqual(["C"]);
  });
  it("a not-closable order is never selected, even when ticked", () => {
    expect(selectForClose(orders, { buckets: ["1"], docs: ["B"], exclude: [] })).toEqual([]);
  });
});
