import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { setCaseCreditorManual } from "../src/services/assr";
import { resolveCreditorForCase } from "../src/services/stockItems";

// Manual supplier assignment and its shield against the AutoCount
// auto-resolver: creditor_source='manual' rows must survive
// re-resolution unless the caller forces it (explicit "Resolve now").
//
// Note: the force/auto write path goes through getStockItemCached,
// whose cache-freshness probe uses PG-only SQL (to_char/timezone) that
// the D1 test mirror can't parse — those branches are exercised in
// prod via the existing resolve-creditor route, not here.

async function seedCase(id: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, item_code) VALUES (?, ?, ?, ?)`
  )
    .bind(id, `ASSR/TEST-${id}`, `SO-TEST-${id}`, "ITEM-1")
    .run();
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM assr_activity`);
  await env.DB.exec(`DELETE FROM assr_cases`);
  await env.DB.exec(`DELETE FROM creditors`);
  await env.DB.prepare(
    `INSERT INTO creditors (creditor_code, company_name) VALUES ('400-M001', 'Manual Sofa Works')`
  ).run();
});

describe("setCaseCreditorManual", () => {
  test("links a known creditor and marks the row manual", async () => {
    await seedCase(1);
    const res = await setCaseCreditorManual(env, 1, "400-M001", 7);
    expect(res.ok).toBe(true);
    const row = await env.DB.prepare(
      `SELECT creditor_code, creditor_source FROM assr_cases WHERE id = 1`
    ).first();
    expect(row).toMatchObject({ creditor_code: "400-M001", creditor_source: "manual" });
    const act = await env.DB.prepare(
      `SELECT action, to_value, category FROM assr_activity WHERE assr_id = 1`
    ).first();
    expect(act).toMatchObject({
      action: "creditor_set",
      to_value: "400-M001",
      category: "supplier",
    });
  });

  test("rejects a creditor code that isn't in the mirror", async () => {
    await seedCase(1);
    const res = await setCaseCreditorManual(env, 1, "NOPE-1", null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    const row = await env.DB.prepare(
      `SELECT creditor_code FROM assr_cases WHERE id = 1`
    ).first<{ creditor_code: string | null }>();
    expect(row?.creditor_code ?? null).toBeNull();
  });

  test("404s on a missing case", async () => {
    const res = await setCaseCreditorManual(env, 999, "400-M001", null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  test("clearing unlinks and resets the source so auto-resolve applies again", async () => {
    await seedCase(1);
    await setCaseCreditorManual(env, 1, "400-M001", null);
    const res = await setCaseCreditorManual(env, 1, null, null);
    expect(res.ok).toBe(true);
    const row = await env.DB.prepare(
      `SELECT creditor_code, creditor_source FROM assr_cases WHERE id = 1`
    ).first();
    expect(row).toMatchObject({ creditor_code: null, creditor_source: null });
  });
});

describe("resolveCreditorForCase vs manual picks", () => {
  test("leaves a manual pick alone (returns it without touching AutoCount)", async () => {
    await seedCase(1);
    await setCaseCreditorManual(env, 1, "400-M001", null);
    const out = await resolveCreditorForCase(env, 1, "ITEM-1");
    expect(out.code).toBe("400-M001");
    const row = await env.DB.prepare(
      `SELECT creditor_code, creditor_source FROM assr_cases WHERE id = 1`
    ).first();
    expect(row).toMatchObject({ creditor_code: "400-M001", creditor_source: "manual" });
  });
});
