import { describe, expect, test } from "vitest";
import { assrExportShowsCost, buildAssrCasesCsv } from "./assr-export-csv";
import type { AuthUser } from "../../services/auth";

const user = (over: Partial<AuthUser>): AuthUser =>
  ({ id: 7, position_id: 3, position_name: null, permissions_set: new Set(["service_cases.read"]), ...over }) as unknown as AuthUser;

const ROW = {
  assr_no: "ASSR-1", doc_no: "SO-1", customer_name: "Tan, Ah Kow", po_amount: "1234.5", po_no: "PO-9", is_breached: 0,
};

const header = (csv: string) => csv.replace(/^﻿/, "").split("\r\n")[0]!.split(",");

describe("Service Cases CSV — the supplier cost column follows the purchase-cost rule (B-13)", () => {
  test("a purchase-cost viewer gets PO Amount, formatted to 2 dp", () => {
    const csv = buildAssrCasesCsv([ROW], true);
    const cols = header(csv);
    expect(cols).toContain("PO Amount");
    const line = csv.split("\r\n")[1]!;
    expect(line).toContain("1234.50");
    expect(line).toContain('"Tan, Ah Kow"');
    expect(csv.startsWith("﻿")).toBe(true);
  });

  test("anyone else still gets the export, without PO Amount and without the amount anywhere", () => {
    const csv = buildAssrCasesCsv([ROW], false);
    const cols = header(csv);
    expect(cols).not.toContain("PO Amount");
    expect(cols).toContain("PO No");
    expect(cols).toHaveLength(23);
    const line = csv.split("\r\n")[1]!;
    expect(line).not.toContain("1234");
    expect(line.split(",")[cols.indexOf("PO No") + 1]).toBe("PO-9"); // +1: the quoted customer name holds a comma
  });

  test("who sees the cost: directors and Purchasing yes, a service-case-only user no", () => {
    expect(assrExportShowsCost(user({ position_name: "Procurement/Purchasing" }))).toBe(true);
    expect(assrExportShowsCost(user({ position_name: "Finance Manager" }))).toBe(true);
    expect(assrExportShowsCost(user({ permissions_set: new Set(["*"]) }))).toBe(true);
    expect(assrExportShowsCost(user({ position_name: "Sales Executive" }))).toBe(false);
    expect(assrExportShowsCost(user({ position_name: "Storekeeper" }))).toBe(false);
    expect(assrExportShowsCost(null)).toBe(false);
  });
});
