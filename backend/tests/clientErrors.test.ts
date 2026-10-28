import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runClientErrorDigest } from "../src/services/clientErrors";
import { createOutboundFetchMock } from "./outboundFetchMock";

// Self-hosted client error reporting (mig 0151 / D1 126, routes/clientErrors.ts,
// services/clientErrors.ts). Three trust properties under test:
//   1. the endpoint is a wall: unauthed / garbage / oversized bodies bounce;
//   2. identity is stamped from the SESSION — a body-supplied userId/companyId
//      is ignored, so a client can never pin its noise on someone else;
//   3. the (dedup_hash, day, user_id) upsert collapses an error storm to one
//      row per user with a bumped count.
// Plus the daily digest: rows in the last 24h -> ONE email; zero rows -> none.

const ADMIN = { Authorization: "Bearer test-dashboard-key", "Content-Type": "application/json" };

async function seedUser(permissions: string[] = ["projects.read"]): Promise<{ id: number; bearer: string }> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, ?, ?, 0)`,
  )
    .bind(`role_ce_${Math.random().toString(36).slice(2)}`, "test", JSON.stringify(permissions))
    .run();
  const roleId = role.meta.last_row_id as number;
  // Explicit random id, NOT autoincrement: the endpoint's KV rate-limit bucket
  // is keyed by user id, and KV state can outlive a test while D1's id counter
  // resets — a reused id would inherit another test's exhausted bucket.
  const id = 100_000 + Math.floor(Math.random() * 900_000);
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role_id, status, joined_at)
     VALUES (?, ?, 'Err Reporter', ?, 'active', datetime('now'))`,
  )
    .bind(id, `ce_${id}@test.local`, roleId)
    .run();
  const token = `tok-ce-${id}-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, id, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return { id, bearer: `Bearer ${token}` };
}

function eventBody(overrides: Record<string, unknown> = {}) {
  return {
    events: [
      {
        message: "TypeError: Cannot read properties of undefined (reading 'data')",
        stack: "TypeError: Cannot read properties of undefined\n    at SalesList (index-abc.js:1:2)",
        route: "/sales",
        buildId: "test-build-1",
        userAgent: "vitest",
        occurredAt: new Date().toISOString(),
        ...overrides,
      },
    ],
  };
}

async function post(bearer: string, body: unknown) {
  return SELF.fetch("https://test.local/api/client-errors", {
    method: "POST",
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function allRows() {
  const res = await env.DB.prepare(
    `SELECT user_id, company_id, route, message, stack, build_id, dedup_hash, day, count, occurred_at, last_seen_at
       FROM client_errors ORDER BY id`,
  ).all<{
    user_id: number;
    company_id: number | null;
    route: string;
    message: string;
    stack: string | null;
    build_id: string;
    dedup_hash: string;
    day: string;
    count: number;
    occurred_at: string;
    last_seen_at: string;
  }>();
  return res.results ?? [];
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM client_errors`);
  await env.DB.exec(`DELETE FROM email_outbox`);
  await env.DB.exec(`DELETE FROM email_log`);
});

describe("POST /api/client-errors — the wall", () => {
  test("no session -> 401, nothing stored", async () => {
    const res = await SELF.fetch("https://test.local/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventBody()),
    });
    expect(res.status).toBe(401);
    expect((await allRows()).length).toBe(0);
  });

  test("garbage JSON -> 400; schema-invalid -> 400; empty events -> 400", async () => {
    const { bearer } = await seedUser();
    expect((await post(bearer, "{not json")).status).toBe(400);
    expect((await post(bearer, { events: [{ nope: true }] })).status).toBe(400);
    expect((await post(bearer, { events: [] })).status).toBe(400);
    expect((await allRows()).length).toBe(0);
  });

  test("oversized body (>16KB) -> 413", async () => {
    const { bearer } = await seedUser();
    const res = await post(bearer, eventBody({ stack: "x".repeat(20 * 1024) }));
    expect(res.status).toBe(413);
    expect((await allRows()).length).toBe(0);
  });

  test("more than 20 events in one batch -> 400", async () => {
    const { bearer } = await seedUser();
    const events = Array.from({ length: 21 }, (_, i) => ({ message: `e${i}` }));
    expect((await post(bearer, { events })).status).toBe(400);
  });

  test("per-user rate limit: 61st batch in the window -> 429", async () => {
    const { bearer } = await seedUser();
    for (let i = 0; i < 60; i++) {
      // Distinct messages so this also proves 60 distinct rows insert fine.
      const res = await post(bearer, eventBody({ message: `boom ${i}` }));
      expect(res.status).toBe(200);
    }
    const over = await post(bearer, eventBody({ message: "one too many" }));
    expect(over.status).toBe(429);
  });
});

describe("identity + privacy stamping", () => {
  test("user_id/company_id come from the session; client-sent identity is ignored", async () => {
    const { id, bearer } = await seedUser();
    const body = eventBody();
    // A hostile client claims to be someone else — zod strips unknown keys, and
    // the insert never reads them.
    (body.events[0] as Record<string, unknown>).userId = 99999;
    (body.events[0] as Record<string, unknown>).companyId = 424242;
    (body as Record<string, unknown>).userId = 99999;
    const res = await post(bearer, body);
    expect(res.status).toBe(200);

    const rows = await allRows();
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(id);
    // Test D1 has no companies master -> companyContext leaves it unresolved ->
    // NULL. The point: NOT 424242.
    expect(rows[0].company_id).toBeNull();
  });

  test("route is stored as pathname only — query string and fragment stripped server-side", async () => {
    const { bearer } = await seedUser();
    const res = await post(
      bearer,
      eventBody({ route: "/reset/tok-SECRET?email=a@b.co&token=abc#frag" }),
    );
    expect(res.status).toBe(200);
    const rows = await allRows();
    expect(rows[0].route).toBe("/reset/tok-SECRET");
    expect(rows[0].route).not.toContain("?");
    expect(rows[0].route).not.toContain("token=");
  });

  test("stack is truncated to 4KB, not rejected", async () => {
    const { bearer } = await seedUser();
    const res = await post(bearer, eventBody({ stack: "y".repeat(8000) }));
    expect(res.status).toBe(200);
    const rows = await allRows();
    expect(rows[0].stack?.length).toBe(4096);
  });
});

describe("dedup upsert", () => {
  test("same error twice in one day for one user -> one row, count bumped, last_seen advanced", async () => {
    const { bearer } = await seedUser();
    expect((await post(bearer, eventBody())).status).toBe(200);
    const [first] = await allRows();
    expect(first.count).toBe(1);

    await new Promise((r) => setTimeout(r, 5));
    expect((await post(bearer, eventBody())).status).toBe(200);

    const rows = await allRows();
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].dedup_hash).toBe(first.dedup_hash);
    expect(rows[0].last_seen_at >= first.last_seen_at).toBe(true);
    // First occurrence's stamp is kept.
    expect(rows[0].occurred_at).toBe(first.occurred_at);
  });

  test("a batch of 10 identical events (a render loop) collapses to one row with count 10", async () => {
    const { bearer } = await seedUser();
    const events = Array.from({ length: 10 }, () => eventBody().events[0]);
    const res = await post(bearer, { events });
    expect(res.status).toBe(200);
    const rows = await allRows();
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(10);
  });

  test("same error from two users -> two rows; summary reports affected_users=2", async () => {
    const a = await seedUser();
    const b = await seedUser();
    expect((await post(a.bearer, eventBody())).status).toBe(200);
    expect((await post(b.bearer, eventBody())).status).toBe(200);

    const rows = await allRows();
    expect(rows.length).toBe(2);
    expect(rows[0].dedup_hash).toBe(rows[1].dedup_hash);

    const sum = await SELF.fetch("https://test.local/api/client-errors/summary?days=7", {
      headers: ADMIN,
    });
    expect(sum.status).toBe(200);
    const json = (await sum.json()) as {
      success: boolean;
      data: Array<{ count: number; affected_users: number; message: string }>;
      totals: { errors: number; occurrences: number };
    };
    expect(json.success).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].count).toBe(2);
    expect(json.data[0].affected_users).toBe(2);
    expect(json.totals).toEqual({ errors: 1, occurrences: 2 });
  });

  test("different message -> different row (hash covers message+route+build)", async () => {
    const { bearer } = await seedUser();
    await post(bearer, eventBody());
    await post(bearer, eventBody({ message: "a different crash" }));
    const rows = await allRows();
    expect(rows.length).toBe(2);
    expect(rows[0].dedup_hash).not.toBe(rows[1].dedup_hash);
  });
});

describe("GET /summary — super-admin only", () => {
  test("a real staff user without '*' gets 403; the wildcard admin gets 200", async () => {
    const staff = await seedUser(["projects.read"]);
    const denied = await SELF.fetch("https://test.local/api/client-errors/summary", {
      headers: { Authorization: staff.bearer },
    });
    expect(denied.status).toBe(403);

    const ok = await SELF.fetch("https://test.local/api/client-errors/summary", {
      headers: ADMIN,
    });
    expect(ok.status).toBe(200);
  });
});

// ── Daily digest ────────────────────────────────────────────────────────────
// sendEmail's only network call is the Resend POST; mock it like
// emailOutbox.test.ts does and hand the service an env with a key set (the real
// test env leaves RESEND_API_KEY unset on purpose).

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as typeof env;
let outbound: ReturnType<typeof createOutboundFetchMock>;

function mockResend(status: number, body: unknown) {
  outbound.replyOnce("https://api.resend.com/emails", "POST", status, body);
}

afterEach(() => {
  outbound.assertDone();
});

beforeEach(() => {
  outbound = createOutboundFetchMock();
});

async function seedErrorRow(p: {
  message: string;
  route?: string;
  userId?: number;
  count?: number;
  agoMs?: number;
}) {
  const at = new Date(Date.now() - (p.agoMs ?? 0)).toISOString();
  await env.DB.prepare(
    `INSERT INTO client_errors
       (occurred_at, day, user_id, company_id, route, message, stack, build_id, user_agent, dedup_hash, count, last_seen_at, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, 'b1', 'vitest', ?, ?, ?, ?)`,
  )
    .bind(
      at,
      at.slice(0, 10),
      p.userId ?? 1,
      p.route ?? "/sales",
      p.message,
      // Hash uniqueness only matters per (message,user) here; derive from both.
      `hash-${p.message}`,
      p.count ?? 1,
      at,
      at,
    )
    .run();
}

describe("daily digest", () => {
  test("zero errors in 24h -> no email at all", async () => {
    // A stale row outside the window must not trigger a send either.
    await seedErrorRow({ message: "old crash", agoMs: 48 * 3600 * 1000 });
    const r = await runClientErrorDigest(liveEnv);
    expect(r.sent).toBe(0);
    expect(r.errors).toBe(0);
    const log = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log`).first<{ n: number }>();
    expect(Number(log?.n)).toBe(0);
  });

  test("errors in 24h -> ONE email to IT with top-by-count first + affected users", async () => {
    // "loud" outranks "quiet" by summed count; two users on "loud".
    await seedErrorRow({ message: "loud crash", userId: 1, count: 30 });
    await seedErrorRow({ message: "loud crash", userId: 2, count: 12 });
    await seedErrorRow({ message: "quiet crash", userId: 1, count: 3, route: "/projects" });

    mockResend(200, { id: "prov-digest-1" });
    const r = await runClientErrorDigest(liveEnv);
    expect(r.sent).toBe(1);
    expect(r.errors).toBe(2);
    expect(r.occurrences).toBe(45);

    // sendEmail enqueues durably before delivering — the outbox row IS the
    // message, so assert content there (deterministic, no intercept plumbing).
    const rows = await env.DB.prepare(
      `SELECT to_address, subject, body_html, status FROM email_outbox`,
    ).all<{ to_address: string; subject: string; body_html: string; status: string }>();
    expect(rows.results?.length).toBe(1);
    const mail = rows.results![0];
    expect(mail.status).toBe("sent");
    expect(mail.to_address).toBe("hello@houzscentury.com");
    expect(mail.subject).toContain("2 distinct");
    expect(mail.subject).toContain("45 occurrence");
    const html = mail.body_html;
    // Top-by-count ordering: loud before quiet.
    expect(html.indexOf("loud crash")).toBeGreaterThan(-1);
    expect(html.indexOf("loud crash")).toBeLessThan(html.indexOf("quiet crash"));
    expect(html).toContain("/sales");
    // Affected-users cell: 2 for loud (42 occurrences across 2 users).
    expect(html).toContain(">42</td>");
    expect(html).toContain(">2</td>");
  });

  test("rows older than 90 days are purged by the same run", async () => {
    await seedErrorRow({ message: "ancient", agoMs: 91 * 24 * 3600 * 1000 });
    await seedErrorRow({ message: "fresh", agoMs: 1000 });
    mockResend(200, { id: "prov-digest-2" });
    const r = await runClientErrorDigest(liveEnv);
    expect(r.purged).toBe(1);
    const rows = await allRows();
    expect(rows.length).toBe(1);
    expect(rows[0].message).toBe("fresh");
  });
});
