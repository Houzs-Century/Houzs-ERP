import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import intake from "../src/routes/assrFormIntake";

// Sheet status export (Nick 2026-07-14) — the HC Delivery sheet's Apps
// Script pulls this every 10 minutes to rewrite its ASSR STATUS column.
// Pins the X-Intake-Key guard and the stage → sheet-vocabulary mapping
// (the sheet's stats block counts these exact strings).

const KEY = "test-sheet-sync-key";
const authedEnv = { ...env, FORM_INTAKE_KEY: KEY } as typeof env;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM assr_cases WHERE id IN (9101, 9102)`).run();
  await env.DB.prepare(`DELETE FROM assr_activity WHERE assr_id IN (9101, 9102)`).run();
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, ref_no, stage)
     VALUES (9101, 'ASSR/TEST-9101', 'SO-TEST-9101', 'HCTEST01', 'pending_supplier_pickup')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, archived_at)
     VALUES (9102, 'ASSR/TEST-9102', 'SO-TEST-9102', 'completed', datetime('now'))`
  ).run();
});

describe("GET /status-export", () => {
  test("rejects a wrong key with 401", async () => {
    const res = await intake.request(
      "/status-export",
      { headers: { "X-Intake-Key": "wrong" } },
      authedEnv
    );
    expect(res.status).toBe(401);
  });

  test("returns sheet-vocabulary statuses for live cases and skips archived", async () => {
    const res = await intake.request(
      "/status-export",
      { headers: { "X-Intake-Key": KEY } },
      authedEnv
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; cases: any[] };
    const mine = body.cases.find((c) => c.assr_no === "ASSR/TEST-9101");
    expect(mine).toBeTruthy();
    expect(mine.so_no).toBe("SO-TEST-9101");
    expect(mine.ref_no).toBe("HCTEST01");
    // "Pending Supplier Pickup" — the exact string the sheet's stats
    // block counts.
    expect(mine.status).toBe("Pending Supplier Pickup");
    expect(body.cases.find((c) => c.assr_no === "ASSR/TEST-9102")).toBeUndefined();
  });

  test("the own-team pickup leg owns the PICKUP trigger word (owner 2026-09-20)", async () => {
    // pickup_by = 'customer' is the stored value for "our own team collects"
    // (the ERP button reads "Own team pickup"), so the leg emits the
    // parenthesised (Own Team Pickup) word the Delivery PICKUP job fires on.
    // The bare leg exports the stage's bare word, which fires nothing.
    const setSub = (sub: string | null, pickupBy: string | null) =>
      env.DB.prepare(`UPDATE assr_cases SET sub_status = ?, pickup_by = ? WHERE id = 9101`)
        .bind(sub, pickupBy)
        .run();
    const statusOf = async () => {
      const res = await intake.request(
        "/status-export",
        { headers: { "X-Intake-Key": KEY } },
        authedEnv
      );
      const body = (await res.json()) as { cases: any[] };
      return body.cases.find((c) => c.assr_no === "ASSR/TEST-9101")?.status;
    };
    await setSub("pending_customer_pickup", null);
    expect(await statusOf()).toBe("Pending Supplier Pickup");
    await setSub("pending_customer_pickup", "customer");
    expect(await statusOf()).toBe("Pending Supplier Pickup (Own Team Pickup)");
    // The supplier-handover leg stays bare even with pickup_by set — the
    // dispatch job belongs to the customer-collection leg alone.
    await setSub("pending_supplier_pickup", "customer");
    expect(await statusOf()).toBe("Pending Supplier Pickup");
  });

  test("the delivery-back leg reaches the sheet only when Own team delivers (owner 2026-09-20)", async () => {
    // Mirrors the pickup gate: the parenthesised (Own Team) word is the
    // Delivery SERVICE trigger; supplier / not-yet-chosen stays bare and fires
    // nothing, so a supplier / 3PL delivery is never appended to a Delivery tab.
    const setDelivery = (deliveryBy: string | null) =>
      env.DB.prepare(
        `UPDATE assr_cases SET stage = 'pending_delivery_service', sub_status = NULL, delivery_by = ? WHERE id = 9101`
      )
        .bind(deliveryBy)
        .run();
    const statusOf = async () => {
      const res = await intake.request(
        "/status-export",
        { headers: { "X-Intake-Key": KEY } },
        authedEnv
      );
      const body = (await res.json()) as { cases: any[] };
      return body.cases.find((c) => c.assr_no === "ASSR/TEST-9101")?.status;
    };
    // Not yet chosen: the bare seeded word, which the trigger map ignores.
    await setDelivery(null);
    expect(await statusOf()).toBe("Pending Delivery/Service");
    // Own team: the parenthesised trigger word.
    await setDelivery("own");
    expect(await statusOf()).toBe("Pending Delivery/Service (Own Team)");
    // Supplier: its own word, distinct from the trigger, fires nothing.
    await setDelivery("supplier");
    expect(await statusOf()).toBe("Pending Delivery/Service (Supplier)");
  });
});

// Delivery-date write-back (Nico 2026-08-12) — the sheet POSTs each
// scheduled job date back; pins the guard, the job → column map, the
// display-date normalisation, and idempotency.
describe("POST /delivery-dates", () => {
  const post = (key: string, payload: unknown) =>
    intake.request(
      "/delivery-dates",
      {
        method: "POST",
        headers: { "X-Intake-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      authedEnv
    );

  test("rejects a wrong key with 401", async () => {
    const res = await post("wrong", { updates: [{ assr_no: "ASSR/TEST-9101", job: "SERVICE", date: "2026/08/15" }] });
    expect(res.status).toBe(401);
  });

  test("writes each job's date to its column, normalising sheet formats", async () => {
    const res = await post(KEY, {
      updates: [
        { assr_no: "ASSR/TEST-9101", job: "SERVICE", date: "2026/08/15" },
        { assr_no: "ASSR/TEST-9101", job: "INSPECTION", date: "16/08/2026" },
        { assr_no: "ASSR/TEST-9101", job: "PICKUP", date: "2026-08-17" },
        { assr_no: "ASSR/TEST-MISSING", job: "SERVICE", date: "2026/08/15" },
        { assr_no: "ASSR/TEST-9101", job: "NONSENSE", date: "2026/08/15" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    expect(body.results[0]).toMatchObject({ ok: true, sched_delivery_date: "2026-08-15" });
    expect(body.results[1]).toMatchObject({ ok: true, sched_inspection_date: "2026-08-16" });
    expect(body.results[2]).toMatchObject({ ok: true, sched_pickup_date: "2026-08-17" });
    expect(body.results[3]).toMatchObject({ skipped: "no_case" });
    expect(body.results[4]).toMatchObject({ skipped: "bad_input" });

    const row = await env.DB.prepare(
      `SELECT sched_inspection_date, sched_pickup_date, sched_delivery_date FROM assr_cases WHERE id = 9101`
    ).first<any>();
    expect(row.sched_delivery_date).toBe("2026-08-15");
    expect(row.sched_inspection_date).toBe("2026-08-16");
    expect(row.sched_pickup_date).toBe("2026-08-17");

    // A timeline entry lands once per change, tagged system/sheet_sync…
    const acts = await env.DB.prepare(
      `SELECT note, category, source_channel FROM assr_activity WHERE assr_id = 9101 AND source_channel = 'sheet_sync' ORDER BY id`
    ).all<any>();
    expect(acts.results.length).toBe(3);
    expect(acts.results[0].category).toBe("system");
    expect(acts.results[0].note).toContain("SERVICE on 2026-08-15");

    // …and an unchanged re-post is acknowledged without a second entry.
    const res2 = await post(KEY, {
      updates: [{ assr_no: "ASSR/TEST-9101", job: "SERVICE", date: "15/08/2026" }],
    });
    const body2 = (await res2.json()) as { results: any[] };
    expect(body2.results[0]).toMatchObject({ ok: true, unchanged: true });
    const acts2 = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM assr_activity WHERE assr_id = 9101 AND source_channel = 'sheet_sync'`
    ).first<{ n: number }>();
    expect(acts2!.n).toBe(3);
  });
});
