import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import posRoutes from "../src/routes/pos";
import soRouteSource from "../src/scm/routes/mfg-sales-orders.ts?raw";
import { auth } from "../src/middleware/auth";
import { createSession, SESSION_ORIGIN_POS } from "../src/services/auth";
import type { Env } from "../src/types";

/* ───────────────────────────────────────────────────────────────────────────
   OWNER RULING 2026-08-16 — an ERP session follows the ERP's rules.

   A salesperson signed in at the POS PIN door, tapped the tablet's "open in
   Houzs" button, landed on the ERP Sales Order screen, tried to change a
   delivery-fee line from 250 to 125, and was refused:

       422 so_total_below_original
       "Changes cannot reduce the bill below the original sales order total."

   Owner: 「为什么我们要跟着 POS 的规矩?进了这个 ERP 就跟这个 ERP 的规矩。
   在我们 ERP 里编辑,金额就必须能改。」

   The mechanism was POST /api/pos/exchange-web-session carrying the caller's
   `origin='pos'` onto the session it minted (added 2026-08-14 as an anti-tamper
   tightening). Everything the SO pricing envelope refuses is gated on exactly
   one expression — `isPosTabletCaller(c)`, i.e.
   `c.get('sessionOrigin') === SESSION_ORIGIN_POS` — so the ONE fact that decides
   all of it is what `middleware/auth` publishes for the token in hand.

   These tests pin both halves of the ruling:
     · the SSO door mints an ERP session      (the exchange drops the origin)
     · the PIN door is untouched              (the real POS keeps every gate)
   ─────────────────────────────────────────────────────────────────────────── */

let roleId = 0;
let userId = 0;
const mintedTokens: string[] = [];

/** Mint through the REAL createSession, the same call the PIN door makes. */
async function mint(origin?: typeof SESSION_ORIGIN_POS): Promise<string> {
  const token = await createSession(env as unknown as Env, userId, origin);
  mintedTokens.push(token);
  return token;
}

async function originOf(token: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT origin FROM sessions WHERE token = ?`)
    .bind(token)
    .first<{ origin: string | null }>();
  expect(row, `no session row for ${token}`).not.toBeNull();
  return row!.origin ?? null;
}

/** What `middleware/auth` republishes as `sessionOrigin` for this token — the
 *  single channel `isPosTabletCaller` is allowed to read (mig 0120). */
async function publishedOrigin(token: string): Promise<string | undefined> {
  let seen: string | undefined;
  let sawHandler = false;
  const app = new Hono<{ Bindings: Env }>();
  app.use("/probe", auth);
  app.get("/probe", (c) => {
    sawHandler = true;
    seen = c.get("sessionOrigin");
    return c.json({ ok: true });
  });
  const res = await app.request(
    "/probe",
    { headers: { Authorization: `Bearer ${token}` } },
    env as never,
  );
  expect(res.status, "the probe must reach the handler, not 401").toBe(200);
  expect(sawHandler).toBe(true);
  return seen;
}

async function exchange(token: string): Promise<{ status: number; token: string }> {
  const res = await posRoutes.request(
    "/exchange-web-session",
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    env as never,
  );
  const body = (await res.json()) as { token?: string };
  if (body.token) mintedTokens.push(body.token);
  return { status: res.status, token: String(body.token ?? "") };
}

beforeEach(async () => {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'pos exchange origin test', ?, 0)`,
  )
    .bind(`pos-origin-role-${crypto.randomUUID()}`, JSON.stringify(["*"]))
    .run();
  roleId = Number(role.meta.last_row_id);

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'POS Salesperson', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`pos-origin-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);
});

afterEach(async () => {
  for (const t of mintedTokens) {
    await env.SESSION_CACHE.delete(`sess:${t}`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(t).run();
  }
  mintedTokens.length = 0;
  if (userId) await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  if (roleId) {
    await env.DB.prepare(`DELETE FROM role_page_access WHERE role_id = ?`).bind(roleId).run();
    await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
  }
  userId = 0;
  roleId = 0;
});

describe("POST /api/pos/exchange-web-session — the ERP door mints an ERP session", () => {
  test("the exchanged session row carries NO origin", async () => {
    const posToken = await mint(SESSION_ORIGIN_POS);
    expect(await originOf(posToken)).toBe(SESSION_ORIGIN_POS);

    const { status, token: webToken } = await exchange(posToken);
    expect(status).toBe(200);
    expect(webToken).not.toBe("");
    expect(webToken).not.toBe(posToken);

    expect(await originOf(webToken)).toBeNull();
  });

  test("the exchanged token reads as NOT-POS on the one channel the gate consults", async () => {
    const posToken = await mint(SESSION_ORIGIN_POS);
    const { token: webToken } = await exchange(posToken);

    const published = await publishedOrigin(webToken);
    expect(published).toBeUndefined();
    /* This IS the body of isPosTabletCaller, evaluated against a real session
       minted by the real endpoint and republished by the real middleware. False
       here means every so_total_below_original / pricing_drift refusal is off
       and trustOperatorSelling is on, for this session, on every SO route. */
    expect(published === SESSION_ORIGIN_POS).toBe(false);
  });

  test("the exchange does not touch the session it was exchanged FROM", async () => {
    const posToken = await mint(SESSION_ORIGIN_POS);
    await exchange(posToken);

    expect(await originOf(posToken)).toBe(SESSION_ORIGIN_POS);
    expect(await publishedOrigin(posToken)).toBe(SESSION_ORIGIN_POS);
  });

  test("an origin-less office session exchanges to an origin-less session (unchanged)", async () => {
    const officeToken = await mint();
    expect(await originOf(officeToken)).toBeNull();

    const { status, token: webToken } = await exchange(officeToken);
    expect(status).toBe(200);
    expect(await originOf(webToken)).toBeNull();
    expect(await publishedOrigin(webToken)).toBeUndefined();
  });

  test("an unauthenticated exchange is still refused", async () => {
    const res = await posRoutes.request(
      "/exchange-web-session",
      { method: "POST" },
      env as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("the REAL POS surface is unchanged", () => {
  /* The ruling loosens the ERP, not the POS. A session minted at the PIN door
     and used by the POS app itself must still read as POS everywhere. These
     pass before and after the change, on purpose: they are the guard that the
     fix did not reach past the door it was aimed at. */

  test("a PIN-door session still stores origin='pos'", async () => {
    const posToken = await mint(SESSION_ORIGIN_POS);
    expect(await originOf(posToken)).toBe(SESSION_ORIGIN_POS);
  });

  test("a PIN-door session still publishes sessionOrigin='pos' to every route", async () => {
    const posToken = await mint(SESSION_ORIGIN_POS);
    const published = await publishedOrigin(posToken);
    expect(published).toBe(SESSION_ORIGIN_POS);
    // isPosTabletCaller's body, again — true, so the tablet keeps every gate.
    expect(published === SESSION_ORIGIN_POS).toBe(true);
  });

  test("/pin-login is still the only writer of SESSION_ORIGIN_POS", async () => {
    /* If a second door ever stamps 'pos', the two tests above stop describing
       the whole POS surface. Source-level because there is no runtime way to
       enumerate callers. */
    const posSource = (await import("../src/routes/pos.ts?raw")).default as string;
    const stampers = posSource
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((l) => /createSession\(/.test(l.line) && /SESSION_ORIGIN_POS/.test(l.line));
    expect(stampers.map((s) => s.line)).toEqual([
      "const token = await createSession(c.env, Number(row!.user_id), SESSION_ORIGIN_POS);",
    ]);
  });
});

describe("the population this ruling turns off", () => {
  test("every POS-gated refusal in the SO routes hangs off isPosTabletCaller", () => {
    /* The reasoning above is only sound while `sessionOrigin` has exactly ONE
       reader in the SO routes. If a handler starts reading the context var
       directly, proving `sessionOrigin === undefined` no longer proves the
       refusals are off, and this test says so. */
    const reads = soRouteSource.split("c.get('sessionOrigin')").length - 1;
    expect(reads).toBe(1);
    expect(soRouteSource).toContain(
      "async function isPosTabletCaller(c: PosCallerSource): Promise<boolean> {\n" +
        "  return c.get('sessionOrigin') === SESSION_ORIGIN_POS;\n" +
        "}",
    );
  });

  test("the refusals it gates are the five money floors and the four drift 400s", () => {
    const count = (rx: RegExp) => (soRouteSource.match(rx) ?? []).length;
    expect(count(/error:\s*'so_total_below_original'/g)).toBe(5);
    expect(count(/error:\s*'pricing_drift'/g)).toBe(4);
    expect(count(/await isPosTabletCaller\(c\)/g)).toBe(9);
  });
});
