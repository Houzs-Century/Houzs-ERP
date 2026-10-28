import { describe, expect, it } from "vitest";
import { assignBookInvoiceLines, discountForBookAmount } from "../scripts/lib/ac-pi-book-lines.mjs";

/* The rows below are the account book's own, read out of
 * data/ac-reconcile-truth.json.gz (cut 2026-09-09T00:18Z). They are the two
 * shapes the module's header names, so a regression here is a regression
 * against the book and not against a fixture somebody invented. */

const bl = (docNo, dtlKey, seq, itemKey, qty, unitPriceSen, amountSen) =>
  ({ docNo, dtlKey, seq, itemKey, qty, unitPriceSen, amountSen });

describe("assignBookInvoiceLines", () => {
  it("copies the book's line for a plain one-to-one receipt line", () => {
    const { assigned, unbilled, surplus } = assignBookInvoiceLines({
      ourLines: [{ lineId: "a", itemCode: "HOK-2038 (A) (K)", qty: 1 }],
      bookLines: [bl("PI-007171", "111", 1, "HOK-2038 (A) (K)", 1, 85000, 85000)],
    });
    expect(unbilled).toEqual([]);
    expect(surplus).toEqual([]);
    expect(assigned).toHaveLength(1);
    expect(assigned[0].lineId).toBe("a");
    expect(assigned[0].acInvoiceNo).toBe("PI-007171");
    expect(assigned[0].book.amountSen).toBe(85000);
  });

  it("carries the book's amount even when it is NOT qty x unit price", () => {
    /* GR-001910 dtl 410660 is 3 x 32.94 = 98.82 and the book's RECEIPT says
       84.00; PI-002949 dtl 410782 says 83.99. The invoice's figure is the one
       that must reach the ERP. */
    const { assigned } = assignBookInvoiceLines({
      ourLines: [{ lineId: "a", itemCode: "FOAM", qty: 3 }],
      bookLines: [bl("PI-002949", "410782", 1, "FOAM", 3, 3294, 8399)],
    });
    expect(assigned[0].book.amountSen).toBe(8399);
    expect(assigned[0].book.amountSen).not.toBe(3 * 3294);
  });

  it("keeps the price with the right line when one receipt holds the same item at two prices", () => {
    /* GR-003813 really carries HOK-2008(A) (K) at qty 1 @ 920.00 (line 706711)
       AND at qty 2 @ 850.00 (line 706719). On (code, quantity) alone the qty-1
       line took whichever qty-1 invoice line sorted first — the 850.00 one — and
       the 920.00 receipt line came away carrying an 850.00 amount. */
    const { assigned } = assignBookInvoiceLines({
      ourLines: [
        { lineId: "706711", itemCode: "HOK-2008(A) (K)", qty: 1, unitPriceSen: 92000, amountSen: 92000 },
        { lineId: "706719", itemCode: "HOK-2008(A) (K)", qty: 2, unitPriceSen: 85000, amountSen: 170000 },
      ],
      bookLines: [
        bl("PI-006011", "728225", 16, "HOK-2008(A) (K)", 1, 85000, 85000),
        bl("PI-006012", "728240", 80, "HOK-2008(A) (K)", 1, 92000, 92000),
        bl("PI-006012", "728248", 144, "HOK-2008(A) (K)", 1, 85000, 85000),
      ],
    });
    expect(assigned.filter((a) => a.lineId === "706711").map((a) => a.book.dtlKey)).toEqual(["728240"]);
    expect(assigned.filter((a) => a.lineId === "706719").map((a) => a.book.dtlKey).sort())
      .toEqual(["728225", "728248"]);
  });

  it("follows the book when it SPLITS one receipt line across two invoices", () => {
    /* GR-003813 holds 1 x 920 and 2 x 850. PI-006011 bills 1 x 850 and
       PI-006012 bills 1 x 920 + 1 x 850. Our receipt's `2 x 850` row therefore
       becomes TWO invoice lines, on two different invoices. */
    const { assigned, unbilled, surplus } = assignBookInvoiceLines({
      ourLines: [
        { lineId: "nine-twenty", itemCode: "BED-A", qty: 1 },
        { lineId: "two-eight-fifty", itemCode: "BED-B", qty: 2 },
      ],
      bookLines: [
        bl("PI-006011", "1", 1, "BED-B", 1, 85000, 85000),
        bl("PI-006012", "2", 1, "BED-A", 1, 92000, 92000),
        bl("PI-006012", "3", 2, "BED-B", 1, 85000, 85000),
      ],
    });
    expect(unbilled).toEqual([]);
    expect(surplus).toEqual([]);
    const split = assigned.filter((a) => a.lineId === "two-eight-fifty");
    expect(split.map((a) => a.acInvoiceNo).sort()).toEqual(["PI-006011", "PI-006012"]);
    expect(split.reduce((t, a) => t + a.book.qty, 0)).toBe(2);
    expect(assigned.find((a) => a.lineId === "nine-twenty").acInvoiceNo).toBe("PI-006012");
  });

  it("names a receipt line the book's invoices never bill instead of inventing one", () => {
    const { assigned, unbilled } = assignBookInvoiceLines({
      ourLines: [{ lineId: "a", itemCode: "HOK-9999", qty: 1 }],
      bookLines: [bl("PI-000001", "1", 1, "HOK-1111", 1, 100, 100)],
    });
    expect(assigned).toEqual([]);
    expect(unbilled).toHaveLength(1);
    expect(unbilled[0].lineId).toBe("a");
    expect(unbilled[0].why).toMatch(/bill no line of HOK-9999/);
  });

  it("refuses a run that overshoots rather than billing a quantity neither document states", () => {
    const { assigned, unbilled } = assignBookInvoiceLines({
      ourLines: [{ lineId: "a", itemCode: "X", qty: 2 }],
      bookLines: [bl("PI-1", "1", 1, "X", 3, 100, 300)],
    });
    expect(assigned).toEqual([]);
    expect(unbilled[0].why).toMatch(/no run of those adds up to our 2/);
  });

  it("reports what the book bills off the receipt that we do not hold, as surplus and not as a defect", () => {
    /* The cutover carried the OUTSTANDING part of a receipt; the book's invoice
       bills the whole of it. HC-PI-003137 is 1 ERP line against 41 book lines. */
    const { assigned, unbilled, surplus } = assignBookInvoiceLines({
      ourLines: [{ lineId: "a", itemCode: "X", qty: 1 }],
      bookLines: [
        bl("PI-003137", "1", 1, "X", 1, 53000, 53000),
        bl("PI-003137", "2", 2, "Y", 1, 21000, 21000),
        bl("PI-003137", "3", 3, "X", 1, 53000, 53000),
      ],
    });
    expect(assigned).toHaveLength(1);
    expect(unbilled).toEqual([]);
    expect(surplus.map((s) => s.dtlKey).sort()).toEqual(["2", "3"]);
  });

  it("never gives one book line to two RECEIPTS when the caller shares the taken set", () => {
    /* One ERP receipt folds several of the book's, and the fold list is the
       PURCHASE ORDER's — so both ERP receipts under one order list both
       AutoCount receipts. Without a shared set each would bill the same line. */
    const bookLines = [bl("PI-000968", "1", 1, "X", 1, 33000, 33000)];
    const taken = new Set();
    const first = assignBookInvoiceLines({ ourLines: [{ lineId: "a", itemCode: "X", qty: 1 }], bookLines, taken });
    const second = assignBookInvoiceLines({ ourLines: [{ lineId: "b", itemCode: "X", qty: 1 }], bookLines, taken });
    expect(first.assigned).toHaveLength(1);
    expect(second.assigned).toHaveLength(0);
    expect(second.unbilled).toHaveLength(1);
    expect(second.surplus).toEqual([]);
  });

  it("never gives one book line to two receipt lines", () => {
    const { assigned, unbilled } = assignBookInvoiceLines({
      ourLines: [
        { lineId: "a", itemCode: "X", qty: 1 },
        { lineId: "b", itemCode: "X", qty: 1 },
      ],
      bookLines: [bl("PI-1", "solo", 1, "X", 1, 100, 100)],
    });
    expect(assigned).toHaveLength(1);
    expect(unbilled).toHaveLength(1);
    expect(new Set(assigned.map((a) => a.book.dtlKey)).size).toBe(assigned.length);
  });
});

describe("discountForBookAmount", () => {
  it("derives the discount that reconciles the ERP's three columns to the book's amount", () => {
    /* 「如果 25% 的折扣，那你也要跟着 25%」 — 4 x 100.00 billed at 300.00. */
    expect(discountForBookAmount({ qty: 4, unitPriceSen: 10000, amountSen: 30000 }))
      .toEqual({ discountSen: 10000, reconciles: true });
  });

  it("reconciles AutoCount's own rounding of an amount-shaped discount", () => {
    expect(discountForBookAmount({ qty: 3, unitPriceSen: 3294, amountSen: 8399 }))
      .toEqual({ discountSen: 1483, reconciles: true });
  });

  it("refuses to write a surcharge as a negative discount, and says the row does not reconcile", () => {
    const d = discountForBookAmount({ qty: 1, unitPriceSen: 100, amountSen: 150 });
    expect(d.discountSen).toBe(0);
    expect(d.reconciles).toBe(false);
    expect(d.surchargeSen).toBe(50);
  });
});
