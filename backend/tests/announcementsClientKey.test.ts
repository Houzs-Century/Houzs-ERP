// POST /api/announcements — idempotent create by client key (mig
// 20260907T0010, docs/bugs/0651).
//
// On 2026-09-06 the owner's Schedule post hung (the route awaited the
// translation, #3016); he clicked again, and again, and each click INSERTed —
// nine copies of one notice. The composer's draft survives a closed modal
// and a reload, so the retry was the SAME draft each time. The draft now
// carries a client key; the route answers a repeat with the row it already
// made, flagged `duplicate: true`, and a client that sends no key posts
// exactly as before.
//
// Same bare-Hono harness as announcementsRichBody.test.ts. The D1 mirror here
// carries the new column AND the partial unique index, so the race leg (two
// requests past the lookup) is exercised for real.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";

function manager(id: number) {
  return {
    id,
    department_id: null,
    position_id: null,
    position_name: null,
    permissions: ["announcements.write"],
    permissions_set: new Set(["announcements.write"]),
  };
}

function appAs(userId: number) {
  const app = new Hono();
  app.use("*", async (c: never, next: never) => {
    (c as { set: (k: string, v: unknown) => void }).set("user", manager(userId));
    await (next as unknown as () => Promise<void>)();
  });
  app.route("/api/announcements", announcementRoutes);
  return app;
}

type Pub = { id: string; title: string };
type Reply = { status: number; success?: boolean; error?: string; data?: Pub; duplicate?: boolean };

async function post(app: Hono, payload: Record<string, unknown>): Promise<Reply> {
  const res = await app.request(
    "/api/announcements",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    env as never,
  );
  const json = (await res.json()) as Omit<Reply, "status">;
  return { status: res.status, ...json };
}

async function countTitled(title: string): Promise<number> {
  const r = await env.DB.prepare("SELECT count(*) AS n FROM announcements WHERE title = ?")
    .bind(title)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

describe("announcement create — client key", () => {
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
         client_key TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS announcements_client_key_uq
         ON announcements (created_by, client_key) WHERE client_key IS NOT NULL`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT,
         company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
    ).run();
  });

  test("a repeat with the same key gets the first row back, flagged, and no second row", async () => {
    const app = appAs(701);
    const first = await post(app, { title: "Nine copies", body: "once", clientKey: "draft-aaaa-0001" });
    expect(first.status).toBe(201);
    expect(first.duplicate).toBeUndefined();
    const id = first.data!.id;

    // The owner's retry: same draft, small edits — still one post.
    const again = await post(app, {
      title: "Nine copies",
      body: "once, edited",
      targetDeptIds: [1],
      clientKey: "draft-aaaa-0001",
    });
    expect(again.status).toBe(201);
    expect(again.duplicate).toBe(true);
    expect(again.data?.id).toBe(id);
    expect(await countTitled("Nine copies")).toBe(1);
  });

  test("the key is scoped to its author — another user's identical key is their own post", async () => {
    const a = await post(appAs(702), { title: "Scoped", body: "a", clientKey: "draft-bbbb-0001" });
    const b = await post(appAs(703), { title: "Scoped", body: "b", clientKey: "draft-bbbb-0001" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.duplicate).toBeUndefined();
    expect(b.data?.id).not.toBe(a.data?.id);
    expect(await countTitled("Scoped")).toBe(2);
  });

  test("no key, or a malformed one, posts exactly as before — a new row each time", async () => {
    const app = appAs(704);
    await post(app, { title: "Keyless", body: "x" });
    await post(app, { title: "Keyless", body: "x" });
    await post(app, { title: "Keyless", body: "x", clientKey: "short" });
    await post(app, { title: "Keyless", body: "x", clientKey: "has spaces in it!" });
    expect(await countTitled("Keyless")).toBe(4);
  });

  test("two requests racing past the lookup: the index refuses the second and it is answered with the winner", async () => {
    const app = appAs(705);
    const [x, y] = await Promise.all([
      post(app, { title: "Race", body: "r", clientKey: "draft-cccc-0001" }),
      post(app, { title: "Race", body: "r", clientKey: "draft-cccc-0001" }),
    ]);
    expect(x.status).toBe(201);
    expect(y.status).toBe(201);
    expect(x.data?.id).toBe(y.data?.id);
    expect([x.duplicate, y.duplicate].filter(Boolean)).toHaveLength(1);
    expect(await countTitled("Race")).toBe(1);
  });
});
