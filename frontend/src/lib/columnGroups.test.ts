import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLUMN_GROUPS, inferColumnGroup } from "./columnGroups";

/* ────────────────────────────────────────────────────────────────────────────
   Column grouping is DERIVED (owner 2026-08-02: 全部 column 都要像 sales order
   column 那样分类), so these tests do the two jobs hand-annotation would have
   done by hand:

     1. COVERAGE — re-extract the app's real column vocabulary from every list
        page and fail if too much of it lands ungrouped. A new family of
        columns can't quietly pile up in "Other".
     2. CORRECTNESS — a curated sample where the RIGHT answer is obvious.
        Coverage alone would be satisfied by putting everything in one group.
   ──────────────────────────────────────────────────────────────────────────── */

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (path.endsWith(".tsx") && !path.includes(".test.")) out.push(path);
  }
  return out;
}

/** Every (key, label) declared by a page that renders a list table. */
function columnVocabulary(): Array<[string, string]> {
  const pairs = new Map<string, [string, string]>();
  for (const file of listFiles("src")) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("tableId=") && !source.includes("storageKey=")) continue;
    for (const pattern of [
      /key:\s*['"]([a-z0-9_.:]+)['"],\s*\n?\s*label:\s*['"]([^'"]+)['"]/g,
      /key:\s*['"]([a-z0-9_.:]+)['"],\s*label:\s*['"]([^'"]+)['"]/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        pairs.set(`${match[1]}|${match[2]}`, [match[1]!, match[2]!]);
      }
    }
  }
  return [...pairs.values()];
}

describe("column grouping", () => {
  it("classifies the overwhelming majority of the app's real columns", () => {
    const vocabulary = columnVocabulary();
    // Guard the guard: if the extraction breaks, coverage would pass vacuously.
    expect(vocabulary.length).toBeGreaterThan(300);

    const ungrouped = vocabulary.filter(([key, label]) => !inferColumnGroup(key, label));
    const coverage = 1 - ungrouped.length / vocabulary.length;

    // 90% is the bar the rules were tuned to. What is left is genuinely
    // one-off ("Matrix", "Modules", "Spare") — columns whose group would be
    // invented rather than inferred, and which the drawer leaves ungrouped.
    expect(coverage).toBeGreaterThan(0.9);
  });

  it("puts the obvious columns where a person would put them", () => {
    const cases: Array<[string, string, string]> = [
      // Cost & margin wins over money — "Total Cost" is a cost first.
      ["total_cost_sen", "Total Cost", COLUMN_GROUPS.costs],
      ["margin_pct_basis", "Margin %", COLUMN_GROUPS.costs],
      ["cogs", "COGS (RM)", COLUMN_GROUPS.costs],
      ["unit_cost", "Unit Cost", COLUMN_GROUPS.costs],

      ["amount", "Amount", COLUMN_GROUPS.amounts],
      ["balance", "Balance", COLUMN_GROUPS.amounts],
      ["paid", "Paid", COLUMN_GROUPS.amounts],
      ["deposit_sen", "Deposit", COLUMN_GROUPS.amounts],
      ["payment_method", "Payment Method", COLUMN_GROUPS.amounts],

      ["customer_delivery_date", "Delivery Date", COLUMN_GROUPS.logistics],
      ["warehouse", "Warehouse", COLUMN_GROUPS.logistics],
      ["driver", "Driver", COLUMN_GROUPS.logistics],
      ["eta", "ETA", COLUMN_GROUPS.logistics],
      ["stock_status", "Stock Status", COLUMN_GROUPS.logistics],
      ["venue", "Venue", COLUMN_GROUPS.logistics],

      ["qty_on_hand", "Qty On Hand", COLUMN_GROUPS.stock],
      ["uom", "UOM", COLUMN_GROUPS.stock],
      ["sku", "SKU", COLUMN_GROUPS.stock],
      ["item_code", "Item Code", COLUMN_GROUPS.stock],

      ["debtor_name", "Customer", COLUMN_GROUPS.party],
      ["phone", "Phone", COLUMN_GROUPS.party],
      ["address1", "Address 1", COLUMN_GROUPS.party],
      ["postcode", "Postcode", COLUMN_GROUPS.party],
      ["supplier_code", "Supplier Code", COLUMN_GROUPS.party],

      ["salesperson", "Salesperson", COLUMN_GROUPS.people],
      ["role", "Role", COLUMN_GROUPS.people],
      ["reports_to", "Reports to", COLUMN_GROUPS.people],

      ["doc_no", "Doc No.", COLUMN_GROUPS.basic],
      ["so_date", "Date", COLUMN_GROUPS.basic],
      ["status", "Status", COLUMN_GROUPS.basic],
      ["reference", "Reference", COLUMN_GROUPS.basic],
      ["branding", "Branding", COLUMN_GROUPS.basic],
      ["note", "Note", COLUMN_GROUPS.basic],
    ];

    const wrong = cases
      .map(([key, label, expected]) => ({
        key,
        label,
        expected,
        actual: inferColumnGroup(key, label),
      }))
      .filter((c) => c.actual !== c.expected);

    expect(wrong).toEqual([]);
  });

  it("leaves a column it cannot place ungrouped rather than guessing", () => {
    expect(inferColumnGroup("zzz", "Matrix")).toBeUndefined();
    expect(inferColumnGroup("qqq", "Modules")).toBeUndefined();
  });
});
