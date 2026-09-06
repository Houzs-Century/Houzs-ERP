// Division targeting + exclusions (mig 20260906T0639, owner 2026-09-06):
//   · a notice may name {deptId, division} pairs; a reader whose primary
//     department + users.division match (case-insensitively) is in the
//     audience, a colleague in the same department but another division is
//     not — resolved at READ time, like a department target;
//   · excluded_user_ids carves people out of any audience, whatever else
//     targets them;
//   · both ride POST and PATCH, count in the ack roster, and a division
//     target derives target_type DEPARTMENT_IDS (the CHECK is untouched).
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
  id: 700,
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
const listIds = async (user: unknown) =>
  ((await call(user, "/api/announcements")).body.data as Array<{ id: string }>).map((a) => a.id);

describe("announcements — division targets and excluded people", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER, require_ack INTEGER, scheduled_at TEXT,
         target_divisions TEXT, excluded_user_ids TEXT)`,
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
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY, slug TEXT, name TEXT)`,
    ).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO departments (id, name) VALUES (30, 'Operation'), (31, 'Sales')`).run();
    // Operation has two divisions; Sales has none. 704 is a driver spelled
    // with different case + padding — the match must still hold.
    const users: Array<[number, string, number, string | null]> = [
      [701, "Abd Khalid", 30, "Driver Team"],
      [702, "Faslie", 30, "Driver Team"],
      [703, "Md Baijid", 30, "Attendant KL"],
      [704, "Mohd Zaimir", 30, "  driver team "],
      [705, "Cheah Mei Ling", 31, null],
      [700, "Nico", 31, null],
    ];
    for (const [id, name, dept, division] of users) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO users (id, email, name, password_hash, role_id, status, department_id, position_id, manager_id, division)
         VALUES (?, ?, ?, 'x', 1, 'active', ?, NULL, NULL, ?)`,
      )
        .bind(id, `${id}@example.my`, name, dept, division)
        .run();
    }
  });

  test("POST with targetDivisions reaches the division, not the rest of the department; excluded people are out", async () => {
    const r = await call(
      MANAGER,
      "/api/announcements",
      json("POST", {
        title: "Driver briefing",
        body: "Trucks at 7am",
        category: "GENERAL",
        targetDivisions: [
          { deptId: 30, division: "Driver Team" },
          { deptId: 30, division: "driver team" }, // duplicate ignoring case → one
          { deptId: "x", division: "" }, // invalid → dropped
        ],
        excludedUserIds: [702],
      }),
    );
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    expect(r.body.data.targetType).toBe("DEPARTMENT_IDS");
    expect(r.body.data.targetDeptIds).toEqual([]);
    expect(r.body.data.targetDivisions).toEqual([{ deptId: 30, division: "Driver Team" }]);
    expect(r.body.data.excludedUserIds).toEqual([702]);

    // Readers: 701 (Driver Team) and 704 (case/padding variant) see it;
    // 703 (Attendant KL, same department) and 705 (Sales) do not; 702 is
    // in the division but excluded.
    expect(await listIds(reader(701, 30))).toContain(id);
    expect(await listIds(reader(704, 30))).toContain(id);
    expect(await listIds(reader(703, 30))).not.toContain(id);
    expect(await listIds(reader(705, 31))).not.toContain(id);
    expect(await listIds(reader(702, 30))).not.toContain(id);

    // The banner (pop-up slice) applies the same gate.
    const banner = await call(reader(701, 30), "/api/announcements/banner");
    expect(banner.body.data.map((a: { id: string }) => a.id)).toContain(id);
    const bannerOut = await call(reader(703, 30), "/api/announcements/banner");
    expect(bannerOut.body.data.map((a: { id: string }) => a.id)).not.toContain(id);

    // The manager's receipts roster is the division minus the excluded person.
    const acks = await call(MANAGER, `/api/announcements/${id}/acks`);
    expect(acks.status).toBe(200);
    expect(acks.body.data.total).toBe(2);
    expect(acks.body.data.pending.map((p: { id: number }) => p.id).sort()).toEqual([701, 704]);
    // The list carries a readable label for the division target.
    const mine = (await call(MANAGER, "/api/announcements")).body.data.find((a: { id: string }) => a.id === id);
    expect(mine.targetDivisionNames).toEqual(["Operation › Driver Team"]);
  });

  test("an excluded person is out even when their whole department is targeted; PATCH retargets both columns", async () => {
    const r = await call(
      MANAGER,
      "/api/announcements",
      json("POST", {
        title: "Operation notice",
        body: "b",
        category: "GENERAL",
        targetDeptIds: [30],
        excludedUserIds: [703],
      }),
    );
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    expect(await listIds(reader(701, 30))).toContain(id);
    expect(await listIds(reader(703, 30))).not.toContain(id);

    // Retarget: division only, nobody excluded.
    const p = await call(
      MANAGER,
      `/api/announcements/${id}`,
      json("PATCH", {
        targetDeptIds: [],
        targetDivisions: [{ deptId: 30, division: "Attendant KL" }],
        excludedUserIds: [],
      }),
    );
    expect(p.status).toBe(200);
    expect(p.body.data.targetType).toBe("DEPARTMENT_IDS");
    expect(p.body.data.targetDivisions).toEqual([{ deptId: 30, division: "Attendant KL" }]);
    expect(p.body.data.excludedUserIds).toEqual([]);
    expect(await listIds(reader(703, 30))).toContain(id);
    expect(await listIds(reader(701, 30))).not.toContain(id);

    // A PATCH that only touches the exclusion keeps the division target.
    const p2 = await call(MANAGER, `/api/announcements/${id}`, json("PATCH", { excludedUserIds: [703] }));
    expect(p2.status).toBe(200);
    expect(p2.body.data.targetDivisions).toEqual([{ deptId: 30, division: "Attendant KL" }]);
    expect(await listIds(reader(703, 30))).not.toContain(id);
  });

  test("a division-only target plus people is MIXED; a row with neither column set behaves as before", async () => {
    const r = await call(
      MANAGER,
      "/api/announcements",
      json("POST", {
        title: "Mixed",
        body: "b",
        category: "GENERAL",
        targetDivisions: [{ deptId: 30, division: "Driver Team" }],
        targetUserIds: [705],
      }),
    );
    expect(r.status).toBe(201);
    expect(r.body.data.targetType).toBe("MIXED");
    const id = r.body.data.id as string;
    expect(await listIds(reader(705, 31))).toContain(id);
    expect(await listIds(reader(701, 30))).toContain(id);
    expect(await listIds(reader(703, 30))).not.toContain(id);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO announcements (id, title, body, is_active, created_at, target_type, target_dept_ids, category)
       VALUES ('ann-legacy', 'Legacy', 'b', 1, ?, 'DEPARTMENT_IDS', '[30]', 'GENERAL')`,
    )
      .bind(new Date().toISOString())
      .run();
    expect(await listIds(reader(703, 30))).toContain("ann-legacy");
    expect(await listIds(reader(705, 31))).not.toContain("ann-legacy");
  });
});
