import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

// This file intentionally destroys its isolated test database's idempotency
// table. Keeping it separate proves fail-closed behaviour without contaminating
// the normal middleware integration suite.

let bearer: string;

beforeEach(async () => {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'test', '["*"]', 0)`,
  )
    .bind(`idem_unavailable_${Math.random().toString(36).slice(2)}`)
    .run();
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'Admin', ?, 'active', datetime('now'))`,
  )
    .bind(
      `idem_unavailable_${Math.random().toString(36).slice(2)}@test.local`,
      role.meta.last_row_id,
    )
    .run();
  const token = `idem-unavailable-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, user.meta.last_row_id, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  bearer = `Bearer ${token}`;
});

describe("idempotency bookkeeping outage", () => {
  test("an explicitly idempotent write is blocked instead of running untracked", async () => {
    await env.DB.exec(`DROP TABLE idempotency_keys`);

    const response = await SELF.fetch("https://test.local/api/projects", {
      method: "POST",
      headers: {
        Authorization: bearer,
        "Content-Type": "application/json",
        "Idempotency-Key": "must-not-fail-open",
      },
      body: JSON.stringify({
        name: "Must not exist",
        brand: "AKEMI",
        state: "SELANGOR",
        venue: "TEST VENUE",
        organizer: "TEST ORG",
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "idempotency_unavailable" });
    const projects = await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{
      n: number;
    }>();
    expect(Number(projects?.n ?? 0)).toBe(0);
  });
});
