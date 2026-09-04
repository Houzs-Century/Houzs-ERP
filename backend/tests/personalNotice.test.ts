// personalNotice / assrNotify — the system-notice insert path.
//
// Pins the owner 2026-07-20 fixes for the duplicated "reassigned" card:
//   (a) postPersonalNotice de-dupes an identical still-unread notice, so the
//       same event firing twice (retry / bulk+patch / duplicate id) does not
//       add a second card — but a re-notify AFTER an ack still inserts.
//   (b) notifyServiceCaseResponsible NAMES the new responsible person in the
//       title so two distinct reassignments read differently.
//
// Harness mirrors configCache.test.ts: real miniflare D1 + a minimal mirror of
// the pg-only announcements tables (the columns the insert path touches).

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { postPersonalNotice } from "../src/services/personalNotice";
import { notifyServiceCaseResponsible } from "../src/services/assrNotify";

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS announcements (
       id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
       expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
       updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
       target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
       target_user_ids TEXT, target_company_ids TEXT, category TEXT,
       source TEXT, company_id INTEGER)`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS announcement_acks (
       announcement_id TEXT, user_id INTEGER, acked_at TEXT, company_id INTEGER,
       PRIMARY KEY (announcement_id, user_id))`,
  ).run();
  // users already exists in the D1 test tree (schema.sql + migrations, incl.
  // manager_id) — email + role_id are NOT NULL, so seed those.
});

async function countBy(source: string, title: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM announcements WHERE source = ? AND title = ?`,
  )
    .bind(source, title)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

describe("postPersonalNotice — idempotency", () => {
  test("two identical unread notices collapse to one (target order irrelevant)", async () => {
    const source = "service_case";
    const title = "Service case ASSR/2607-040 reassigned to Nancy";
    await postPersonalNotice(env as never, { userIds: [11, 22], category: "GENERAL", title, body: "first", source });
    // Same target set in the OTHER order — canonical sort makes it a dup.
    await postPersonalNotice(env as never, { userIds: [22, 11], category: "GENERAL", title, body: "second", source });
    expect(await countBy(source, title)).toBe(1);
  });

  test("a re-notify AFTER an ack inserts again (not suppressed forever)", async () => {
    const source = "service_case";
    const title = "Service case ASSR/2607-041 reassigned to Bob";
    await postPersonalNotice(env as never, { userIds: [30], category: "GENERAL", title, body: "b", source });
    const row = await env.DB.prepare(
      `SELECT id FROM announcements WHERE source = ? AND title = ?`,
    )
      .bind(source, title)
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO announcement_acks (announcement_id, user_id, acked_at) VALUES (?, ?, ?)`,
    )
      .bind(row!.id, 30, new Date().toISOString())
      .run();
    await postPersonalNotice(env as never, { userIds: [30], category: "GENERAL", title, body: "b", source });
    expect(await countBy(source, title)).toBe(2);
  });

  test("a different title is never deduped", async () => {
    const source = "service_case";
    const t1 = "Service case ASSR/2607-050 reassigned to X";
    const t2 = "Service case ASSR/2607-050 reassigned to Y";
    await postPersonalNotice(env as never, { userIds: [40], category: "GENERAL", title: t1, body: "b", source });
    await postPersonalNotice(env as never, { userIds: [40], category: "GENERAL", title: t2, body: "b", source });
    expect(await countBy(source, t1)).toBe(1);
    expect(await countBy(source, t2)).toBe(1);
  });
});

describe("notifyServiceCaseResponsible — reassigned title names the PIC", () => {
  test("the new assignee's name is in the title + body", async () => {
    // Nancy has no manager, so the upline audience is just herself.
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, role_id, manager_id) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(90071, "notify-test-nancy@example.test", "Nancy", 1, null)
      .run();
    await notifyServiceCaseResponsible(env as never, {
      reason: "reassigned",
      assrNo: "ASSR/2607-099",
      customerName: "Acme",
      userIds: [90071],
    });
    const row = await env.DB.prepare(
      `SELECT title, body FROM announcements WHERE source = 'service_case' AND title LIKE '%ASSR/2607-099%'`,
    ).first<{ title: string; body: string }>();
    expect(row?.title).toBe("Service case ASSR/2607-099 reassigned to Nancy");
    expect(row?.body).toContain("was reassigned to Nancy");
    expect(row?.body).toContain("MYT");
  });
});
