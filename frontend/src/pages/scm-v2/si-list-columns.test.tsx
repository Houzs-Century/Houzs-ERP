/* The Sales Invoices grid's columns (si-list-columns.tsx).
 *
 * Owner 2026-09-15: amounts in an export read as raw sen (150000) — money
 * columns must export RINGGIT while the grid keeps sen for sort and funnel. And
 * 「默认跟我的data grid啊」: a fresh grid keeps the list's own columns; AutoCount's
 * columns wait in the chooser, hidden, with AutoCount's values. */
import { describe, expect, it } from "vitest";
import type { Column } from "../../components/DataTable";
import { SI_AC_COLUMN_KEYS, type SiListLine } from "../../vendor/scm/lib/si-list-export";
import { siGridColumns, type SiColumnRow } from "./si-list-columns";

const SEN_KEYS = [
  "outstanding", "amount", "so_deposit", "paid",
  "mattress_sofa_sen", "bedframe_sen", "accessories_sen", "others_sen", "service_sen",
  "mattress_sofa_cost_sen", "bedframe_cost_sen", "accessories_cost_sen", "others_cost_sen", "service_cost_sen",
  "total_cost_sen", "total_margin_sen",
];
const row: SiColumnRow = {
  id: "s-1", invoice_number: "HC-SI-2609-001", linked_ac_docno: "I-2609-001", ac_agent: "Zack", status: "SENT",
  subtotal_sen: 150000, tax_sen: 600, total_sen: 150600,
};
const line = { id: "l-1", ac_item_code: "AK-CODY (K)", unit_price_sen: 150000.5, line_total_sen: 300001 } as unknown as SiListLine;
const erp = (key: string, defaultHidden?: boolean): Column<SiColumnRow> => ({ key, label: key, getValue: () => 150000, render: () => null, defaultHidden });
const ERP = [
  erp("invoice_number"), erp("invoice_date"), erp("debtor_code", true), erp("debtor_name"), erp("status"),
  ...SEN_KEYS.map((k, i) => erp(k, i > 3)),
];

describe("siGridColumns", () => {
  const cols = siGridColumns<SiColumnRow>(ERP);
  const byKey = new Map(cols.map((c) => [c.key, c]));

  it("exports every money column in ringgit, never sen", () => {
    for (const key of [...SEN_KEYS, "subtotal", "tax", "local_total"]) {
      const c = byKey.get(key)!;
      expect(c.exportFormat, key).toBe("money");
      const v = c.exportValue!(row);
      expect(typeof v === "number" && v < 10_000, `${key} exported ${String(v)}`).toBe(true);
    }
    expect(byKey.get("amount")!.exportValue!(row)).toBe(1500);
    expect(byKey.get("subtotal")!.exportValue!(row)).toBe(1500);
    expect(byKey.get("tax")!.exportValue!(row)).toBe(6);
    expect(byKey.get("unit_price")!.lineValue!(row, line)).toBe(1500.005);
    expect(byKey.get("line_total")!.lineValue!(row, line)).toBe(3000.01);
  });

  it("keeps the list's own columns as the default, unchanged and in order", () => {
    expect(cols.slice(0, ERP.length).map((c) => [c.key, c.label, c.defaultHidden])).toEqual(ERP.map((c) => [c.key, c.label, c.defaultHidden]));
  });

  it("offers AutoCount's columns in the chooser, hidden, in AutoCount's order, with AutoCount's values", () => {
    const rest = cols.slice(ERP.length);
    for (const c of rest) expect(c.defaultHidden, c.key).toBe(true);
    const own = new Set(ERP.map((c) => c.key));
    const acKeys = (SI_AC_COLUMN_KEYS as readonly string[]).filter((k) => !own.has(k));
    expect(rest.slice(0, acKeys.length).map((c) => c.key)).toEqual(acKeys);
    expect(byKey.get("ac_doc_no")!.label).toBe("Doc No");
    expect(byKey.get("ac_doc_no")!.getValue!(row)).toBe("I-2609-001");
    expect(byKey.get("agent")!.getValue!(row)).toBe("Zack");
    expect(byKey.get("item_code")!.lineValue!(row, line)).toBe("AK-CODY (K)");
    expect(new Set(cols.map((c) => c.key)).size).toBe(cols.length);
  });
});
