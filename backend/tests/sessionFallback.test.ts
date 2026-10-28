import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getUserBySession } from "../src/services/auth";
import {
  rememberSessionLiveness,
  sessionLivenessFallback,
  isSessionFallbackEnabled,
  sessionFallbackTtlMs,
  __resetSessionLivenessForTest,
  __sessionLivenessStatsForTest,
  SESSION_FALLBACK_DEFAULT_TTL_MS,
  SESSION_FALLBACK_MIN_TTL_MS,
  SESSION_FALLBACK_MAX_TTL_MS,
} from "../src/services/sessionCache";
import type { Env } from "../src/types";

// Bounded short-TTL fallback for session revocation (approved by the owner
// 2026-07-22, WITH an off switch as the condition of approval). The Houzs DB
// layer has recurring brief blips (cold-start 503, Supavisor pooler hiccups);
// pure fail-closed logged the whole company out on every blip. When the switch
// SESSION_FALLBACK_ENABLED is "true", a DB-read FAILURE may re-serve the LAST
// authoritatively confirmed "active" result for a token while it is younger
// than the TTL, and otherwise still fails closed.
//
// THE SWITCH IS OFF BY DEFAULT and off must mean the path is not taken at all,
// so this suite has two halves:
//   • "switch OFF" — the default. getUserBySession fails closed on a DB read
//     failure exactly as it did before this mechanism existed, the fallback is
//     never CONSULTED (consultation counter stays 0), and no liveness state is
//     recorded (map size stays 0).
//   • "switch ON" — the four behaviours the mechanism promises: DB-up is
//     authoritative, DB-down + fresh entry is allowed, DB-down + stale or absent
//     entry is rejected, and a revocation propagates within the TTL.
// Every ON case must opt in explicitly via `withFallback(...)`, which is itself
// the proof that the shipped default is off.

let roleId = 0;
let userId = 0;
let token = "";

const sessionKey = () => `sess:${token}`;

async function seedSession(): Promise<void> {
  token = `session-fallback-${crypto.randomUUID()}`;
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'session fallback test', ?, 0)`,
  )
    .bind(`fallback-role-${crypto.randomUUID()}`, JSON.stringify(["*"]))
    .run();
  roleId = Number(role.meta.last_row_id);

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Fallback Test', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`fallback-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
}

/** The switch ON. Every ON case must ask for it explicitly — the ambient test
 *  `env` carries wrangler.toml's shipped default, which is OFF. */
function withFallback<T extends object>(base: T, ttlMs?: number): Env {
  return {
    ...base,
    SESSION_FALLBACK_ENABLED: "true",
    ...(ttlMs === undefined ? {} : { SESSION_FALLBACK_TTL_MS: String(ttlMs) }),
  } as unknown as Env;
}

/** The live DB, switch ON. */
const liveEnv = () => withFallback(env);

/** Warm the caches with a working DB so the in-memory liveness entry is fresh
 *  and active — exactly the state a live user's prior request would leave. */
async function warmLiveness() {
  const user = await getUserBySession(liveEnv(), token);
  expect(user?.id).toBe(userId);
  // The authoritative read just confirmed the session — the fallback now holds
  // a fresh entry we can rely on for the outage cases below.
  expect(sessionLivenessFallback(token)?.id).toBe(userId);
  return user!;
}

/** A DB whose every read/write rejects, standing in for a DB-layer outage
 *  (cold-start 503 / pooler hiccup). */
function makeDownDb(): any {
  const outage = () => Promise.reject(new Error("injected DB outage"));
  const stmt: any = {
    bind: () => stmt,
    first: outage,
    all: outage,
    run: outage,
  };
  return { prepare: () => stmt };
}

/** An Env in a DB outage with the fallback switch ON. KV is left working so
 *  getCachedUser still resolves — only the authoritative DB reads fail, which
 *  is the real scenario. */
function makeDownDbEnv(): Env {
  return withFallback({ DB: makeDownDb(), SESSION_CACHE: env.SESSION_CACHE });
}

/** The same outage with the switch left at its shipped default (OFF). */
function makeDownDbEnvSwitchOff(overrides: Record<string, string> = {}): Env {
  return {
    DB: makeDownDb(),
    SESSION_CACHE: env.SESSION_CACHE,
    ...overrides,
  } as unknown as Env;
}

beforeEach(async () => {
  __resetSessionLivenessForTest();
  await seedSession();
});

afterEach(async () => {
  __resetSessionLivenessForTest();
  await env.SESSION_CACHE.delete(sessionKey());
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  }
  if (userId) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  }
  if (roleId) {
    await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
  }
  roleId = 0;
  userId = 0;
  token = "";
});

describe("bounded short-TTL session-revocation fallback (switch ON)", () => {
  test("DB up is authoritative — a live DB read overrides any fallback entry", async () => {
    await warmLiveness();
    // Disable the user in the DB. The in-memory fallback still says "active",
    // but a reachable DB must win and the entry must be forgotten.
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`)
      .bind(userId)
      .run();

    expect(await getUserBySession(liveEnv(), token)).toBeNull();
    expect(sessionLivenessFallback(token)).toBeNull();
  });

  test("DB down + fresh cache → the request is allowed from the fallback", async () => {
    const warmed = await warmLiveness();

    const served = await getUserBySession(makeDownDbEnv(), token);
    expect(served?.id).toBe(userId);
    expect(served?.email).toBe(warmed.email);
  });

  test("a DB outage must not abandon the in-flight session-cache read", async () => {
    await warmLiveness();

    // Regression pin (2026-07-22). getUserBySession ran its KV read and its two
    // authoritative DB reads under Promise.all. Promise.all settles as soon as
    // the FIRST input rejects, so on the DB-outage path the function returned
    // from the bounded fallback while the KV read was still in flight. A storage
    // operation that outlives the request that started it is cancellable in
    // workerd, and it is what made the suite fail with "Failed to pop isolated
    // storage stack frame ... unable to pop KV storage". Assert the cache read
    // has SETTLED by the time the call resolves.
    let cacheReadSettled = false;
    const instrumentedCache = {
      get: async (key: string) => {
        const value = await env.SESSION_CACHE.get(key);
        // Yield across several turns so an abandoned read would still be pending
        // when the immediately-rejecting DB path returns.
        for (let i = 0; i < 5; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        cacheReadSettled = true;
        return value;
      },
      put: (...args: unknown[]) => (env.SESSION_CACHE as any).put(...args),
      delete: (...args: unknown[]) => (env.SESSION_CACHE as any).delete(...args),
    };

    const downEnv = withFallback({
      DB: makeDownDb(),
      SESSION_CACHE: instrumentedCache,
    });

    const served = await getUserBySession(downEnv, token);
    expect(served?.id).toBe(userId);
    expect(cacheReadSettled).toBe(true);
  });

  test("DB down + absent cache → fail closed (rejected)", async () => {
    // No warm read for this token, and the map was reset in beforeEach.
    expect(sessionLivenessFallback(token)).toBeNull();

    await expect(getUserBySession(makeDownDbEnv(), token)).rejects.toThrow(
      /injected DB outage/,
    );
  });

  test("DB down + stale cache (past TTL) → fail closed (rejected) and evicted", async () => {
    const warmed = await warmLiveness();
    // Age the recorded entry beyond the TTL to model an outage that outlasts the
    // accepted window.
    rememberSessionLiveness(
      token,
      warmed,
      Date.now() - SESSION_FALLBACK_DEFAULT_TTL_MS - 1_000,
    );

    await expect(getUserBySession(makeDownDbEnv(), token)).rejects.toThrow(
      /injected DB outage/,
    );
    // The stale entry is evicted on the failed lookup, so it cannot linger.
    expect(sessionLivenessFallback(token)).toBeNull();
  });

  test("a fresh cache exactly at the TTL boundary is already stale (>= TTL)", async () => {
    const warmed = await warmLiveness();
    const now = Date.now();
    rememberSessionLiveness(token, warmed, now - SESSION_FALLBACK_DEFAULT_TTL_MS);
    // The boundary is exclusive: an entry exactly TTL old no longer counts.
    expect(sessionLivenessFallback(token, now)).toBeNull();
    // One millisecond inside the window is still honoured.
    rememberSessionLiveness(token, warmed, now - SESSION_FALLBACK_DEFAULT_TTL_MS + 1);
    expect(sessionLivenessFallback(token, now)?.id).toBe(userId);
  });

  test("revocation is bounded: honoured within TTL during an outage, then rejected once stale and immediately once the DB returns", async () => {
    const warmed = await warmLiveness();
    // Admin revokes by deleting the session row directly — the same raw DELETE a
    // password reset / disable performs, and (like a revoke handled on another
    // isolate) it does NOT touch this isolate's in-memory fallback.
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();

    // 1) During an outage, a FRESH fallback still serves it — the accepted
    //    <= TTL availability window the owner signed off on.
    expect((await getUserBySession(makeDownDbEnv(), token))?.id).toBe(userId);

    // 2) Once the entry ages past the TTL, the outage stops keeping it alive.
    rememberSessionLiveness(
      token,
      warmed,
      Date.now() - SESSION_FALLBACK_DEFAULT_TTL_MS - 1,
    );
    await expect(getUserBySession(makeDownDbEnv(), token)).rejects.toThrow(
      /injected DB outage/,
    );

    // 3) The moment the DB is reachable again, the authoritative read rejects
    //    the deleted session regardless of any fallback entry, and forgets it.
    rememberSessionLiveness(token, warmed); // fresh again
    expect(await getUserBySession(liveEnv(), token)).toBeNull();
    expect(sessionLivenessFallback(token)).toBeNull();
  });

  test("a configured TTL replaces the 60s default", async () => {
    const warmed = await warmLiveness();
    // 5s TTL: an entry 6s old is already stale, though the 60s default would
    // still have honoured it.
    rememberSessionLiveness(token, warmed, Date.now() - 6_000);
    const env5s = withFallback(
      { DB: makeDownDb(), SESSION_CACHE: env.SESSION_CACHE },
      5_000,
    );
    await expect(getUserBySession(env5s, token)).rejects.toThrow(
      /injected DB outage/,
    );

    // The same entry age under the same outage is served when the TTL is 60s.
    rememberSessionLiveness(token, warmed, Date.now() - 6_000);
    expect((await getUserBySession(makeDownDbEnv(), token))?.id).toBe(userId);
  });
});

// ── The off switch — the owner's condition of approval ──────────────────────
// Off must mean the code path is NOT TAKEN, not "consulted then ignored".
describe("SESSION_FALLBACK_ENABLED — the off switch", () => {
  test("parse: OFF unless the value is exactly 'true' (case/space tolerant)", () => {
    // Absent / empty / anything else = OFF. A misspelt or half-written value can
    // never relax revocation.
    for (const e of [
      undefined,
      null,
      {},
      { SESSION_FALLBACK_ENABLED: "" },
      { SESSION_FALLBACK_ENABLED: "false" },
      { SESSION_FALLBACK_ENABLED: "FALSE" },
      { SESSION_FALLBACK_ENABLED: "0" },
      { SESSION_FALLBACK_ENABLED: "1" },
      { SESSION_FALLBACK_ENABLED: "yes" },
      { SESSION_FALLBACK_ENABLED: "enabled" },
      { SESSION_FALLBACK_ENABLED: "ture" },
    ]) {
      expect(isSessionFallbackEnabled(e)).toBe(false);
    }
    for (const raw of ["true", "TRUE", " true ", "True"]) {
      expect(isSessionFallbackEnabled({ SESSION_FALLBACK_ENABLED: raw })).toBe(true);
    }
  });

  test("parse: the TTL is configurable, clamped, and defaults to 60s", () => {
    expect(sessionFallbackTtlMs(undefined)).toBe(SESSION_FALLBACK_DEFAULT_TTL_MS);
    expect(sessionFallbackTtlMs({})).toBe(SESSION_FALLBACK_DEFAULT_TTL_MS);
    expect(sessionFallbackTtlMs({ SESSION_FALLBACK_TTL_MS: "5000" })).toBe(5_000);
    expect(sessionFallbackTtlMs({ SESSION_FALLBACK_TTL_MS: "1500.7" })).toBe(1_500);
    expect(
      sessionFallbackTtlMs({ SESSION_FALLBACK_TTL_MS: String(SESSION_FALLBACK_MIN_TTL_MS) }),
    ).toBe(SESSION_FALLBACK_MIN_TTL_MS);
    expect(
      sessionFallbackTtlMs({ SESSION_FALLBACK_TTL_MS: String(SESSION_FALLBACK_MAX_TTL_MS) }),
    ).toBe(SESSION_FALLBACK_MAX_TTL_MS);
    // Out of range / nonsense falls back to the default rather than failing the
    // request or accepting an unbounded window.
    for (const raw of ["0", "-1", "999999999", "abc", "", "NaN"]) {
      expect(sessionFallbackTtlMs({ SESSION_FALLBACK_TTL_MS: raw })).toBe(
        SESSION_FALLBACK_DEFAULT_TTL_MS,
      );
    }
  });

  test("OFF: a DB read failure fails closed even with a fresh liveness entry, and the fallback is NEVER consulted", async () => {
    // Warm with the switch ON so the map genuinely holds a fresh, DB-confirmed
    // entry — the most favourable possible state for the fallback.
    const warmed = await warmLiveness();
    expect(__sessionLivenessStatsForTest().size).toBe(1);

    // Zero the consultation counter, then run the outage with the switch at its
    // shipped default (absent = OFF).
    __resetSessionLivenessForTest();
    rememberSessionLiveness(token, warmed); // fresh entry, deliberately present
    const before = __sessionLivenessStatsForTest().consultations;

    await expect(
      getUserBySession(makeDownDbEnvSwitchOff(), token),
    ).rejects.toThrow(/injected DB outage/);

    // THE assertion the owner asked for: the fallback function was not called at
    // all. Not called and ignored — not called.
    expect(__sessionLivenessStatsForTest().consultations).toBe(before);
    // And the entry is untouched: a consultation would have read (and, once
    // stale, evicted) it.
    expect(__sessionLivenessStatsForTest().size).toBe(1);
  });

  test("OFF: an explicit 'false' behaves identically to an absent var", async () => {
    const warmed = await warmLiveness();
    __resetSessionLivenessForTest();
    rememberSessionLiveness(token, warmed);

    await expect(
      getUserBySession(
        makeDownDbEnvSwitchOff({ SESSION_FALLBACK_ENABLED: "false" }),
        token,
      ),
    ).rejects.toThrow(/injected DB outage/);
    expect(__sessionLivenessStatsForTest().consultations).toBe(0);
  });

  test("OFF: a TTL var alone cannot enable the fallback", async () => {
    const warmed = await warmLiveness();
    __resetSessionLivenessForTest();
    rememberSessionLiveness(token, warmed);

    await expect(
      getUserBySession(
        makeDownDbEnvSwitchOff({ SESSION_FALLBACK_TTL_MS: "300000" }),
        token,
      ),
    ).rejects.toThrow(/injected DB outage/);
    expect(__sessionLivenessStatsForTest().consultations).toBe(0);
  });

  test("OFF: successful authenticated requests accumulate no liveness state", async () => {
    // Cache-miss path (first read) and cache-hit path (second read) both record
    // liveness when the switch is on. With it off, neither may.
    __resetSessionLivenessForTest();
    const first = await getUserBySession(env as unknown as Env, token);
    expect(first?.id).toBe(userId);
    expect(__sessionLivenessStatsForTest().size).toBe(0);

    const second = await getUserBySession(env as unknown as Env, token);
    expect(second?.id).toBe(userId);
    expect(__sessionLivenessStatsForTest().size).toBe(0);
    expect(__sessionLivenessStatsForTest().consultations).toBe(0);
  });

  test("the shipped default is OFF — the ambient worker env does not enable it", () => {
    // wrangler.toml [vars] ships SESSION_FALLBACK_ENABLED = "false". If someone
    // flips that default, this fails and the switch-OFF cases above stop being
    // the default-behaviour proof they claim to be.
    expect(isSessionFallbackEnabled(env as unknown as Env)).toBe(false);
  });
});
