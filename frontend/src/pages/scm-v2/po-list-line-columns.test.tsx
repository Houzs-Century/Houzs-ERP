/* Sister review P15: the PO list's Item Code column showed "—" for a line with
 * no supplier SKU. It shows the supplier's code when there is one, else ours. */
import { describe, expect, it } from "vitest";
import { poLineColumns, type PoGridRow } from "./po-list-line-columns";
import type { PoListLine } from "../../vendor/scm/lib/po-line-export-columns";

const line = (over: Partial<PoListLine>): PoListLine => ({ item_code: "BF-100", supplier_sku: null, ...over }) as PoListLine;
const row = (lines: PoListLine[]) => ({ id: "po-1", lines }) as unknown as PoGridRow;

describe("PO list Item Code column", () => {
  const col = poLineColumns().item_code!;

  it("falls back to our item code when the line has no supplier SKU", () => {
    const l = line({ supplier_sku: null });
    expect(col.lineValue!(row([l]), l)).toBe("BF-100");
    expect(col.getValue!(row([l]))).toBe("BF-100");
  });

  it("treats a blank supplier SKU as missing", () => {
    const l = line({ supplier_sku: "   " });
    expect(col.lineValue!(row([l]), l)).toBe("BF-100");
  });

  it("keeps the supplier's own code when the binding has one", () => {
    const l = line({ supplier_sku: "AK-BF (Q)" });
    expect(col.lineValue!(row([l]), l)).toBe("AK-BF (Q)");
  });
});
