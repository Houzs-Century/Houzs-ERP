// GET /api/announcements — who may LIST, and what each cohort sees.
//
// Pins the owner ruling restated 2026-07-21: announcements are readable by
// EVERY active user. `announcements.read` is the ADMIN list/composer verb that
// no ordinary salesperson holds (positions get no permission-matrix backfill),
// so gating the list on it sent everyone who clicked the notice pop-up's
// "Read SOP" / "View details" button to a 403 — while the pop-up itself, which
// rides the ungated /banner, worked fine. The door opened; the AUDIENCE FILTER
// is what keeps the data honest, and that is the half this file is really
// guarding: a non-privileged caller must still see ONLY live notices addressed
// to them, and WRITE must still refuse them.
//
// Harness mirrors announcementsBannerFilter.test.ts: a bare Hono app that
// stands in the user, the real announcements router, and a minimal D1 mirror of
// the pg-only tables. Standing in the user directly is the point — it proves
// the gate lives in the ROUTE, not in a middleware the test forgot to mount.

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

// A rank-and-file salesperson: no announcements.* verb at all, no position (so
// none of the code-keyed Sales-Director bypasses fire either). This is the exact
// account that used to get "Access denied — page: announcements.read".
const READER = {
  id: 505,
  department_id: null,
  position_id: null,
  position_name: null,
  permissions: [] as string[],
  permissions_set: new Set<string>(),
};

// The office composer. announcements.write is what makes them a "manager" to
// the list handler — the privileged view (inactive + expired + everyone else's
// audience) hangs off that verb, NOT off announcements.read.
const MANAGER = {
  id: 606,
  department_id: null,
  position_id: null,
  position_name: null,
  permissions: ["announcements.write"],
  permissions_set: new Set(["announcements.write"]),
};

async function list(user: unknown) {
  state.user = user;
  // No trailing slash — Hono is strict by default and the page calls it exactly
  // this way (pages/Announcements.tsx listQ).
  const res = await app.request("/api/announcements", {}, env as never);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return { status: res.status, ids: (body.data ?? []).map((a) => a.id).sort() };
}

describe("GET /api/announcements — open to every authed user, audience-filtered", () => {
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

    const now = new Date().toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const ins = async (
      id: string,
      isActive: number,
      expiresAt: string | null,
      targetType: string,
      targetUserIds: string | null,
      source: string | null,
    ) => {
      await env.DB.prepare(
        `INSERT INTO announcements (id, title, body, is_active, expires_at, created_at, created_by, target_type, target_user_ids, category, source)
         VALUES (?, ?, 'b', ?, ?, ?, 606, ?, ?, 'GENERAL', ?)`,
      )
        .bind(id, id, isActive, expiresAt, now, targetType, targetUserIds, source)
        .run();
    };

    // Live + addressed to READER by user id — the one private notice they own.
    await ins("ann-live-mine", 1, future, "USER_IDS", "[505]", null);
    // Live + addressed to everyone.
    await ins("ann-live-all", 1, null, "ALL_USERS", null, null);
    // Live but addressed to SOMEONE ELSE — the leak this filter exists to stop.
    await ins("ann-live-other", 1, future, "USER_IDS", "[999]", null);
    // Drafted (is_active 0) and expired: office-only states, even for ALL_USERS.
    await ins("ann-draft", 0, null, "ALL_USERS", null, null);
    await ins("ann-expired", 1, past, "ALL_USERS", null, null);
    // A system per-user notice. Delivered through /banner + the mobile screen
    // only; the LIST filters source IS NULL, so NOBODY sees it here — including
    // the manager. Opening the door must not change that.
    await ins("ann-scan", 1, future, "USER_IDS", "[505]", "scan");
  });

  test("a caller WITHOUT announcements.read gets 200 and sees only live rows addressed to them", async () => {
    const r = await list(READER);
    expect(r.status).toBe(200);
    expect(r.ids).toEqual(["ann-live-all", "ann-live-mine"]);
  });

  test("a manager keeps the privileged set — drafts, expired, and other people's audiences", async () => {
    const m = await list(MANAGER);
    expect(m.status).toBe(200);
    expect(m.ids).toEqual([
      "ann-draft",
      "ann-expired",
      "ann-live-all",
      "ann-live-mine",
      "ann-live-other",
    ]);
  });

  test("authentication is still required — no user is 401, not an unscoped list", async () => {
    const r = await list(undefined);
    expect(r.status).toBe(401);
    expect(r.ids).toEqual([]);
  });

  test("WRITE did not widen: create / edit / delete still 403 without announcements.write", async () => {
    state.user = READER;

    const created = await app.request(
      "/api/announcements",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Should never be posted" }),
      },
      env as never,
    );
    expect(created.status).toBe(403);

    const edited = await app.request(
      "/api/announcements/ann-live-mine",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Should never be edited" }),
      },
      env as never,
    );
    expect(edited.status).toBe(403);

    const reminded = await app.request(
      "/api/announcements/ann-live-mine/remind",
      { method: "POST" },
      env as never,
    );
    expect(reminded.status).toBe(403);

    const deleted = await app.request(
      "/api/announcements/ann-live-mine",
      { method: "DELETE" },
      env as never,
    );
    expect(deleted.status).toBe(403);

    // Read-receipts are a publisher surface too (who read a notice is not for
    // the audience to see), so the reader must not get the roster either.
    const acks = await app.request(
      "/api/announcements/ann-live-mine/acks",
      {},
      env as never,
    );
    expect(acks.status).toBe(403);

    // ...and none of the refusals wrote anything.
    const after = await list(READER);
    expect(after.ids).toEqual(["ann-live-all", "ann-live-mine"]);
  });
});
