/* The Sales Invoices grid's columns in AutoCount's shape (si-list-columns.tsx).
 *
 * Owner 2026-09-15: amounts in an export read as raw sen (150000). Every money
 * column the list can show — Outstanding, Total, SO Deposit, Paid and the
 * per-category finance subtotals — must export RINGGIT, while the grid keeps
 * sen for sort and funnel. And a fresh grid leads with AutoCount's columns. */
import { describe, expect, it } from "vitest";
import type { Column } from "../../components/DataTable";
import { SI_DEFAULT_COLUMN_KEYS } from "../../vendor/scm/lib/si-list-export";
import { siGridColumns, type SiColumnRow } from "./si-list-columns";

const SEN_KEYS = [
  "outstanding", "amount", "so_deposit", "paid",
  "mattress_sofa_sen", "bedframe_sen", "accessories_sen", "others_sen", "service_sen",
  "mattress_sofa_cost_sen", "bedframe_cost_sen", "accessories_cost_sen", "others_cost_sen", "service_cost_sen",
  "total_cost_sen", "total_margin_sen",
];
const row: SiColumnRow = { id: "s-1", invoice_number: "HC-SI-2609-001", status: "SENT", subtotal_sen: 150000, tax_sen: 600, total_sen: 150600 };
const erp = (key: string): Column<SiColumnRow> => ({ key, label: key, getValue: () => 150000, render: () => null });

describe("siGridColumns", () => {
  const cols = siGridColumns<SiColumnRow>([...SEN_KEYS, "invoice_number", "invoice_date", "debtor_code", "debtor_name", "status"].map(erp));
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
  });

  it("leads with AutoCount's columns in order, everything else hidden in the chooser", () => {
    expect(cols.slice(0, SI_DEFAULT_COLUMN_KEYS.length).map((c) => c.key)).toEqual([...SI_DEFAULT_COLUMN_KEYS]);
    for (const c of cols.slice(0, SI_DEFAULT_COLUMN_KEYS.length)) expect(c.defaultHidden, c.key).toBeFalsy();
    for (const c of cols.slice(SI_DEFAULT_COLUMN_KEYS.length)) expect(c.defaultHidden, c.key).toBe(true);
  });
});
