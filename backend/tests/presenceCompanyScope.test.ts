// GET /api/presence — the who's-online roster is scoped to the caller's OWN
// granted companies (allowedCompanyIds), per docs/TENANT-ISOLATION-ROOT-FIX.md
// §6.3. Two properties are pinned, both against a real D1 mirror driving the
// REAL router (a revert of either half fails here):
//   1. CONTENT — a caller granted company A never receives a company-B user;
//      a zero-grant user stays visible to everyone (companyContext hands them
//      every company, so presence must not hide them); undefined allow-list
//      (legacy / master blip) shows all; [] (restricted to nothing) shows none.
//   2. CACHE — the edge entry is keyed on the company set, so one company's
//      roster is never served to the other off the shared cache. The OLD bug
//      was a single `scope=all` key: with the query scoped but the key shared,
//      the second company would HIT the first's fill and see its roster.
//
// The test D1 is migration-seeded and persists across runs, so setup is
// idempotent and every assertion is scoped to THESE three ids — other rows in
// the shared DB are irrelevant to the property under test.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import presence from "../src/routes/presence";

const CO_A = 1;
const CO_B = 2;

// High ids that will not collide with seeded users.
const U_A = 990001; // granted company A
const U_B = 990002; // granted company B
const U_NONE = 990003; // no grant -> every company
const MINE = [U_A, U_B, U_NONE];
const mineOnly = (ids: number[]) => ids.filter((id) => MINE.includes(id)).sort((a, b) => a - b);

const state = { allowed: undefined as number[] | undefined };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  const set = (c as { set: (k: string, v: unknown) => void }).set;
  set("user", { id: 999999, permissions: [], permissions_set: new Set<string>() });
  if (state.allowed !== undefined) set("allowedCompanyIds", state.allowed);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/presence", presence);

/** Call GET /api/presence as a caller with the given allow-list. `host` picks
 *  the cache origin — a unique host is a cold cache; a shared host is how the
 *  cross-serve test forces the two scopes to compete for one entry. */
async function roster(allowed: number[] | undefined, host: string) {
  state.allowed = allowed;
  const res = await app.request(`http://${host}/api/presence`, {}, env as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    active: Array<{ id: number }>; away: Array<{ id: number }>;
  };
  const ids = mineOnly([...body.active, ...body.away].map((r) => r.id));
  return { ids, cache: res.headers.get("x-presence-cache") };
}

describe("GET /api/presence — company scope", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, email TEXT, name TEXT, role_id INTEGER,
         last_seen_at TEXT, last_path TEXT, status TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_companies (user_id INTEGER, company_id INTEGER)`,
    ).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'Staff')`).run();

    // Idempotent: clear any prior run's rows for THESE ids.
    const inList = MINE.join(",");
    await env.DB.prepare(`DELETE FROM users WHERE id IN (${inList})`).run();
    await env.DB.prepare(`DELETE FROM user_companies WHERE user_id IN (${inList})`).run();

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    for (const [id, name] of [[U_A, "Ann"], [U_B, "Ben"], [U_NONE, "Cal"]] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, email, name, role_id, last_seen_at, last_path, status)
         VALUES (?, ?, ?, 1, ?, '/', 'active')`,
      ).bind(id, `${String(name).toLowerCase()}@x.my`, name, now).run();
    }
    await env.DB.prepare(`INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)`).bind(U_A, CO_A).run();
    await env.DB.prepare(`INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)`).bind(U_B, CO_B).run();
  });

  test("scopes the roster to the caller's granted companies; zero-grant stays visible", async () => {
    // Cold cache per case (unique host), so each asserts the QUERY, not a fill.
    const a = await roster([CO_A], "a.presence.test");
    expect(a.ids).toEqual([U_A, U_NONE]); // company A + the all-companies user; NOT U_B

    const b = await roster([CO_B], "b.presence.test");
    expect(b.ids).toEqual([U_B, U_NONE]); // company B + all-companies; NOT U_A

    const both = await roster([CO_A, CO_B], "both.presence.test");
    expect(both.ids).toEqual([U_A, U_B, U_NONE]);

    // UNRESOLVED (companies master blip / legacy single-company) — show all.
    const unresolved = await roster(undefined, "unresolved.presence.test");
    expect(unresolved.ids).toEqual([U_A, U_B, U_NONE]);

    // RESTRICTED TO NOTHING (grants all point at inactive companies) — fail
    // closed, same posture as the money/stock routes, not fail open.
    const none = await roster([], "none.presence.test");
    expect(none.ids).toEqual([]);
  });

  test("the cache key carries the company set — one company's roster never serves the other", async () => {
    const host = "shared.presence.test"; // SAME origin, so a shared key WOULD cross
    const a1 = await roster([CO_A], host);
    expect(a1.ids).toEqual([U_A, U_NONE]);
    expect(a1.cache).toBe("miss"); // first read fills the co=1 entry

    // Company B on the SAME origin: with the old single `scope=all` key this
    // would HIT company A's fill and leak U_A. It must MISS and return B's set.
    const b1 = await roster([CO_B], host);
    expect(b1.ids).toEqual([U_B, U_NONE]);
    expect(b1.ids).not.toContain(U_A);
    expect(b1.cache).toBe("miss");

    // Company A again HITS its own entry — proving the entries coexist, keyed
    // apart, rather than overwriting one another.
    const a2 = await roster([CO_A], host);
    expect(a2.ids).toEqual([U_A, U_NONE]);
    expect(a2.cache).toBe("hit");
  });
});
