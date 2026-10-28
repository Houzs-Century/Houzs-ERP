import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  idempotency,
  IDEMPOTENCY_PHASE_ONE_WORKER_MARKER,
  idempotencyRequestHash,
  isUniqueViolation,
  markIdempotencyNoWrite,
} from "../src/middleware/idempotency";
import type { Env } from "../src/types";

// Exercises the opt-in idempotency middleware (middleware/idempotency.ts)
// against a real mutating endpoint (POST /api/projects), which returns a
// fresh id+code and inserts a countable row — so "ran once vs twice" is
// directly observable.

let adminBearer: string;
let adminUserId: number;

const PROJECT_BODY = {
  name: "Idem project",
  brand: "AKEMI",
  state: "SELANGOR",
  venue: "TEST VENUE",
  organizer: "TEST ORG",
};

async function seedAdmin(): Promise<{ bearer: string; userId: number }> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, 0)`,
  )
    .bind(`bd admin ${Math.random().toString(36).slice(2)}`, "test", JSON.stringify(["*"]))
    .run();
  const roleId = role.meta.last_row_id as number;

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'Admin', ?, 'active', datetime('now'))`,
  )
    .bind(`admin_${Math.random().toString(36).slice(2)}@test.local`, roleId)
    .run();
  const userId = user.meta.last_row_id as number;

  const token = `tok-${userId}-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return { bearer: `Bearer ${token}`, userId };
}

async function createProject(
  bearer: string,
  idemKey?: string,
  body: Record<string, unknown> = PROJECT_BODY,
) {
  const headers: Record<string, string> = {
    Authorization: bearer,
    "Content-Type": "application/json",
  };
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const res = await SELF.fetch("https://test.local/api/projects", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, replay: res.headers.get("Idempotent-Replay") };
}

async function projectCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM project_activity`);
  await env.DB.exec(`DELETE FROM project_finance`);
  await env.DB.exec(`DELETE FROM sales_entries`);
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM idempotency_keys`);
  await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?`)
    .bind(IDEMPOTENCY_PHASE_ONE_WORKER_MARKER)
    .run();
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM user_brands`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  const admin = await seedAdmin();
  adminBearer = admin.bearer;
  adminUserId = admin.userId;
});

describe("idempotency middleware", () => {
  test("recognises PostgreSQL 23505 without depending on driver message wording", () => {
    expect(isUniqueViolation({ code: "23505", message: "localised driver text" })).toBe(true);
    expect(isUniqueViolation({ code: "40001", message: "serialization failure" })).toBe(false);
  });

  test("same Idempotency-Key replays the first response and runs the handler once", async () => {
    const first = await createProject(adminBearer, "key-abc");
    expect(first.status).toBe(201);
    expect(first.json.id).toBeGreaterThan(0);
    expect(first.replay).toBeNull(); // first call is not a replay
    expect(await projectCount()).toBe(1);

    const second = await createProject(adminBearer, "key-abc");
    expect(second.status).toBe(201);
    expect(second.replay).toBe("true"); // served from the stored response
    // Identical body — same id + code, not a freshly created project.
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.code).toBe(first.json.code);
    // The crucial guarantee: the handler did NOT run a second time.
    expect(await projectCount()).toBe(1);

    // The key was persisted as completed.
    const row = await env.DB.prepare(
      `SELECT status_code, user_id, tenant_scope, request_hash
         FROM idempotency_keys WHERE key = ? AND scope = ?`,
    )
      .bind("key-abc", "POST /api/projects")
      .first<{
        status_code: number;
        user_id: number;
        tenant_scope: string;
        request_hash: string;
      }>();
    expect(row?.status_code).toBe(201);
    expect(row?.user_id).toBe(adminUserId);
    expect(row?.tenant_scope).toBe("host:test.local");
    expect(row?.request_hash).toMatch(/^[a-f0-9]{64}$/);

    const marker = await env.DB.prepare(
      `SELECT value, updated_at FROM app_settings WHERE key = ?`,
    )
      .bind(IDEMPOTENCY_PHASE_ONE_WORKER_MARKER)
      .first<{ value: string; updated_at: string | null }>();
    expect(JSON.parse(marker?.value ?? "{}")).toEqual({ phase: 1, source: "worker" });
    expect(marker?.updated_at).toBeTruthy();
  });

  test("the same key is isolated by authenticated principal", async () => {
    const other = await seedAdmin();

    const first = await createProject(adminBearer, "shared-client-key");
    const second = await createProject(other.bearer, "shared-client-key");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.replay).toBeNull();
    expect(second.json.id).not.toBe(first.json.id);
    expect(await projectCount()).toBe(2);

    const firstRetry = await createProject(adminBearer, "shared-client-key");
    const secondRetry = await createProject(other.bearer, "shared-client-key");
    expect(firstRetry.replay).toBe("true");
    expect(secondRetry.replay).toBe("true");
    expect(firstRetry.json.id).toBe(first.json.id);
    expect(secondRetry.json.id).toBe(second.json.id);
    expect(await projectCount()).toBe(2);

    const rows = await env.DB.prepare(
      `SELECT user_id FROM idempotency_keys WHERE key = ? ORDER BY user_id`,
    )
      .bind("shared-client-key")
      .all<{ user_id: number }>();
    expect(rows.results.map((row) => row.user_id)).toEqual(
      [adminUserId, other.userId].sort((a, b) => a - b),
    );
  });

  test("the same user and key cannot be reused with a different payload", async () => {
    const first = await createProject(adminBearer, "payload-bound-key");
    expect(first.status).toBe(201);

    const second = await createProject(adminBearer, "payload-bound-key", {
      ...PROJECT_BODY,
      name: "Different operation",
    });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("idempotency_key_reused");
    expect(await projectCount()).toBe(1);
  });

  test("the same principal and key is isolated by active company", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let runs = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", Number(c.req.header("X-Test-Company")));
      await next();
    });
    app.use("*", idempotency);
    app.post("/write", (c) => c.json({ run: ++runs }, 201));

    const send = (companyId: number) =>
      app.request(
        "https://test.local/write",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "same-company-client-key",
            "X-Test-Company": String(companyId),
          },
          body: JSON.stringify({ value: 1 }),
        },
        env,
      );

    const companyOne = await send(1);
    const companyTwo = await send(2);
    expect(companyOne.status).toBe(201);
    expect(companyTwo.status).toBe(201);
    expect(companyTwo.headers.get("Idempotent-Replay")).toBeNull();
    expect(await companyTwo.json()).toEqual({ run: 2 });

    const companyOneRetry = await send(1);
    expect(companyOneRetry.status).toBe(201);
    expect(companyOneRetry.headers.get("Idempotent-Replay")).toBe("true");
    expect(await companyOneRetry.json()).toEqual({ run: 1 });
    expect(runs).toBe(2);

    const claims = await env.DB.prepare(
      `SELECT tenant_scope FROM idempotency_keys
        WHERE key = ? ORDER BY tenant_scope`,
    )
      .bind("same-company-client-key")
      .all<{ tenant_scope: string }>();
    expect(claims.results.map((claim) => claim.tenant_scope)).toEqual([
      "company:1",
      "company:2",
    ]);
  });

  test("query parameters are payload-bound instead of widening the indexed scope", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let runs = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/write", (c) => c.json({ run: ++runs }, 201));

    const send = (mode: string) =>
      app.request(
        `https://test.local/write?mode=${mode}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "query-bound-key",
          },
          body: JSON.stringify({ value: 1 }),
        },
        env,
      );

    expect((await send("first")).status).toBe(201);
    const changedQuery = await send("second");
    expect(changedQuery.status).toBe(409);
    expect(await changedQuery.json()).toMatchObject({ error: "idempotency_key_reused" });
    expect(runs).toBe(1);
  });

  test("a terminal 500 is replayed and never reruns a possibly partial write", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/partial", (c) => {
      writes += 1;
      return c.json({ error: "downstream_failed_after_write" }, 500);
    });

    const send = () =>
      app.request(
        "https://test.local/partial",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "partial-write-key",
          },
          body: JSON.stringify({ amount: 100 }),
        },
        env,
      );

    const first = await send();
    const second = await send();
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(writes).toBe(1);
  });

  test("a bodyless 204 response can be replayed", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.delete("/remove", (c) => {
      writes += 1;
      return c.body(null, 204);
    });

    const send = () =>
      app.request(
        "https://test.local/remove",
        {
          method: "DELETE",
          headers: { "Idempotency-Key": "bodyless-response-key" },
        },
        env,
      );

    expect((await send()).status).toBe(204);
    const replay = await send();
    expect(replay.status).toBe(204);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(await replay.text()).toBe("");
    expect(writes).toBe(1);
  });

  test("an explicitly proven no-write response releases the key for a corrected payload", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/confirm", async (c) => {
      const body = await c.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) {
        markIdempotencyNoWrite(c);
        return c.json({ error: "confirmation_required" }, 409);
      }
      writes += 1;
      return c.json({ ok: true }, 201);
    });

    const send = (confirmed: boolean) =>
      app.request(
        "https://test.local/confirm",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "confirmation-flow-key",
          },
          body: JSON.stringify({ confirmed }),
        },
        env,
      );

    expect((await send(false)).status).toBe(409);
    expect((await send(true)).status).toBe(201);
    const replay = await send(true);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(writes).toBe(1);
  });

  test("an unmarked 409 is persisted because status alone cannot prove no write", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let attempts = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/partial-conflict", (c) => {
      attempts += 1;
      return c.json({ error: "post_write_conflict" }, 409);
    });

    const send = () =>
      app.request(
        "https://test.local/partial-conflict",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "post-write-conflict-key",
          },
          body: JSON.stringify({ value: 1 }),
        },
        env,
      );

    expect((await send()).status).toBe(409);
    const replay = await send();
    expect(replay.status).toBe(409);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(attempts).toBe(1);
  });

  test("an oversized keyed body is rejected before the handler", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/upload", (c) => {
      writes += 1;
      return c.json({ ok: true });
    });

    const response = await app.request(
      "https://test.local/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(1024 * 1024 + 1),
          "Idempotency-Key": "oversized-keyed-body",
        },
        body: "too large according to the declared length",
      },
      env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "idempotency_payload_too_large" });
    expect(writes).toBe(0);
  });

  test("two concurrent identical claims execute the handler once", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/race", async (c) => {
      writes += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return c.json({ ok: true }, 201);
    });

    const send = () =>
      app.request(
        "https://test.local/race",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "concurrent-claim-key",
          },
          body: JSON.stringify({ value: 1 }),
        },
        env,
      );

    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const collision = responses.find((response) => response.status === 409)!;
    expect(await collision.json()).toMatchObject({ error: "idempotency_in_flight" });
    expect(writes).toBe(1);
  });

  test("a thrown handler's terminal 500 is replayed instead of rerunning", async () => {
    const app = new Hono<{ Bindings: Env }>();
    let writes = 0;
    app.use("*", async (c, next) => {
      c.set("userId", adminUserId);
      c.set("companyId", 1);
      await next();
    });
    app.use("*", idempotency);
    app.post("/throws", () => {
      writes += 1;
      throw new Error("failure after partial write");
    });

    const send = () =>
      app.request(
        "https://test.local/throws",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "throw-after-write-key",
          },
          body: JSON.stringify({ amount: 100 }),
        },
        env,
      );

    expect((await send()).status).toBe(500);
    const retry = await send();
    expect(retry.status).toBe(500);
    expect(retry.headers.get("Idempotent-Replay")).toBe("true");
    expect(writes).toBe(1);
  });

  test("no Idempotency-Key header → pass-through, each call creates a row", async () => {
    const a = await createProject(adminBearer);
    const b = await createProject(adminBearer);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).not.toBe(a.json.id);
    expect(await projectCount()).toBe(2);

    // Nothing was recorded in the idempotency table.
    const keys = await env.DB.prepare(`SELECT COUNT(*) AS n FROM idempotency_keys`).first<{
      n: number;
    }>();
    expect(Number(keys?.n ?? 0)).toBe(0);
  });

  test("different keys do not collide", async () => {
    const a = await createProject(adminBearer, "key-1");
    const b = await createProject(adminBearer, "key-2");
    expect(a.json.id).not.toBe(b.json.id);
    expect(await projectCount()).toBe(2);
  });

  test("a key whose original request is still in flight → 409 carrying a mappable CODE", async () => {
    // A claim with status_code NULL is exactly what the middleware leaves while
    // the original request is running; seeding it makes the race deterministic.
    const requestHash = await idempotencyRequestHash(
      new Request("https://test.local/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PROJECT_BODY),
      }),
    );
    await env.DB.prepare(
      `INSERT INTO idempotency_keys
         (key, scope, user_id, tenant_scope, request_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        "key-inflight",
        "POST /api/projects",
        adminUserId,
        "host:test.local",
        requestHash,
      )
      .run();

    const res = await createProject(adminBearer, "key-inflight");
    expect(res.status).toBe(409);
    // The contract the frontend depends on: `error` must stay a CODE. The
    // plain-language mappers (humanApiError / humanHttpMessage) look it up in a
    // curated table, so a bare English sentence here silently falls through to
    // the generic 409 ("That clashes with something already in the system"),
    // which tells the operator their payment failed at the one moment it is
    // actually going through — and invites the double-submit the key prevents.
    expect(res.json.error).toBe("idempotency_in_flight");
    // The in-flight collision must not run the handler a second time.
    expect(await projectCount()).toBe(0);
  });

  test("malformed or oversized keys are rejected before the handler", async () => {
    const whitespace = await createProject(adminBearer, "contains space");
    expect(whitespace.status).toBe(400);
    expect(whitespace.json.error).toBe("invalid_idempotency_key");

    const oversized = await createProject(adminBearer, "x".repeat(201));
    expect(oversized.status).toBe(400);
    expect(oversized.json.error).toBe("invalid_idempotency_key");
    expect(await projectCount()).toBe(0);
  });
});
