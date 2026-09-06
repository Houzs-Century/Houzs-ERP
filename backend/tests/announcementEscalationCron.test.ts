// The overdue-escalation cron (services/announcementEscalation.ts, owner
// 2026-09-06): a notice that requires acknowledgement, is deliverable and is
// older than the 48h overdue window gets ONE system notice per supervisor of
// its pending people, then escalated_at is stamped so it is never re-notified.
// Young, non-mandatory, hidden, scheduled and already-escalated notices are
// left alone; a second run is a no-op.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { runOverdueEscalation } from "../src/services/announcementEscalation";

const DAY = 86_400_000;
const HOUR = 3_600_000;

async function escalationNotices() {
  const res = await env.DB.prepare(
    `SELECT title, body, target_user_ids FROM announcements WHERE source = 'ack_escalation' ORDER BY created_at ASC, id ASC`,
  ).all<{ title: string; body: string; target_user_ids: string }>();
  return res.results;
}
async function stamp(id: string) {
  return (
    await env.DB.prepare("SELECT escalated_at FROM announcements WHERE id = ?")
      .bind(id)
      .first<{ escalated_at: string | null }>()
  )?.escalated_at ?? null;
}

describe("announcements — overdue escalation cron", () => {
  const NOW = Date.parse("2026-09-06T09:00:00Z");
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
      `CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT, permissions TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role_id INTEGER, status TEXT,
         department_id INTEGER, position_id INTEGER, manager_id INTEGER, division TEXT)`,
    ).run();
    // The D1 test database is built from the D1 mirror migrations, which never
    // carried users.division (PG-only mig 0021); the roster query selects it.
    try { await env.DB.prepare("ALTER TABLE users ADD COLUMN division TEXT").run(); } catch { /* already there */ }
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY, slug TEXT, name TEXT)`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO departments (id, name) VALUES (40, 'Warehouse')`).run();
    // Supervisor 800 first (FK), then two reports; 803 reports to nobody.
    const users: Array<[number, string, number | null, number | null]> = [
      [800, "Tan Boon Hooi", 40, null],
      [801, "Siti Aminah", 40, 800],
      [802, "Ravi Kumaran", 40, 800],
      [803, "Nobody's Report", 40, null],
    ];
    for (const [id, name, dept, mgr] of users) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO users (id, email, name, password_hash, role_id, status, department_id, position_id, manager_id)
         VALUES (?, ?, ?, 'x', 1, 'active', ?, NULL, ?)`,
      )
        .bind(id, `${id}@example.my`, name, dept, mgr)
        .run();
    }
    const ins = async (
      id: string,
      createdAt: string,
      opts: { requireAck?: number; isActive?: number; scheduledAt?: string | null; escalatedAt?: string | null; category?: string } = {},
    ) => {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO announcements
           (id, title, body, is_active, created_at, target_type, target_dept_ids, category, require_ack, scheduled_at, escalated_at)
         VALUES (?, ?, 'b', ?, ?, 'DEPARTMENT_IDS', '[40]', ?, ?, ?, ?)`,
      )
        .bind(
          id,
          `Title ${id}`,
          opts.isActive ?? 1,
          createdAt,
          opts.category ?? "WARNING",
          opts.requireAck ?? 1,
          opts.scheduledAt ?? null,
          opts.escalatedAt ?? null,
        )
        .run();
    };
    const old = new Date(NOW - 3 * DAY).toISOString();
    await ins("esc-due", old); // 3 days old, mandatory, active → escalates
    await ins("esc-young", new Date(NOW - 20 * HOUR).toISOString()); // inside the window
    await ins("esc-optional", old, { requireAck: 0, category: "GENERAL" }); // no ack needed
    await ins("esc-hidden", old, { isActive: 0 });
    await ins("esc-later", old, { scheduledAt: new Date(NOW + DAY).toISOString() });
    await ins("esc-done", old, { escalatedAt: new Date(NOW - DAY).toISOString() });
    // Siti acked the due one; Ravi and the unsupervised person have not.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO announcement_acks (announcement_id, user_id, acked_at) VALUES ('esc-due', 801, ?)`,
    )
      .bind(old)
      .run();
  });

  test("escalates the one due notice: a notice to the supervisor naming the pending report, then a stamp", async () => {
    const r = await runOverdueEscalation(env, NOW);
    // esc-due, esc-optional and esc-later are old, active + unstamped (the
    // hidden one is filtered in SQL); only esc-due is both deliverable and
    // acknowledgement-required.
    expect(r.scanned).toBe(3);
    // Unsupervised = the supervisor himself (in the department, no manager,
    // has not acked) + the report with no manager.
    expect(r).toMatchObject({ escalated: 1, supervisors: 1, unsupervised: 2 });

    const notices = await escalationNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].target_user_ids).toBe("[800]");
    expect(notices[0].title).toBe('1 of your team has not acknowledged "Title esc-due"');
    expect(notices[0].body).toContain("Ravi Kumaran");
    expect(notices[0].body).not.toContain("Siti Aminah");

    expect(await stamp("esc-due")).toBe(new Date(NOW).toISOString());
    for (const id of ["esc-young", "esc-optional", "esc-hidden", "esc-later"]) {
      expect(await stamp(id)).toBeNull();
    }
    expect(await stamp("esc-done")).toBe(new Date(NOW - DAY).toISOString());
  });

  test("a second run is a no-op: nothing re-notified, nothing re-stamped", async () => {
    const r = await runOverdueEscalation(env, NOW + HOUR);
    expect(r).toMatchObject({ escalated: 0, supervisors: 0 });
    expect(await escalationNotices()).toHaveLength(1);
    expect(await stamp("esc-due")).toBe(new Date(NOW).toISOString());
  });

  test("the young notice becomes due once the window passes; a scheduled one counts from its instant", async () => {
    // NOW+2d: esc-young (created NOW-20h) is 68h old → due. esc-later was
    // written 3 days before NOW but only went live at NOW+1d → 24h live, not due.
    const later = NOW + 2 * DAY;
    const r = await runOverdueEscalation(env, later);
    expect(r).toMatchObject({ escalated: 1, supervisors: 1 });
    expect(await stamp("esc-young")).toBe(new Date(later).toISOString());
    expect(await stamp("esc-later")).toBeNull();
    const notices = await escalationNotices();
    expect(notices).toHaveLength(2);
    expect(notices[1].title).toBe('2 of your team have not acknowledged "Title esc-young"');

    // Another two days on, the scheduled one has been live for 72h → due.
    const evenLater = NOW + 4 * DAY;
    const r2 = await runOverdueEscalation(env, evenLater);
    expect(r2).toMatchObject({ escalated: 1 });
    expect(await stamp("esc-later")).toBe(new Date(evenLater).toISOString());
  });
});
