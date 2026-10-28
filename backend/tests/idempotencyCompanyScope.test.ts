import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { auth } from "../src/middleware/auth";
import {
  __resetCompanyContextCacheForTest,
  companyContext,
} from "../src/middleware/companyContext";
import { idempotency } from "../src/middleware/idempotency";
import type { Env } from "../src/types";

let bearer: string;
let userId: number;

beforeEach(async () => {
  __resetCompanyContextCacheForTest();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS companies (
       id INTEGER PRIMARY KEY,
       code TEXT NOT NULL,
       name TEXT NOT NULL,
       is_active INTEGER NOT NULL DEFAULT 1
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS user_companies (
       user_id INTEGER NOT NULL,
       company_id INTEGER NOT NULL,
       PRIMARY KEY (user_id, company_id)
     )`,
  ).run();
  await env.DB.exec(`DELETE FROM user_companies`);
  await env.DB.exec(`DELETE FROM companies`);
  await env.DB.exec(`DELETE FROM idempotency_keys`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM user_brands`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);

  await env.DB.prepare(
    `INSERT INTO companies (id, code, name, is_active) VALUES
       (1, 'HOUZS', 'Houzs Century', 1),
       (2, '2990', '2990 Home', 1)`,
  ).run();
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'test', '["*"]', 0)`,
  )
    .bind(`idem_company_${Math.random().toString(36).slice(2)}`)
    .run();
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'Admin', ?, 'active', datetime('now'))`,
  )
    .bind(
      `idem_company_${Math.random().toString(36).slice(2)}@test.local`,
      role.meta.last_row_id,
    )
    .run();
  userId = Number(user.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO user_companies (user_id, company_id) VALUES (?, 1), (?, 2)`,
  )
    .bind(userId, userId)
    .run();

  const token = `idem-company-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  bearer = `Bearer ${token}`;
});

describe("auth -> companyContext -> idempotency integration", () => {
  test("the resolved active company owns an independent claim and never cross-replays", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", auth);
    app.use("*", companyContext);
    app.use("*", idempotency);
    app.post("/write", (c) =>
      c.json({ write: ++writes, companyId: c.get("companyId") }, 201),
    );

    const send = (companyId: number) =>
      app.request(
        "https://erp.houzscentury.com/write",
        {
          method: "POST",
          headers: {
            Authorization: bearer,
            "Content-Type": "application/json",
            "Idempotency-Key": "company-ordering-key",
            "X-Company-Id": String(companyId),
          },
          body: JSON.stringify({ value: 1 }),
        },
        env,
      );

    const first = await send(1);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ write: 1, companyId: 1 });

    const secondCompany = await send(2);
    expect(secondCompany.status).toBe(201);
    expect(secondCompany.headers.get("Idempotent-Replay")).toBeNull();
    expect(await secondCompany.json()).toMatchObject({ write: 2, companyId: 2 });

    const firstAgain = await send(1);
    expect(firstAgain.status).toBe(201);
    expect(firstAgain.headers.get("Idempotent-Replay")).toBe("true");
    expect(await firstAgain.json()).toMatchObject({ write: 1, companyId: 1 });
    expect(writes).toBe(2);

    const claims = await env.DB.prepare(
      `SELECT user_id, tenant_scope FROM idempotency_keys
        WHERE key = ? ORDER BY tenant_scope`,
    )
      .bind("company-ordering-key")
      .all<{ user_id: number; tenant_scope: string }>();
    expect(claims.results).toEqual([
      { user_id: userId, tenant_scope: "company:1" },
      { user_id: userId, tenant_scope: "company:2" },
    ]);
  });
});
