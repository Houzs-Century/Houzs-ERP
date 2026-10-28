import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { queueEntryChange, summariseChange } from "../src/routes/sales";

// Exercises the sales-entry edit-approval queue (migration 103). A non-manager
// editing a non-draft entry parks the change instead of mutating it; only the
// latest edit stays pending.

async function seedEntry(id: number, status = "submitted"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_entries (id, customer_name, amount, occurred_at, status, created_by)
     VALUES (?, 'Cust', 100, '2026-06-01', ?, 101)`,
  )
    .bind(id, status)
    .run();
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM sales_entry_change_requests`);
  await env.DB.exec(`DELETE FROM sales_entries`);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'approval-test-role')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, role_id, status) VALUES (101, 'approval-test@example.com', 1, 'active')`,
  ).run();
});

describe("sales-entry change-request queue", () => {
  test("summariseChange lists fields with item/payment/custom counts", () => {
    expect(
      summariseChange({ amount: 5, notes: "x", items: [1, 2], payments: [1], custom: { a: 1 } }),
    ).toBe("amount, notes, items(2), payments(1), custom fields");
  });

  test("queueEntryChange parks one pending request carrying the payload", async () => {
    await seedEntry(1);
    const reqId = await queueEntryChange(env, 1, { amount: 200 }, 101);
    const row = await env.DB.prepare(
      `SELECT entry_id, status, payload, requested_by FROM sales_entry_change_requests WHERE id = ?`,
    )
      .bind(reqId)
      .first<{ entry_id: number; status: string; payload: string; requested_by: number }>();
    expect(row?.status).toBe("pending");
    expect(row?.entry_id).toBe(1);
    expect(row?.requested_by).toBe(101);
    expect(JSON.parse(row!.payload)).toEqual({ amount: 200 });
  });

  test("a newer edit supersedes the prior pending request (one live per entry)", async () => {
    await seedEntry(1);
    const first = await queueEntryChange(env, 1, { amount: 200 }, 101);
    const second = await queueEntryChange(env, 1, { amount: 300 }, 101);

    const firstStatus = await env.DB.prepare(
      `SELECT status FROM sales_entry_change_requests WHERE id = ?`,
    )
      .bind(first)
      .first<{ status: string }>();
    const secondStatus = await env.DB.prepare(
      `SELECT status FROM sales_entry_change_requests WHERE id = ?`,
    )
      .bind(second)
      .first<{ status: string }>();
    const pending = await env.DB.prepare(
      `SELECT count(*) AS n FROM sales_entry_change_requests WHERE entry_id = 1 AND status = 'pending'`,
    ).first<{ n: number }>();

    expect(firstStatus?.status).toBe("superseded");
    expect(secondStatus?.status).toBe("pending");
    expect(pending?.n).toBe(1);
  });
});
