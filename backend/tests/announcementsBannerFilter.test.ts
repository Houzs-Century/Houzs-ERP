// /api/announcements/banner — the two feed slices.
//
// Pins the owner 2026-08-08 rule ("为什么一直有这个"): MACHINE-GENERATED
// notices (source NOT NULL — the scan / service-case per-user notices) must
// never reach the pop-up banner. The default /banner — what both pop-up
// shells read — is the HUMAN slice (source IS NULL), and the split is applied
// on READ, so historical machine rows stop popping the moment this deploys.
// scope=system stays the notification-bell slice. An unknown scope — including
// the retired `all` — falls back to the human slice, so a stale cached bundle
// still requesting the old unscoped full feed cannot resurrect the badgering.
//
// Cache shape: the human slice is one payload however it is asked for
// (default or scope=human), so both are served from the same per-user KV
// snapshot. The system slice is cached too, keyed on scope so it never
// collides with the human payload (mobile bell polls at 30s, may serve up to
// TTL-stale — the same trade the human slice already makes).
//
// Harness mirrors configCache.test.ts's banner section: a bare Hono app that
// stands in the user, the real announcements router, and a minimal D1 mirror of
// the pg-only tables.

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

const USER = { id: 505, department_id: null, position_id: null, permissions: [] as string[], permissions_set: new Set<string>() };

async function getBanner(scope: string) {
  state.user = USER;
  const path = scope
    ? `/api/announcements/banner?scope=${scope}`
    : "/api/announcements/banner";
  const res = await app.request(path, {}, env as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data?: Array<{ id: string; source?: string | null }> };
  return {
    cache: res.headers.get("x-config-cache"),
    ids: (body.data ?? []).map((a) => a.id),
    sources: (body.data ?? []).map((a) => a.source ?? null),
  };
}

describe("/api/announcements/banner — scope slices", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT, user_id INTEGER, acked_at TEXT, company_id INTEGER,
         PRIMARY KEY (announcement_id, user_id))`,
    ).run();
  });

  test("default + scope=human are the pop-up slice (machine rows excluded, one shared snapshot); scope=system is the bell; unknown scope falls back to human", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    // A human post plus BOTH machine producers' rows, all targeting USER. The
    // machine rows are inserted first — i.e. they are HISTORICAL by the time
    // the first read below runs — which is exactly the badgering backlog the
    // read-side split must silence with no data migration.
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, body, is_active, expires_at, created_at, target_type, target_user_ids, category, source)
       VALUES ('ann-scan', 'Sales order saved', 'b', 1, ?, ?, 'USER_IDS', '[505]', 'GENERAL', 'scan')`,
    ).bind(future, new Date(Date.now() - 2000).toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, body, is_active, expires_at, created_at, target_type, target_user_ids, category, source)
       VALUES ('ann-case', 'New service case ASSR/HC/2608/001', 'b', 1, ?, ?, 'USER_IDS', '[505]', 'GENERAL', 'service_case')`,
    ).bind(future, new Date(Date.now() - 1000).toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, body, is_active, expires_at, created_at, target_type, target_user_ids, category, source)
       VALUES ('ann-human', 'Office memo', 'b', 1, ?, ?, 'USER_IDS', '[505]', 'GENERAL', NULL)`,
    ).bind(future, new Date().toISOString()).run();

    // Default (what both pop-up shells read): human posts ONLY. Neither
    // machine row — historical or not — ever pops a banner again.
    const dflt = await getBanner("");
    expect(dflt.ids).toEqual(["ann-human"]);
    expect(dflt.sources).toEqual([null]);
    expect(dflt.cache).toBe("miss"); // cacheable — filled the per-user snapshot

    // scope=human is the SAME slice and rides the snapshot the default filled.
    const humanOnly = await getBanner("human");
    expect(humanOnly.ids).toEqual(["ann-human"]);
    expect(humanOnly.cache).toBe("hit");

    // scope=system is the bell slice: exactly the machine rows. Cached under
    // its OWN scope key — first read misses and fills, and crucially returns
    // the SYSTEM payload, not the human entry the default read already filled.
    const systemOnly = await getBanner("system");
    expect([...systemOnly.ids].sort()).toEqual(["ann-case", "ann-scan"]);
    expect([...systemOnly.sources].sort()).toEqual(["scan", "service_case"]);
    expect(systemOnly.cache).toBe("miss");

    // A 2nd system read HITS its own entry — and the human read STILL returns
    // the human payload, proving the two scopes never cross.
    const systemAgain = await getBanner("system");
    expect([...systemAgain.ids].sort()).toEqual(["ann-case", "ann-scan"]);
    expect(systemAgain.cache).toBe("hit");
    const humanAgain = await getBanner("human");
    expect(humanAgain.ids).toEqual(["ann-human"]);
    expect(humanAgain.cache).toBe("hit");

    // The retired unscoped-full-feed spelling (scope=all) — or any unknown
    // scope — resolves to the human slice, never to "everything": a stale
    // cached bundle cannot resurrect the machine-notice pop-up. (It shares the
    // human snapshot, so this is a hit.)
    const unknown = await getBanner("all");
    expect(unknown.ids).toEqual(["ann-human"]);
    expect(unknown.sources).toEqual([null]);
  });
});
