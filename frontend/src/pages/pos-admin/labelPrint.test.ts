import { describe, expect, test } from "vitest";
import { expandLabels, labelSheetHtml, labelsTspl, labelsZpl } from "./labelPrint";

const spec = { name: "Akemi Pillow", code: "PL-01", price: "59.90", barcode: "2000000000015", qty: 2 };

describe("labelPrint", () => {
  test("qty expands to one label each, capped", () => {
    expect(expandLabels([spec, { ...spec, qty: 0 }])).toHaveLength(2);
    expect(expandLabels([{ ...spec, qty: 9999 }])).toHaveLength(500);
  });

  test("the A4 sheet carries each label's name, code, price and bars", () => {
    const html = labelSheetHtml([spec]);
    expect(html).toContain("repeat(5, 40mm)");
    expect(html.match(/class="label"/g)).toHaveLength(2);
    expect(html).toContain("Akemi Pillow");
    expect(html).toContain("RM 59.90");
    expect(html).toContain("<svg");
    expect(labelSheetHtml([{ ...spec, barcode: "ABC-123", price: null, qty: 1 }])).toContain('class="raw">ABC-123');
  });

  test("TSPL and ZPL print the EAN-13 natively and Code 128 otherwise", () => {
    const t = labelsTspl([spec]);
    expect(t).toContain('SIZE 40 mm,30 mm');
    expect(t).toContain('"EAN13"');
    expect(t).toContain("PRINT 1,2");
    expect(labelsTspl([{ ...spec, barcode: "ABC-123" }])).toContain('"128"');
    const z = labelsZpl([spec]);
    expect(z).toContain("^BEN,70,Y,N^FD200000000001^FS");
    expect(z).toContain("^PQ2");
    expect(labelsZpl([{ ...spec, barcode: "ABC-123" }])).toContain("^BCN");
  });
});
