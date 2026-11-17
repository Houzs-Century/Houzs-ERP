import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";

/* Renaming an organizer used to update only the project_organizers master row
   and leave projects.organizer (plain free text) on the old name. The public
   share calendar reads projects.organizer, so a rename left every existing
   event showing the old organizer with nothing saying why. The rename must
   cascade into projects, the same way PATCH /brands/:id does. */

async function seedAdmin(): Promise<{ userId: number; bearer: string }> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, 0)`
  )
    .bind("organizer rename admin", "test role", JSON.stringify(["*"]))
    .run();
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`
  )
    .bind("organizer-rename@test.local", "Admin", role.meta.last_row_id as number)
    .run();
  const userId = user.meta.last_row_id as number;
  const token = `organizer-rename-token-${userId}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+1 day'))`
  )
    .bind(token, userId)
    .run();
  return { userId, bearer: `Bearer ${token}` };
}

async function api(method: string, path: string, bearer: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { Authorization: bearer, "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await SELF.fetch(`https://test.local${path}`, init);
  return { status: res.status };
}

let adminBearer: string;
let adminUserId: number;

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  await env.DB.exec(`DELETE FROM project_organizers`);
  const seeded = await seedAdmin();
  adminUserId = seeded.userId;
  adminBearer = seeded.bearer;
});

describe("PATCH /api/projects/organizers/:id — rename cascade", () => {
  test("carries the new name into existing projects.organizer", async () => {
    const org = await env.DB.prepare(
      `INSERT INTO project_organizers (name, active) VALUES ('PERAK HOME', 1)`
    ).run();
    const orgId = org.meta.last_row_id as number;

    await env.DB.prepare(
      `INSERT INTO projects (name, organizer, stage, status, created_by)
       VALUES ('Fair', 'PERAK HOME', 'draft', 'active', ?)`
    )
      .bind(adminUserId)
      .run();

    const res = await api("PATCH", `/api/projects/organizers/${orgId}`, adminBearer, {
      name: "PERAK HOMEX",
    });
    expect(res.status).toBe(200);

    // The master row is renamed.
    const master = await env.DB.prepare(
      `SELECT name FROM project_organizers WHERE id = ?`
    )
      .bind(orgId)
      .first<{ name: string }>();
    expect(master?.name).toBe("PERAK HOMEX");

    // The existing event follows the rename (this is what the calendar reads).
    const moved = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE organizer = 'PERAK HOMEX'`
    ).first<{ n: number }>();
    expect(moved?.n, "the event's organizer must follow the rename").toBe(1);

    const stale = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE organizer = 'PERAK HOME'`
    ).first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });
});
