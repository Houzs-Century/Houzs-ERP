// Per-department reminders (mig 20260906T0921, owner 2026-09-06 "做抽屉按部门
// Remind"): POST /:id/remind { departmentId } writes one announcement_reminders
// row per pending member of THAT department and leaves the notice-level
// reminded_at alone, so
//   · /:id/acks paints only those people "reminded";
//   · the banner re-pops only for them (a reader who acked before the
//     reminder drops out of ackedIds; a reader in another department stays);
//   · a whole-notice reminder still stamps reminded_at and writes rows for
//     everyone pending; scope:"all" clears receipts and stamps only.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";

const state = { user: undefined as unknown };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/announcements", announcementRoutes);

const MANAGER = {
  id: 900,
  department_id: null,
  position_id: null,
  position_name: null,
  permissions: ["announcements.write"],
  permissions_set: new Set(["announcements.write"]),
};
const reader = (id: number, department_id: number | null) => ({
  id,
  department_id,
  position_id: null,
  position_name: null,
  permissions: [] as string[],
  permissions_set: new Set<string>(),
});
async function call(user: unknown, path: string, init?: RequestInit) {
  state.user = user;
  const res = await app.request(path, init, env as never);
  return { status: res.status, body: (await res.json()) as any };
}
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
async function reminderRows(id: string) {
  const res = await env.DB.prepare(
    "SELECT user_id, reminded_by FROM announcement_reminders WHERE announcement_id = ? ORDER BY user_id",
  )
    .bind(id)
    .all<{ user_id: number; reminded_by: number | null }>();
  return res.results;
}
async function noticeStamp(id: string) {
  return (
    await env.DB.prepare("SELECT reminded_at FROM announcements WHERE id = ?")
      .bind(id)
      .first<{ reminded_at: string | null }>()
  )?.reminded_at ?? null;
}

describe("announcements — per-department reminders", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER, require_ack INTEGER, scheduled_at TEXT,
         target_divisions TEXT, excluded_user_ids TEXT, escalated_at TEXT,
         approval_status TEXT, submitted_by INTEGER, submitted_at TEXT, reviewed_by INTEGER,
         reviewed_at TEXT, reject_reason TEXT, ref_no TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT,
         company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_reminders (
         announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, reminded_at TEXT NOT NULL,
         reminded_by INTEGER, PRIMARY KEY (announcement_id, user_id))`,
    ).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT, permissions TEXT)`).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role_id INTEGER, status TEXT,
         department_id INTEGER, position_id INTEGER, manager_id INTEGER, division TEXT)`,
    ).run();
    try { await env.DB.prepare("ALTER TABLE users ADD COLUMN division TEXT").run(); } catch { /* already there */ }
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY, slug TEXT, name TEXT)`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO departments (id, name) VALUES (50, 'Sales'), (51, 'Warehouse')`).run();
    const users: Array<[number, string, number]> = [
      [901, "Siti Aminah", 51],
      [902, "Ravi Kumaran", 51],
      [903, "Cheah Mei Ling", 50],
      [904, "Wong Kah Seng", 50],
    ];
    for (const [id, name, dept] of users) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO users (id, email, name, password_hash, role_id, status, department_id, position_id, manager_id)
         VALUES (?, ?, ?, 'x', 1, 'active', ?, NULL, NULL)`,
      )
        .bind(id, `${id}@example.my`, name, dept)
        .run();
    }
    const old = new Date(Date.now() - 86_400_000).toISOString();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO announcements (id, title, body, is_active, created_by, created_at, target_type, target_dept_ids, category, require_ack)
       VALUES ('rem-1', 'Bin freeze', 'b', 1, 900, ?, 'DEPARTMENT_IDS', '[50,51]', 'WARNING', 1)`,
    )
      .bind(old)
      .run();
    // Siti (Warehouse) and Cheah (Sales) acked yesterday; Ravi and Wong have not.
    for (const uid of [901, 903]) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO announcement_acks (announcement_id, user_id, acked_at) VALUES ('rem-1', ?, ?)`,
      )
        .bind(uid, old)
        .run();
    }
  });

  test("departmentId reminds only that department's pending people; the notice stamp stays NULL", async () => {
    const r = await call(MANAGER, "/api/announcements/rem-1/remind", json("POST", { scope: "unacked", departmentId: 51 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, pendingCount: 1, scope: "unacked", departmentId: 51 });
    expect(await reminderRows("rem-1")).toEqual([{ user_id: 902, reminded_by: 900 }]);
    expect(await noticeStamp("rem-1")).toBeNull();

    const acks = await call(MANAGER, "/api/announcements/rem-1/acks");
    const byId = new Map(acks.body.data.pending.map((p: { id: number; state: string; remindedAt: string | null }) => [p.id, p]));
    expect((byId.get(902) as any).state).toBe("reminded");
    expect((byId.get(902) as any).remindedAt).toBeTruthy();
    expect((byId.get(904) as any).state).toBe("pending");
    expect((byId.get(904) as any).remindedAt).toBeNull();
  });

  test("the banner re-pops only for the reminded people: a reader who acked earlier in that department drops out of ackedIds", async () => {
    // Siti (Warehouse) acked BEFORE the department reminder, but the reminder
    // only covered the pending (Ravi), so Siti keeps her ack.
    const siti = await call(reader(901, 51), "/api/announcements/banner");
    expect(siti.body.ackedIds).toContain("rem-1");
    // Now a whole-notice reminder: rows for everyone pending + the notice stamp.
    const r = await call(MANAGER, "/api/announcements/rem-1/remind", json("POST", { scope: "unacked" }));
    expect(r.body).toMatchObject({ pendingCount: 2, departmentId: null });
    expect((await reminderRows("rem-1")).map((x) => x.user_id)).toEqual([902, 904]);
    expect(await noticeStamp("rem-1")).toBeTruthy();
    // The notice-level stamp is newer than Siti's ack → she is re-popped,
    // exactly as before this change.
    const sitiAgain = await call(reader(901, 51), "/api/announcements/banner");
    expect(sitiAgain.body.ackedIds).not.toContain("rem-1");
    const mine = sitiAgain.body.data.find((a: { id: string }) => a.id === "rem-1");
    expect(mine.remindedAt).toBeTruthy();
  });

  test("a second department reminder upserts the same row (latest instant, no duplicate)", async () => {
    const before = await reminderRows("rem-1");
    const r = await call(MANAGER, "/api/announcements/rem-1/remind", json("POST", { departmentId: 51 }));
    expect(r.body).toMatchObject({ pendingCount: 1, departmentId: 51 });
    expect(await reminderRows("rem-1")).toEqual(before);
  });

  test("scope:'all' clears the receipts and stamps the notice only", async () => {
    const r = await call(MANAGER, "/api/announcements/rem-1/remind", json("POST", { scope: "all" }));
    expect(r.body).toMatchObject({ success: true, pendingCount: 4, scope: "all", departmentId: null });
    const acks = await env.DB.prepare("SELECT COUNT(*) AS n FROM announcement_acks WHERE announcement_id = 'rem-1'").first<{ n: number }>();
    expect(acks?.n).toBe(0);
  });
});
