import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  issueSalesToken,
  issueStaffToken,
  resolveTrackToken,
} from "../src/services/caseTracking";

// Sales portal tokens (mig 111): source='sales' rides the same
// case_track_tokens table as customer/staff links; the portal renders
// the salesperson variant for it. These tests pin the token lifecycle
// and the relaxed source CHECKs on the activity/attachment tables.

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM case_track_tokens`);
  await env.DB.exec(`DELETE FROM assr_activity`);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO assr_cases (id, assr_no, doc_no, stage)
     VALUES (9001, 'ASSR/TEST-9001', 'SO-TEST-9001', 'pending_review')`
  ).run();
});

describe("sales portal tokens", () => {
  test("issue + resolve round-trip carries source='sales'", async () => {
    const token = await issueSalesToken(env, 9001);
    const tc = await resolveTrackToken(env, token);
    expect(tc).not.toBeNull();
    expect(tc!.assr_id).toBe(9001);
    expect(tc!.source).toBe("sales");
  });

  test("idempotent per case — second issue returns the same token", async () => {
    const a = await issueSalesToken(env, 9001);
    const b = await issueSalesToken(env, 9001);
    expect(b).toBe(a);
  });

  test("sales and staff tokens are separate namespaces", async () => {
    const sales = await issueSalesToken(env, 9001);
    const staff = await issueStaffToken(env, 9001);
    expect(staff).not.toBe(sales);
    expect((await resolveTrackToken(env, staff))!.source).toBe("staff");
    expect((await resolveTrackToken(env, sales))!.source).toBe("sales");
  });

  test("activity + attachment rows accept source='sales' (relaxed CHECK)", async () => {
    await env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, note, source)
       VALUES (9001, 'sales_comment', 'checking for my customer', 'sales')`
    ).run();
    const act = await env.DB.prepare(
      `SELECT action, source FROM assr_activity WHERE assr_id = 9001`
    ).first<{ action: string; source: string }>();
    expect(act).toEqual({ action: "sales_comment", source: "sales" });

    await env.DB.prepare(
      `INSERT INTO assr_attachments (assr_id, r2_key, category, source)
       VALUES (9001, 'assr/9001/evidence-test.jpg', 'evidence', 'sales')`
    ).run();
    const att = await env.DB.prepare(
      `SELECT source FROM assr_attachments WHERE assr_id = 9001`
    ).first<{ source: string }>();
    expect(att!.source).toBe("sales");
  });
});
