// The field-identity comparators, held to the property that makes the whole
// section worth reading: a comparator that CANNOT find a planted defect will
// report a clean run over real data.
//
// Two real precedents from go-live day, 2026-09-07, both of which printed a
// confident number from a broken matcher: a bare /SOFA/i test pulled
// accessories into the sofa branch and reported 231 false differences out of
// 240, and a LIMIT 500 reported a drift of 842 as 500. So the SELF_TEST list is
// itself asserted here — not just that it passes, but that each case is
// CAPABLE of failing, which a case written as `expect(true)` is not.
import { describe, expect, it } from "vitest";

import {
  AC_BLANK, AGREE, BOTH_BLANK, CARRIED, DERIVED, DIFFER, ERP_BLANK, FIELD_MAP, NOISE, NOT_CARRIED,
  SELF_TEST, compareValue, dayOf, denoise, runSelfTest, senOf,
} from "../scripts/lib/ac-field-identity.mjs";
import { measurePoDiscount } from "../scripts/lib/ac-field-identity-run.mjs";

describe("the startup self-test", () => {
  it("passes on the shipped comparators", () => {
    expect(runSelfTest()).toEqual([]);
  });

  it("has cases that can actually fail — an always-true case protects nothing", () => {
    // Every case must be a real predicate over the comparators, so a case that
    // returns a constant is a defect in the gate, not a passing gate.
    for (const c of SELF_TEST) {
      expect(typeof c.run).toBe("function");
      expect(c.run.toString()).not.toMatch(/^\s*\(\)\s*=>\s*true\s*$/);
    }
    expect(SELF_TEST.length).toBeGreaterThanOrEqual(8);
  });
});

describe("money", () => {
  it("finds the PO-009948 line discount the ERP flattens away", () => {
    // The book: one unit at RM 1,880 on a line it totals at RM 1,410.
    expect(compareValue(141000, 188000, "sen")).toBe(DIFFER);
  });

  it("does not invent a difference across the ringgit -> sen conversion", () => {
    expect(compareValue("1880.00", 188000, "money")).toBe(AGREE);
    expect(senOf("1880")).toBe(188000);
    expect(senOf("7999.5")).toBe(799950);
  });

  it("treats a zero as a value, never as a blank", () => {
    expect(compareValue(0, 0, "money")).toBe(AGREE);
    expect(compareValue(0, null, "money")).toBe(ERP_BLANK);
  });
});

describe("dates", () => {
  it("reads AutoCount's midnight timestamp and a DATE column as the same day", () => {
    expect(compareValue("2025-04-16 00:00:00", new Date(Date.UTC(2025, 3, 16)), "date")).toBe(AGREE);
    expect(compareValue("2025-04-16 00:00:00", "2025-04-16", "date")).toBe(AGREE);
  });

  it("renders a Date in UTC, so a runner west of Greenwich does not shift every day by one", () => {
    expect(dayOf(new Date(Date.UTC(2025, 3, 16, 0, 0, 0)))).toBe("2025-04-16");
    expect(dayOf(new Date(Date.UTC(2025, 3, 16, 23, 59, 59)))).toBe("2025-04-16");
  });

  it("finds a one-day slip", () => {
    expect(compareValue("2025-04-16 00:00:00", "2025-04-15", "date")).toBe(DIFFER);
  });
});

describe("transport noise vs a real edit", () => {
  it("calls a curly quote, an en dash and a newline what they are — transport, not a spec change", () => {
    expect(compareValue("28”", '28"', "text")).toBe(NOISE);
    expect(compareValue("J9883‑1‑1", "J9883-1-1", "text")).toBe(NOISE);
    expect(compareValue("1 ELT / T\n+ NA", "1 ELT / T + NA", "text")).toBe(NOISE);
    expect(compareValue("COL: PAMA", "COL: PAMA", "text")).toBe(NOISE);
  });

  it("still calls a changed build a difference", () => {
    expect(compareValue("1 ELT / T + NA", "1 ELT / T + 2ER", "text")).toBe(DIFFER);
    expect(compareValue("(28\")", '(30")', "text")).toBe(DIFFER);
  });

  it("does NOT fold case — the importers copy verbatim, so a case change is a change", () => {
    expect(compareValue("TAY HAN HONG", "Tay Han Hong", "text")).toBe(DIFFER);
  });

  it("denoise touches only glyphs and whitespace, never a word", () => {
    expect(denoise("  A   B  ")).toBe("A B");
    expect(denoise("ABC")).toBe("ABC");
    expect(denoise("")).toBe(null);
  });
});

describe("the four buckets the owner asked for are told apart", () => {
  it("never collapses a blank direction into 'agree'", () => {
    expect(compareValue("SO-000013", null, "text")).toBe(ERP_BLANK);
    expect(compareValue(null, "SO-000013", "text")).toBe(AC_BLANK);
    expect(compareValue(null, null, "text")).toBe(BOTH_BLANK);
    expect(compareValue("   ", "", "text")).toBe(BOTH_BLANK);
  });
});

describe("the field map is taken from the writers, not invented", () => {
  it("every field cites the importer line that writes it", () => {
    for (const [t, spec] of Object.entries(FIELD_MAP)) {
      for (const f of [...spec.header, ...spec.line]) {
        expect(f.writer, `${t}.${f.key} has no writer citation`).toBeTruthy();
        expect([CARRIED, DERIVED, NOT_CARRIED]).toContain(f.status);
        expect(typeof f.ac).toBe("function");
      }
    }
  });

  it("a CARRIED field always names an ERP column, and a NOT_CARRIED one says in words that no importer writes it", () => {
    // NOT_CARRIED is a statement about the WRITERS, not about the schema. The
    // ERP may well have the column (mfg_sales_orders.attention does) — the
    // finding is that no importer ever puts the book's value in it, which is
    // precisely why the field is still READ: an empty column next to a filled
    // book field is the whole point of the row.
    for (const spec of Object.values(FIELD_MAP)) {
      for (const f of [...spec.header, ...spec.line]) {
        if (f.status === CARRIED) expect(f.erp, `${f.key} claims to be copied but names no column`).toBeTruthy();
        if (f.status === NOT_CARRIED) {
          expect(f.writer, `${f.key} is NOT_CARRIED but does not say so`).toMatch(/NO importer|not carried|no ERP column|no importer writes it/i);
        }
      }
    }
  });

  it("covers the fields the owner named — agent, addresses, dates, remarks, UDFs", () => {
    const soKeys = new Set(FIELD_MAP.SO.header.map((f) => f.key));
    for (const k of ["salesAgent", "debtorCode", "debtorName", "attention", "phone", "invAddr1", "delivAddr1",
      "ref", "creditTerm", "currency", "salesLocation", "docDate", "delivDate", "procDate",
      "remark2", "remark3", "remark4", "note", "venue", "branding", "toPoNo", "balance", "payment"]) {
      expect(soKeys, `SO header is missing ${k}`).toContain(k);
    }
    const soLine = new Set(FIELD_MAP.SO.line.map((f) => f.key));
    for (const k of ["itemCode", "qty", "unitPrice", "lineTotal", "description", "description2", "lineDeliv"]) {
      expect(soLine, `SO line is missing ${k}`).toContain(k);
    }
  });
});

describe("the PO line discount is measured, not assumed", () => {
  // A hand-built book with exactly one discounted line and one clean one, so
  // the measurement is checkable by eye. PO-009948's real shape: one unit at
  // 1,880 that the book totals at 1,410 — 75%.
  const book = {
    PO: {
      lines: new Map([
        ["PO-009948", [
          { itemKey: "AK-ARMOUR MATT (K)", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 },
          { itemKey: "AK-CLEAN", qty: 2, unitPriceSen: 10000, subTotalSen: 20000 },
        ]],
        ["PO-000001", [{ itemKey: "OUT-OF-SCOPE", qty: 1, unitPriceSen: 50000, subTotalSen: 25000 }]],
      ]),
    },
  };

  it("finds the discounted line and prices it", () => {
    const r = measurePoDiscount(book, new Set(["PO-009948"]));
    expect(r.whole.lines).toBe(2);
    expect(r.whole.docs.size).toBe(2);
    expect(r.inScope.lines).toBe(1);
    expect(r.inScope.sen).toBe(47000); // 1,880.00 - 1,410.00
    expect(r.examples[0].doc).toBe("PO-009948");
  });

  it("leaves an undiscounted line alone", () => {
    const clean = { PO: { lines: new Map([["PO-1", [{ qty: 2, unitPriceSen: 10000, subTotalSen: 20000 }]]]) } };
    expect(measurePoDiscount(clean, new Set(["PO-1"])).whole.lines).toBe(0);
  });

  it("counts a line the book left blank as nothing, rather than as a full-price difference", () => {
    const partial = { PO: { lines: new Map([["PO-1", [{ qty: 1, unitPriceSen: null, subTotalSen: 100 }]]]) } };
    expect(measurePoDiscount(partial, new Set(["PO-1"])).whole.lines).toBe(0);
  });
});
