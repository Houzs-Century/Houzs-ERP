/* Regression: CSV exports wrote a cell starting with = + - @ TAB or CR as-is,
   so text a customer typed on the portal (=HYPERLINK(...)) ran as a formula
   when staff opened the export in Excel. Such cells now get a leading single
   quote; plain numbers, negatives included, stay numeric; parseCSV undoes the
   prefix so an exported sheet re-imports unchanged. */
import { describe, expect, test } from "vitest";
import { guardFormula, parseCSV, toCSV, type CSVColumn } from "./csv";

describe("guardFormula", () => {
  test("formula starters become text", () => {
    expect(guardFormula('=HYPERLINK("http://x","click")')).toBe('\'=HYPERLINK("http://x","click")');
    expect(guardFormula("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(guardFormula("-2+3")).toBe("'-2+3");
    expect(guardFormula("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
    expect(guardFormula("\t=1+1")).toBe("'\t=1+1");
    expect(guardFormula("\r=1+1")).toBe("'\r=1+1");
    expect(guardFormula("-")).toBe("'-");
  });

  test("plain numbers, negatives included, stay numeric", () => {
    for (const n of ["-12.50", "-0.5", "-.5", "+3", "-1,234.50", "-1000", "12.50", "0"]) {
      expect(guardFormula(n), n).toBe(n);
    }
  });

  test("ordinary text is untouched", () => {
    expect(guardFormula("Sofa 3-seater")).toBe("Sofa 3-seater");
    expect(guardFormula("")).toBe("");
    expect(guardFormula("a=b")).toBe("a=b");
  });
});

describe("toCSV + parseCSV", () => {
  type Row = { name: string; amount: number | string };
  const cols: CSVColumn<Row>[] = [
    { key: "name", label: "Name", getValue: (r) => r.name },
    { key: "amount", label: "Amount", getValue: (r) => r.amount },
  ];

  test("an injected cell is neutralised in the file, a negative amount is not", () => {
    const csv = toCSV([{ name: "=1+1", amount: -12.5 }, { name: "Ali", amount: "-1,234.50" }], cols);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("'=1+1,-12.5");
    expect(lines[2]).toBe('Ali,"-1,234.50"');
  });

  test("a cell starting with CR is quoted so it cannot split the row", () => {
    const csv = toCSV([{ name: "\rx", amount: 1 }], cols);
    expect(parseCSV(csv)).toEqual([["Name", "Amount"], ["\rx", "1"]]);
  });

  test("export then import round-trips the original text", () => {
    const rows: Row[] = [
      { name: "=HYPERLINK(\"http://x\")", amount: "-" },
      { name: "@home", amount: "+60 12-345 6789" },
      { name: "'quoted already", amount: "-5" },
    ];
    const parsed = parseCSV(toCSV(rows, cols)).slice(1);
    expect(parsed).toEqual(rows.map((r) => [r.name, String(r.amount)]));
  });
});
