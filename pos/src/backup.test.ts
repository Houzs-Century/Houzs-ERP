import { describe, expect, test } from "vitest";
import { backupFileName, decryptBackup, encryptBackup, tokenHash } from "./backup";
import type { SaleRecord } from "./sale";

const sale = (over: Partial<SaleRecord>): SaleRecord => ({
  uuid: "u1", type: "SALE", ref_sale_uuid: null, ref_receipt_no: null, receipt_no: "T02-000001", terminal_code: "T02", project_id: 9, cashier_id: 1, cashier_name: "A",
  salesman_id: null, salesman_name: null, customer_name: null, customer_phone: null, sold_at: "2026-10-14T06:00:00Z", subtotal_sen: 100, item_discount_sen: 0, bill_discount_sen: 0,
  sst_applied: false, sst_rate: 0, sst_amount_sen: 0, rounding_sen: 0, total_sen: 100, status: "PAID", void_reason: null, void_by: null, voided_at: null, is_test: false, local_seq: 1,
  lines: [], payments: [], synced_at: null, sync_error: null, returned: null, ...over,
});

describe("backup", () => {
  test("round-trips under the token hash, drops test sales, and refuses another terminal's key", async () => {
    const h = await tokenHash("a".repeat(64));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const file = await encryptBackup([sale({}), sale({ uuid: "u2", is_test: true }), sale({ uuid: "u3", status: "VOID" })], { terminal: "T02", project_id: 9, receipt_counter: 3 }, h);
    expect(file.count).toBe(2);
    expect(file.total_sen).toBe(100);
    expect(backupFileName(file.terminal)).toBe("houzs_pos_T02_backup.json");
    expect(JSON.stringify(file)).not.toContain("T02-000001");
    const back = await decryptBackup(file, h);
    expect(back.map((s) => s.uuid)).toEqual(["u1", "u3"]);
    await expect(decryptBackup(file, await tokenHash("b".repeat(64)))).rejects.toBeTruthy();
  });
});
