import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";

/* Renaming a brand used to update projects.brand and nothing else, while
   user_brands.brand and project_cost_rates.brand hold the same name as free
   text. approverBrandBlocked compares user_brands.brand to projects.brand by
   exact string, so a rename left a restricted director unable to approve the
   brand they had been granted, with nothing on screen saying why. */

let adminBearer: string;

async function seedAdmin(): Promise<string> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, 0)`
  )
    .bind("brand rename admin", "test role", JSON.stringify(["*"]))
    .run();
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`
  )
    .bind("brand-rename@test.local", "Admin", role.meta.last_row_id as number)
    .run();
  const userId = user.meta.last_row_id as number;
  const token = `brand-rename-token-${userId}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+1 day'))`
  )
    .bind(token, userId)
    .run();
  return { userId, bearer: `Bearer ${token}` } as any;
}

async function api(method: string, path: string, bearer: string, body?: any) {
  const init: RequestInit = {
    method,
    headers: { Authorization: bearer, "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await SELF.fetch(`https://test.local${path}`, init);
  return { status: res.status };
}

let adminUserId: number;

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM user_brands`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  await env.DB.exec(`DELETE FROM project_cost_rates`);
  await env.DB.exec(`DELETE FROM project_brands`);
  const seeded: any = await seedAdmin();
  adminUserId = seeded.userId;
  adminBearer = seeded.bearer;
});

describe("PATCH /api/projects/brands/:id — rename cascade", () => {
  test("carries the new name into user_brands and project_cost_rates", async () => {
    const brand = await env.DB.prepare(
      `INSERT INTO project_brands (name, color, sort_order, active)
       VALUES ('AKEMI C&C', '64748b', 60, 1)`
    ).run();
    const brandId = brand.meta.last_row_id as number;

    await env.DB.prepare(
      `INSERT INTO projects (name, brand, stage, status, created_by)
       VALUES ('Fair', 'AKEMI C&C', 'draft', 'active', ?)`
    )
      .bind(adminUserId)
      .run();
    await env.DB.prepare(`INSERT INTO user_brands (user_id, brand) VALUES (?, 'AKEMI C&C')`)
      .bind(adminUserId)
      .run();
    await env.DB.prepare(
      `INSERT INTO project_cost_rates (brand, transport_pct) VALUES ('AKEMI C&C', 5)`
    ).run();

    const res = await api("PATCH", `/api/projects/brands/${brandId}`, adminBearer, {
      name: "Akemi Cash & Carry",
    });
    expect(res.status).toBe(200);

    // The half that already worked.
    const proj = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE brand = 'Akemi Cash & Carry'`
    ).first<{ n: number }>();
    expect(proj?.n).toBe(1);

    // The half that silently broke approvals.
    const grants = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_brands WHERE brand = 'Akemi Cash & Carry'`
    ).first<{ n: number }>();
    expect(grants?.n, "the director's brand grant must follow the rename").toBe(1);

    const rates = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_cost_rates WHERE brand = 'Akemi Cash & Carry'`
    ).first<{ n: number }>();
    expect(rates?.n, "the cost rate must follow the rename").toBe(1);

    const stale = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_brands WHERE brand = 'AKEMI C&C'`
    ).first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });

  /* The other branch of the cascade — two companies owning the same brand
     name, where the rename must NOT touch the unscoped tables — cannot be
     expressed here: the D1 test schema puts a GLOBAL unique index on
     project_brands.name, while production (Postgres, mig 0093) scopes it per
     company. The guard it protects is the `id <> ?` check in the handler. */
});
