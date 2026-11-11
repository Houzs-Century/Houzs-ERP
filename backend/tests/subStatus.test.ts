import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { transitionStage, patchAssrCase, customerPickupOwnTeamDefault } from "../src/services/assr";

// Switchable sub-status (小类, Nick 2026-07-15): entering Verification /
// Supplier seeds the first sub-state, other stages clear it, and a
// direct PATCH switch lands on the timeline as a system event.

const USER_ID = 71;

async function seedCase(id: number, stage: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage) VALUES (?, ?, ?, ?)`
  )
    .bind(id, `ASSR/SUB-${id}`, `SO-SUB-${id}`, stage)
    .run();
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM assr_activity`);
  await env.DB.exec(`DELETE FROM assr_stage_history`);
  await env.DB.exec(`DELETE FROM assr_cases`);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'substatus-test-role')`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, role_id, status) VALUES (?, ?, 1, 'active')`
  )
    .bind(USER_ID, `substatus-test-${USER_ID}@example.com`)
    .run();
});

describe("sub_status stamping on stage transitions", () => {
  test("entering Verification seeds pending_inspection", async () => {
    await seedCase(1, "pending_review");
    const ok = await transitionStage(env, 1, "under_verification" as any, USER_ID);
    expect(ok).toBe(true);
    const row = await env.DB.prepare(
      `SELECT sub_status FROM assr_cases WHERE id = 1`
    ).first<{ sub_status: string | null }>();
    expect(row?.sub_status).toBe("pending_inspection");
  });

  test("entering Supplier seeds pending_customer_pickup (the collect-first leg)", async () => {
    // Nico 2026-09-01: the stage begins by collecting the item FROM the
    // customer, so the customer-pickup leg is the seeded entry point.
    await seedCase(1, "pending_solution");
    await transitionStage(env, 1, "pending_supplier_pickup" as any, USER_ID);
    const row = await env.DB.prepare(
      `SELECT sub_status FROM assr_cases WHERE id = 1`
    ).first<{ sub_status: string | null }>();
    expect(row?.sub_status).toBe("pending_customer_pickup");
  });

  test("leaving a sub-status stage clears the field", async () => {
    await seedCase(1, "under_verification");
    await env.DB.prepare(
      `UPDATE assr_cases SET sub_status = 'qc_issue_result' WHERE id = 1`
    ).run();
    await transitionStage(env, 1, "pending_solution" as any, USER_ID);
    const row = await env.DB.prepare(
      `SELECT sub_status FROM assr_cases WHERE id = 1`
    ).first<{ sub_status: string | null }>();
    expect(row?.sub_status ?? null).toBeNull();
  });
});

describe("direct sub_status switch via PATCH", () => {
  test("stores the new value and logs a system timeline event", async () => {
    await seedCase(1, "under_verification");
    await env.DB.prepare(
      `UPDATE assr_cases SET sub_status = 'pending_inspection' WHERE id = 1`
    ).run();
    const ok = await patchAssrCase(env, 1, { sub_status: "qc_issue_result" }, USER_ID);
    expect(ok).toBe(true);
    const row = await env.DB.prepare(
      `SELECT sub_status FROM assr_cases WHERE id = 1`
    ).first<{ sub_status: string | null }>();
    expect(row?.sub_status).toBe("qc_issue_result");
    const act = await env.DB.prepare(
      `SELECT action, from_value, to_value, category, note FROM assr_activity
        WHERE assr_id = 1 AND action = 'sub_status_change'`
    ).first();
    expect(act).toMatchObject({
      action: "sub_status_change",
      from_value: "pending_inspection",
      to_value: "qc_issue_result",
      category: "system",
    });
  });

  test("no timeline noise when the value doesn't change", async () => {
    await seedCase(1, "under_verification");
    await env.DB.prepare(
      `UPDATE assr_cases SET sub_status = 'pending_inspection' WHERE id = 1`
    ).run();
    await patchAssrCase(env, 1, { sub_status: "pending_inspection" }, USER_ID);
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM assr_activity WHERE assr_id = 1 AND action = 'sub_status_change'`
    ).first<{ n: number }>();
    expect(Number(n?.n ?? 0)).toBe(0);
  });
});

// The customer-pickup leg (collect FROM the customer) is own-team work: unless
// ops has said a supplier collects, it must default to pickup_by='customer' so
// it surfaces on Delivery Planning as a driver job (service-case.md). Without
// this, a case sat on "Pending Customer Pickup" but invisible on the board.

async function pickupBy(id: number): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT pickup_by FROM assr_cases WHERE id = ?`
  ).bind(id).first<{ pickup_by: string | null }>();
  return row?.pickup_by ?? null;
}

describe("customerPickupOwnTeamDefault (pure)", () => {
  test("defaults to own team only on the customer-pickup leg with no owner yet", () => {
    expect(customerPickupOwnTeamDefault("pending_customer_pickup", null)).toBe("customer");
    expect(customerPickupOwnTeamDefault("pending_customer_pickup", "")).toBe("customer");
    expect(customerPickupOwnTeamDefault("pending_customer_pickup", "supplier")).toBeNull();
    expect(customerPickupOwnTeamDefault("pending_customer_pickup", "customer")).toBeNull();
    expect(customerPickupOwnTeamDefault("pending_supplier_pickup", null)).toBeNull();
    expect(customerPickupOwnTeamDefault(null, null)).toBeNull();
  });
});

describe("customer-pickup leg defaults pickup_by to own team", () => {
  test("entering Pickup / Return with no pickup owner sets pickup_by=customer", async () => {
    await seedCase(1, "pending_solution");
    await transitionStage(env, 1, "pending_supplier_pickup" as any, USER_ID);
    expect(await pickupBy(1)).toBe("customer");
  });

  test("entering Pickup / Return never overrides an explicit supplier leg", async () => {
    await seedCase(1, "pending_solution");
    await env.DB.prepare(
      `UPDATE assr_cases SET pickup_by = 'supplier' WHERE id = 1`
    ).run();
    await transitionStage(env, 1, "pending_supplier_pickup" as any, USER_ID);
    expect(await pickupBy(1)).toBe("supplier");
  });

  test("switching the sub-status to customer pickup sets pickup_by=customer", async () => {
    await seedCase(1, "pending_supplier_pickup");
    await env.DB.prepare(
      `UPDATE assr_cases SET sub_status = 'pending_supplier_pickup', pickup_by = NULL WHERE id = 1`
    ).run();
    await patchAssrCase(env, 1, { sub_status: "pending_customer_pickup" }, USER_ID);
    expect(await pickupBy(1)).toBe("customer");
  });

  test("switching to customer pickup never overrides an explicit supplier leg", async () => {
    await seedCase(1, "pending_supplier_pickup");
    await env.DB.prepare(
      `UPDATE assr_cases SET sub_status = 'pending_supplier_pickup', pickup_by = 'supplier' WHERE id = 1`
    ).run();
    await patchAssrCase(env, 1, { sub_status: "pending_customer_pickup" }, USER_ID);
    expect(await pickupBy(1)).toBe("supplier");
  });

  test("an explicit pickup_by in the same request wins over the default", async () => {
    await seedCase(1, "pending_supplier_pickup");
    await env.DB.prepare(
      `UPDATE assr_cases SET sub_status = 'pending_supplier_pickup', pickup_by = NULL WHERE id = 1`
    ).run();
    await patchAssrCase(env, 1, { sub_status: "pending_customer_pickup", pickup_by: "supplier" }, USER_ID);
    expect(await pickupBy(1)).toBe("supplier");
  });
});
