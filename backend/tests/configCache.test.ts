// ----------------------------------------------------------------------------
// configCache — scope-keyed read cache for hot config endpoints.
//
// The load-bearing claims here are the SECURITY ones, pinned in BOTH
// directions for every per-company cached endpoint: company A's cached
// response must never answer company B, and company B must still get its own
// data while A's entry is live. Plus the invalidation story (a write bumps the
// family version and orphans every entry) and the bypass rule (an UNRESOLVED
// company scope must never mint a shared cache key).
//
// Harness notes:
//   - Real KV (SESSION_CACHE) + real caches.default from the workers pool.
//     isolatedStorage undoes per-test writes, so each flow lives in ONE test.
//   - /api/branding is driven through the REAL router against the isolated D1
//     (app_settings exists in the D1 test tree), with a bare-app middleware
//     standing in for companyContext — the fairReport.route.test.ts pattern.
//   - /maintenance-config/resolved + POST /changes are driven through the
//     EXPORTED handlers with a fake PostgREST builder (supabaseAuth cannot run
//     in the harness), same precedent.
//   - The announcements table is pg-only (mig 0058) — a minimal D1 mirror is
//     created here so the REAL banner/ack/create handlers can run.
// ----------------------------------------------------------------------------

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import brandingRoutes from "../src/routes/branding";
import announcementRoutes from "../src/routes/announcements";
import {
  resolvedHandler,
  createChangeHandler,
} from "../src/scm/routes/maintenance-config";
import {
  CONFIG_CACHE_TTL_SECONDS,
  bannerCacheKey,
  bumpConfigVersion,
  bustBannerForUser,
  configCacheKeyUrl,
  configCacheMatch,
  configCachePut,
  configCacheVersion,
} from "../src/services/configCache";
import { postPersonalNotice } from "../src/services/personalNotice";

const kvEnv = env as any;

// ── Unit: version segment + key construction ────────────────────────────────

describe("version segment + key construction", () => {
  test("KV unbound → version null (cache bypass), bump is a no-op", async () => {
    expect(await configCacheVersion({} as any, "branding")).toBeNull();
    await bumpConfigVersion({} as any, "branding"); // must not throw
  });

  test("version starts stable and bumps strictly monotonically", async () => {
    const v0 = await configCacheVersion(kvEnv, "maintcfg");
    expect(v0).not.toBeNull();
    await bumpConfigVersion(kvEnv, "maintcfg");
    const v1 = await configCacheVersion(kvEnv, "maintcfg");
    await bumpConfigVersion(kvEnv, "maintcfg");
    const v2 = await configCacheVersion(kvEnv, "maintcfg");
    expect(v1!).toBeGreaterThan(v0!);
    expect(v2!).toBeGreaterThan(v1!);
  });

  test("distinct companies mint distinct keys — both directions", () => {
    const a = configCacheKeyUrl("https://erp.test", "branding", "co=HOUZS", 7);
    const b = configCacheKeyUrl("https://erp.test", "branding", "co=2990", 7);
    expect(a).toBe("https://erp.test/__config-cache/branding?co=HOUZS&v=7");
    expect(b).toBe("https://erp.test/__config-cache/branding?co=2990&v=7");
    expect(a).not.toBe(b);
    // maintcfg flavour: the company id + scope + asOf all key.
    const m1 = configCacheKeyUrl("https://erp.test", "maintcfg", "co=1&scope=master&asOf=2026-07-19", 7);
    const m2 = configCacheKeyUrl("https://erp.test", "maintcfg", "co=2&scope=master&asOf=2026-07-19", 7);
    expect(m1).not.toBe(m2);
  });

  test("a version bump changes the key (old entries orphaned)", () => {
    const before = configCacheKeyUrl("https://erp.test", "maintcfg", "co=1", 7);
    const after = configCacheKeyUrl("https://erp.test", "maintcfg", "co=1", 8);
    expect(before).not.toBe(after);
  });

  test("an EMPTY scope key refuses to mint a shared key", () => {
    expect(configCacheKeyUrl("https://erp.test", "branding", "", 7)).toBeNull();
  });

  test("banner TTL stays COMFORTABLY above the 60s frontend poll (never == poll)", () => {
    // A TTL == poll expires the entry exactly as the next poll arrives, so every
    // poll misses and rebuilds the full feed (measured live ~900ms/60s on
    // 2026-08-18). Guard against a re-lowering back to 60.
    const POLL_MS = 60; // useAnnouncementBanner.ts POLL_MS / 1000
    expect(CONFIG_CACHE_TTL_SECONDS.banner).toBeGreaterThan(POLL_MS);
    expect(CONFIG_CACHE_TTL_SECONDS.banner).toBeGreaterThanOrEqual(POLL_MS * 2);
  });
});

// ── Storage layer: Cache API never crosses scope keys ───────────────────────

describe("Cache API storage layer", () => {
  test("company A's entry never answers company B — both directions", async () => {
    const keyA = configCacheKeyUrl("https://erp.test", "maintcfg", "co=1&scope=master&asOf=2026-07-19", 1)!;
    const keyB = configCacheKeyUrl("https://erp.test", "maintcfg", "co=2&scope=master&asOf=2026-07-19", 1)!;

    await configCachePut(keyA, JSON.stringify({ co: "one" }), 120);
    // Direction 1: B misses while A's entry is live.
    expect(await configCacheMatch(keyB)).toBeNull();
    const hitA = await configCacheMatch(keyA);
    expect(hitA).not.toBeNull();
    expect(await hitA!.json()).toEqual({ co: "one" });

    // Direction 2: B stores its own; A still serves A's.
    await configCachePut(keyB, JSON.stringify({ co: "two" }), 120);
    const hitA2 = await configCacheMatch(keyA);
    const hitB = await configCacheMatch(keyB);
    expect(await hitA2!.json()).toEqual({ co: "one" });
    expect(await hitB!.json()).toEqual({ co: "two" });
  });

  test("banner keys are per-user AND per-scope; a human entry never answers system", () => {
    // per-user
    expect(bannerCacheKey(5, 101, "human")).not.toBe(bannerCacheKey(5, 202, "human"));
    // per-version
    expect(bannerCacheKey(5, 101, "human")).not.toBe(bannerCacheKey(6, 101, "human"));
    // per-SCOPE — the same user/version, different slice, must key apart, or
    // one scope's payload could be served for the other.
    expect(bannerCacheKey(5, 101, "human")).not.toBe(bannerCacheKey(5, 101, "system"));
  });

  test("bust hits ONLY the target user — and ALL of that user's scopes", async () => {
    const v = await configCacheVersion(kvEnv, "banner");
    await kvEnv.SESSION_CACHE.put(bannerCacheKey(v!, 101, "human"), "A-human");
    await kvEnv.SESSION_CACHE.put(bannerCacheKey(v!, 101, "system"), "A-system");
    await kvEnv.SESSION_CACHE.put(bannerCacheKey(v!, 202, "human"), "B-human");
    await bustBannerForUser(kvEnv, 101);
    // both of user 101's slices are gone
    expect(await kvEnv.SESSION_CACHE.get(bannerCacheKey(v!, 101, "human"))).toBeNull();
    expect(await kvEnv.SESSION_CACHE.get(bannerCacheKey(v!, 101, "system"))).toBeNull();
    // user 202 is untouched
    expect(await kvEnv.SESSION_CACHE.get(bannerCacheKey(v!, 202, "human"))).toBe("B-human");
  });
});

// ── /api/branding through the real router (PER-COMPANY, Cache API) ─────────
//
// Company codes: HOUZS (legacy 'branding' row) and ACME — a non-numeric code
// resolveCompanyCode passes through deterministically with or without a
// companies master in the D1 mirror (its row key is 'branding:ACME').

const brandingState = {
  companyCode: undefined as string | undefined,
  user: undefined as any,
};
const brandingApp = new Hono();
brandingApp.use("*", async (c: any, next: any) => {
  c.set("user", brandingState.user);
  if (brandingState.companyCode) c.set("companyCode", brandingState.companyCode);
  await next();
});
brandingApp.route("/api/branding", brandingRoutes);

const ADMIN = { id: 1, email: "it@test.local", permissions: ["*"], permissions_set: new Set(["*"]) };

async function getBranding(companyCode: string, testEnv: any = env) {
  brandingState.companyCode = companyCode;
  brandingState.user = ADMIN;
  const res = await brandingApp.request("/api/branding", {}, testEnv);
  expect(res.status).toBe(200);
  return { cache: res.headers.get("x-config-cache"), body: (await res.json()) as any };
}

describe("/api/branding — per-company cache", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('branding', ?)`,
    ).bind(JSON.stringify({ companyName: "Houzs Base" })).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('branding:ACME', ?)`,
    ).bind(JSON.stringify({ companyName: "ACME Co" })).run();
  });

  test("company A's cached response never serves company B — both directions", async () => {
    // Prime A (miss → cached).
    const a1 = await getBranding("HOUZS");
    expect(a1.cache).toBe("miss");
    expect(a1.body.branding.companyName).toBe("Houzs Base");
    expect(a1.body.companyCode).toBe("HOUZS");

    // Direction 1: B's FIRST read is a MISS (distinct key) with B's OWN data,
    // even while A's entry is live in the shared cache.
    const b1 = await getBranding("ACME");
    expect(b1.cache).toBe("miss");
    expect(b1.body.branding.companyName).toBe("ACME Co");
    expect(b1.body.companyCode).toBe("ACME");

    // Direction 2: with B's entry now ALSO live, A still gets A's data — and
    // from the cache, proving the cache (not a lucky rebuild) answered.
    const a2 = await getBranding("HOUZS");
    expect(a2.cache).toBe("hit");
    expect(a2.body.branding.companyName).toBe("Houzs Base");
    expect(a2.body.companyCode).toBe("HOUZS");

    const b2 = await getBranding("ACME");
    expect(b2.cache).toBe("hit");
    expect(b2.body.branding.companyName).toBe("ACME Co");
  });

  test("a write bumps the version: the editor sees their change, the other company keeps its own", async () => {
    // Prime both companies into the cache.
    await getBranding("HOUZS");
    await getBranding("ACME");
    expect((await getBranding("HOUZS")).cache).toBe("hit");

    // Owner edits HOUZS branding (real PUT through the router → real
    // setBrandingForCompany → bumpConfigVersion).
    brandingState.companyCode = "HOUZS";
    brandingState.user = ADMIN;
    const put = await brandingApp.request(
      "/api/branding",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyName: "Houzs Renamed" }),
      },
      env,
    );
    expect(put.status).toBe(200);

    // The next read is a MISS (old entries orphaned) carrying the NEW value.
    const a = await getBranding("HOUZS");
    expect(a.cache).toBe("miss");
    expect(a.body.branding.companyName).toBe("Houzs Renamed");

    // The other company rebuilds too (family-wide bump) but keeps ITS data.
    const b = await getBranding("ACME");
    expect(b.body.branding.companyName).toBe("ACME Co");
  });

  test("KV unbound → full bypass, response still correct", async () => {
    // Vitest Pool Workers 0.18 isolates storage per file (not per test). Reset
    // the row changed by the preceding write/invalidation test explicitly.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('branding', ?)`,
    ).bind(JSON.stringify({ companyName: "Houzs Base" })).run();
    const noKv = { DB: env.DB };
    const r1 = await getBranding("HOUZS", noKv);
    const r2 = await getBranding("HOUZS", noKv);
    expect(r1.cache).toBe("bypass");
    expect(r2.cache).toBe("bypass"); // never a hit — nothing was cached
    expect(r2.body.branding.companyName).toBe("Houzs Base");
  });
});

// ── /maintenance-config/resolved via exported handlers (PER-COMPANY) ────────

class FakeQuery {
  private preds: Array<(r: any) => boolean> = [];
  private sorts: Array<{ col: string; asc: boolean }> = [];
  private _limit: number | null = null;
  constructor(private rows: any[]) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  lte(col: string, val: any) { this.preds.push((r) => r[col] != null && r[col] <= val); return this; }
  gt(col: string, val: any) { this.preds.push((r) => r[col] != null && r[col] > val); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.sorts.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this._limit = n; return this; }
  private apply() {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    for (const s of [...this.sorts].reverse()) {
      out = [...out].sort(
        (a, b) => ((a[s.col] < b[s.col] ? -1 : a[s.col] > b[s.col] ? 1 : 0)) * (s.asc ? 1 : -1),
      );
    }
    if (this._limit != null) out = out.slice(0, this._limit);
    return out;
  }
  maybeSingle() { const out = this.apply(); return Promise.resolve({ data: out[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.apply(), error: null }).then(res, rej);
  }
}
class FakeInsert {
  constructor(private row: any) {}
  select() { return this; }
  single() { return Promise.resolve({ data: this.row, error: null }); }
}
function fakeSb(data: Record<string, any[]>) {
  return {
    from(table: string) {
      return {
        select: () => new FakeQuery(data[table] ?? []),
        insert: (obj: any) => new FakeInsert({ ...obj, created_at: "2026-07-19T00:00:00Z" }),
      };
    },
  } as any;
}

const MC_ROWS = [
  { id: "mch-1", company_id: 1, scope: "master", config: { anchor: "company-one" }, effective_from: "2020-01-01", notes: null, created_at: "2020-01-01T00:00:00Z", created_by: null },
  { id: "mch-2", company_id: 2, scope: "master", config: { anchor: "company-two" }, effective_from: "2020-01-01", notes: null, created_at: "2020-01-01T00:00:00Z", created_by: null },
];

const mcState = {
  companyId: undefined as number | undefined,
  allowed: undefined as number[] | undefined,
};
const mcApp = new Hono();
mcApp.use("*", async (c: any, next: any) => {
  c.set("supabase", fakeSb({ maintenance_config_history: MC_ROWS }));
  c.set("houzsUser", { id: 9, permissions_set: new Set(["*"]) });
  c.set("user", { id: "00000000-0000-0000-0000-000000000001" });
  if (mcState.companyId != null) c.set("companyId", mcState.companyId);
  if (mcState.allowed !== undefined) c.set("allowedCompanyIds", mcState.allowed);
  await next();
});
mcApp.get("/resolved", resolvedHandler as any);
mcApp.post("/changes", createChangeHandler as any);

async function getResolved(companyId: number | undefined, allowed?: number[]) {
  mcState.companyId = companyId;
  mcState.allowed = allowed;
  const res = await mcApp.request("/resolved?scope=master", {}, env as any);
  expect(res.status).toBe(200);
  return { cache: res.headers.get("x-config-cache"), body: (await res.json()) as any };
}

describe("/maintenance-config/resolved — per-company cache", () => {
  test("company A's cached response never serves company B — both directions", async () => {
    const a1 = await getResolved(1);
    expect(a1.cache).toBe("miss");
    expect(a1.body.data).toEqual({ anchor: "company-one" });

    // Direction 1: company 2's FIRST read misses (distinct key) and carries
    // company 2's OWN config while company 1's entry is live.
    const b1 = await getResolved(2);
    expect(b1.cache).toBe("miss");
    expect(b1.body.data).toEqual({ anchor: "company-two" });

    // Direction 2: both entries live — each company keeps getting its own.
    const a2 = await getResolved(1);
    expect(a2.cache).toBe("hit");
    expect(a2.body.data).toEqual({ anchor: "company-one" });
    const b2 = await getResolved(2);
    expect(b2.cache).toBe("hit");
    expect(b2.body.data).toEqual({ anchor: "company-two" });
  });

  test("POST /changes bumps the family version and orphans every entry", async () => {
    await getResolved(1);
    await getResolved(2);
    expect((await getResolved(1)).cache).toBe("hit");

    mcState.companyId = 1;
    const post = await mcApp.request(
      "/changes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "master", config: { anchor: "updated" }, effectiveFrom: "2026-01-01" }),
      },
      env as any,
    );
    expect(post.status).toBe(201);

    // Every company rebuilds fresh — no orphaned entry answers.
    expect((await getResolved(1)).cache).toBe("miss");
    expect((await getResolved(2)).cache).toBe("miss");
    // And re-caches under the new version.
    expect((await getResolved(2)).cache).toBe("hit");
  });

  test("UNRESOLVED company scope BYPASSES the cache — a scope-less key is never minted", async () => {
    const u1 = await getResolved(undefined);
    const u2 = await getResolved(undefined);
    expect(u1.cache).toBe("bypass");
    expect(u2.cache).toBe("bypass"); // repeat call did NOT hit — nothing was stored
    // A resolved company afterwards still builds its own scoped answer.
    const a = await getResolved(1);
    expect(a.body.data).toEqual({ anchor: "company-one" });
  });

  test("restricted-to-no-company also bypasses and stays empty", async () => {
    const r = await getResolved(undefined, []);
    expect(r.cache).toBe("bypass");
    expect(r.body.data).toBeNull();
  });
});

// ── /api/announcements/banner via the real router (PER-USER, KV) ────────────

const bannerState = { user: undefined as any };
const annApp = new Hono();
annApp.use("*", async (c: any, next: any) => {
  c.set("user", bannerState.user);
  await next();
});
annApp.route("/api/announcements", announcementRoutes);

const USER_A = { id: 101, department_id: null, position_id: null, permissions: [] as string[], permissions_set: new Set<string>() };
const USER_B = { id: 202, department_id: null, position_id: null, permissions: [] as string[], permissions_set: new Set<string>() };
const MANAGER = { id: 300, department_id: null, position_id: null, permissions: ["*"], permissions_set: new Set(["*"]) };

async function getBanner(user: any, scope?: "human" | "system") {
  bannerState.user = user;
  const path = scope
    ? `/api/announcements/banner?scope=${scope}`
    : "/api/announcements/banner";
  const res = await annApp.request(path, {}, env as any);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return {
    cache: res.headers.get("x-config-cache"),
    ids: (body.data ?? []).map((a: any) => a.id) as string[],
    ackedIds: (body.ackedIds ?? []) as string[],
  };
}

describe("/api/announcements/banner — per-user cache", () => {
  beforeAll(async () => {
    // Minimal D1 mirror of the pg-only announcements tables (mig 0058/0113/
    // 0140) — just the columns the handlers read/write.
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER, require_ack INTEGER, scheduled_at TEXT,
         target_divisions TEXT, excluded_user_ids TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT, user_id INTEGER, acked_at TEXT, company_id INTEGER,
         PRIMARY KEY (announcement_id, user_id))`,
    ).run();
  });

  test("per-user keys: one user's cached banner never serves another; targeted busts and version bumps land", async () => {
    // Prime BOTH users on an empty table.
    const a1 = await getBanner(USER_A);
    expect(a1.cache).toBe("miss");
    expect(a1.ids).toEqual([]);
    const b1 = await getBanner(USER_B);
    expect(b1.cache).toBe("miss"); // distinct key — did not hit A's entry
    expect((await getBanner(USER_A)).cache).toBe("hit");

    // A PRIVATE notice for A busts exactly A's snapshot (postPersonalNotice).
    // It is a MACHINE notice (source non-null), so A's rebuilt POP-UP slice
    // stays empty — machine notices never pop a banner (owner 2026-08-08);
    // the notice is delivered on the BELL slice (scope=system) instead.
    await postPersonalNotice(env as any, {
      userIds: [USER_A.id],
      category: "GENERAL",
      title: "Private ping",
      body: "for A only",
      source: "test-src",
    });
    const a2 = await getBanner(USER_A);
    expect(a2.cache).toBe("miss"); // busted → rebuilt
    expect(a2.ids).toEqual([]); // ...but the pop-up slice excludes it
    const aSys = await getBanner(USER_A, "system");
    expect(aSys.cache).toBe("miss"); // bell slice is cached now — first read misses
    expect(aSys.ids.length).toBe(1);
    const privateId = aSys.ids[0];

    // The bell slice is now cached, keyed on scope: a 2nd system read HITS...
    const aSys2 = await getBanner(USER_A, "system");
    expect(aSys2.cache).toBe("hit");
    expect(aSys2.ids).toEqual([privateId]);
    // ...and that system entry NEVER answers the human slice for the same user:
    // A's human read still hits its OWN (empty) entry, not the 1-id system one.
    const aHuman = await getBanner(USER_A, "human");
    expect(aHuman.cache).toBe("hit");
    expect(aHuman.ids).toEqual([]);

    // Direction check: B's banner (cached or rebuilt) NEVER shows A's private
    // notice — and B's entry was untouched by A's bust.
    const b2 = await getBanner(USER_B);
    expect(b2.cache).toBe("hit");
    expect(b2.ids).not.toContain(privateId);
    expect((await getBanner(USER_B, "system")).ids).not.toContain(privateId);

    // A acks → only A's snapshot busts; the ack lands on the bell slice's
    // ackedIds (the pop-up slice never carries the machine notice at all).
    bannerState.user = USER_A;
    const ack = await annApp.request(
      `/api/announcements/${privateId}/ack`,
      { method: "POST" },
      env as any,
    );
    expect(ack.status).toBe(200);
    const a3 = await getBanner(USER_A);
    expect(a3.cache).toBe("miss");
    expect((await getBanner(USER_A, "system")).ackedIds).toContain(privateId);

    // A broadcast create bumps the FAMILY version — every user rebuilds and
    // sees it, while per-user separation still holds.
    bannerState.user = MANAGER;
    const created = await annApp.request(
      "/api/announcements",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Broadcast to all" }),
      },
      env as any,
    );
    expect(created.status).toBe(201);
    const createdId = ((await created.json()) as any).data.id as string;

    const a4 = await getBanner(USER_A);
    const b4 = await getBanner(USER_B);
    expect(a4.cache).toBe("miss");
    expect(b4.cache).toBe("miss");
    expect(a4.ids).toContain(createdId);
    expect(b4.ids).toContain(createdId);
    // The machine notice stays off the pop-up slice for everyone; A still has
    // it on the bell slice, B still does not.
    expect(a4.ids).not.toContain(privateId);
    expect(b4.ids).not.toContain(privateId);
    expect((await getBanner(USER_A, "system")).ids).toContain(privateId);
  });
});


// ── The banner bust is WIRED into every targeting-change route ───────────────
//
// The 300s banner TTL (> the 60s poll) is only correct if an edit that moves a
// user between audiences clears their snapshot. bustBannerForUser (both scopes)
// is proven above; this pins that the production ROUTES actually call it at
// every targeting-change site. It is a SOURCE-STRUCTURE test, on purpose: the
// users / departments routes use getDb (drizzle -> postgres), and this vitest
// harness has NO postgres binding (DATABASE_URL is empty), so those handlers
// cannot be executed here — the same reason mailAliasRevocation.test.ts asserts
// the users PATCH by reading its source. The behavioural both-scope clear lives
// in the bustBannerForUser test above.

const routeSrc = import.meta.glob(
  ["../src/routes/users.ts", "../src/routes/departments.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const usersSrc = Object.entries(routeSrc).find(([k]) => k.includes("users.ts"))![1];
const deptsSrc = Object.entries(routeSrc).find(([k]) => k.includes("departments.ts"))![1];

describe("banner bust is wired into every targeting-change route", () => {
  test("users PATCH busts the banner whenever a targeting field changes", () => {
    const start = usersSrc.indexOf('app.patch("/:id"');
    const end = usersSrc.indexOf("app.", start + 1);
    const handler = usersSrc.slice(start, end === -1 ? undefined : end);
    // The predicate covers every field the banner filters on (dept / position /
    // company grants) PLUS role/status, and gates a bustBannerForUser call.
    expect(handler).toContain("bannerTargetingChanged");
    for (const field of [
      '"department_id" in set',
      '"position_id" in set',
      '"role_id" in set',
      '"status" in set',
      "finalDeptIds !== null",
      "hasCompanyChange",
    ]) {
      expect(handler).toContain(field);
    }
    expect(handler).toMatch(/if \(bannerTargetingChanged\)\s*{\s*await bustBannerForUser\(c\.env, id\);/);
  });

  test("users PUT /:id/companies busts the banner after changing grants", () => {
    const start = usersSrc.indexOf('app.put("/:id/companies"');
    const end = usersSrc.indexOf("app.", start + 1);
    const handler = usersSrc.slice(start, end === -1 ? undefined : end);
    expect(handler).toContain("setUserCompanies(");
    expect(handler).toContain("bustBannerForUser(c.env, id)");
  });

  test("users DELETE busts the banner for the removed user", () => {
    const start = usersSrc.indexOf('app.delete("/:id"');
    const handler = usersSrc.slice(start);
    expect(handler).toContain("bustBannerForUser(c.env, id)");
  });

  test("departments DELETE bumps the banner family version after un-assigning members", () => {
    const start = deptsSrc.indexOf('app.delete("/:id"');
    const handler = deptsSrc.slice(start);
    const nullAt = handler.indexOf("UPDATE users SET department_id = NULL");
    const bumpAt = handler.indexOf('bumpConfigVersion(c.env, "banner")');
    expect(nullAt).toBeGreaterThan(-1);
    expect(bumpAt).toBeGreaterThan(nullAt); // bump AFTER the members are un-assigned
  });
});
