import { Hono } from "hono";
import type { Env } from "../types";
import {
  hashPassword,
  verifyPassword,
  createSession,
  mintSessionPass,
  deleteSession,
  pruneExpiredSessions,
  getUserBySession,
  generateToken,
  isoIn,
  timingSafeEqualStr,
  REMEMBER_TTL_SECONDS,
} from "../services/auth";
import { bustUserSessions } from "../services/sessionCache";
import { isFinanceViewer, isProductCostViewer } from "../services/pmsAccess";
import { userCanWriteScmConfig } from "../services/positionPolicy";
import { resolveCapabilities } from "../services/capabilities";
import { isCostingDisplayEnabled } from "../scm/lib/costing-enabled";
import { sendEmail, publicUrl, resetEmailHtml, inviteEmailHtml, erpProductName } from "../services/email";
import { getBrandingForCompany } from "../services/branding";
import { defaultCompanyCodeForHost } from "../middleware/companyContext";
import { validatePasswordStrength } from "../services/passwordStrength";
import { verifyTotp, consumeBackupCode } from "../services/totp";
import { checkRateLimit, clearRateLimit, clientIp } from "../middleware/rateLimit";

/**
 * Auth routes — UNAUTHENTICATED entry points.
 *
 * Mounted at /api/auth/* OUTSIDE the auth middleware so unauthenticated
 * users can hit /login, /bootstrap, /accept-invite. /me and /logout
 * require a valid bearer token.
 */
const app = new Hono<{ Bindings: Env }>();

/* A real PBKDF2 record in the stored `salt$hash` shape, derived from a string
   that is not anyone's password. It exists ONLY so that a login attempt for an
   address with no account performs the same 100k-iteration derivation as one
   that does — see the login handler. It is never compared against successfully;
   nothing authenticates with it. */
const TIMING_EQUALISER_HASH =
  "BF3yX+3ocRPnH9KBKydn5A==$5iHFIc7Z3t8/vEm8jA4GuwdjcaL5/yajl4dWitx/PBU=";

const RESET_TTL_SECONDS = 60 * 60; // matches the admin-initiated reset
const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60; // window to enter the 2FA code

/**
 * GET /api/auth/status
 * Public — used by the frontend to decide whether to show the login or
 * the bootstrap (first-owner) screen.
 */
app.get("/status", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM users WHERE status = 'active'`
  ).first<{ count: number }>();
  return c.json({ has_users: (row?.count || 0) > 0 });
});

/**
 * POST /api/auth/bootstrap
 * Public — only works when there are zero active users. Creates the
 * first Owner. Anyone calling this endpoint after the first user
 * exists gets a 409.
 */
app.post("/bootstrap", async (c) => {
  const existing = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM users WHERE status = 'active'`
  ).first<{ count: number }>();
  if ((existing?.count || 0) > 0) {
    return c.json({ error: "Bootstrap is closed — an owner already exists" }, 409);
  }

  const body = await c.req.json<{ email: string; name?: string; password: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  const strength = validatePasswordStrength(body.password, body.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);

  const ownerRole = await c.env.DB.prepare(
    `SELECT id FROM roles WHERE name = 'Owner'`
  ).first<{ id: number }>();
  if (!ownerRole) return c.json({ error: "Owner role missing — run schema migrations" }, 500);

  const hash = await hashPassword(body.password);
  const result = await c.env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`
  )
    .bind(body.email.toLowerCase().trim(), body.name?.trim() || null, hash, ownerRole.id)
    .run();

  const userId = result.meta.last_row_id as number;
  const token = await createSession(c.env, userId);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  return c.json({ token, user_id: userId, ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

/**
 * POST /api/auth/login
 * Public — exchanges email + password for a session token.
 */
app.post("/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string; remember?: boolean }>();
  /* "Remember me on this device" (owner 2026-09-02). A ticked box mints a
     ROLLING session that renews on use, so the device never signs itself out;
     an unticked one keeps the fixed 7-day session. The flag is a preference,
     not a permission — it can only choose between two lifetimes this endpoint
     already grants the caller after a correct password. */
  const remember = body.remember === true;
  if (!body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  const email = body.email.toLowerCase().trim();

  // Brute-force speed bump: 10 attempts / 15 min per email+IP. Fail-open.
  const rlKey = `${email}:${clientIp(c)}`;
  const limited = await checkRateLimit(c, "login", rlKey);
  if (limited) return limited;

  const user = await c.env.DB.prepare(
    `SELECT id, password_hash, status, totp_enabled FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: number; password_hash: string; status: string; totp_enabled: number }>();

  /* Two account-existence oracles used to live here, and both are closed below.
     Telling someone WHICH half of the pair was wrong hands anyone holding a list
     of email addresses the first step of a credential attack: they learn which
     addresses are real staff accounts without ever guessing a password.

     ORACLE 1 — TIMING. The unknown-email branch returned before verifyPassword,
     so a real address cost a 100k-iteration PBKDF2 derivation and an unknown one
     cost an indexed SELECT. That difference is measurable over the network. We
     now always derive, against a throwaway hash of the correct shape when there
     is no user, so both answers cost the same work.

     ORACLE 2 — STATUS CODE. The `status !== 'active'` check ran BEFORE the
     password was verified, so ONE request carrying a junk password separated a
     real-but-disabled account (403 "Account is disabled") from an unknown one
     (401). That also enumerated every pending invite — accounts that have no
     password yet and are the most attractive targets. The check now runs AFTER
     verifyPassword, so learning that an account is disabled requires already
     knowing its password, at which point nothing is being disclosed. A
     legitimately disabled staff member who types their real password still gets
     the clear "Account is disabled" answer they need.

     The rate limiter is NOT a mitigation for either: it is keyed email+IP, so an
     attacker walking a list of addresses gets a fresh budget per address. */
  const stored = user?.password_hash || TIMING_EQUALISER_HASH;
  const ok = await verifyPassword(body.password, stored);

  if (!user || !user.password_hash || !ok) {
    /* ONE message for both halves — owner-approved 2026-07-19. Note it also
       stops the frontend telling a user who mistyped their EMAIL that their
       password was wrong, which sent people off resetting a password that was
       never the problem. */
    return c.json({ error: "Email or password is incorrect." }, 401);
  }
  if (user.status !== "active") {
    return c.json({ error: "Account is disabled" }, 403);
  }

  // Clear the counter — the password was correct, so this isn't a brute force.
  await clearRateLimit(c, "login", rlKey);

  // Second factor: when 2FA is on we do NOT mint a session here. Instead we
  // stash a short-lived challenge in KV and ask the client for a code; the real
  // session is issued by /totp/login. Fail CLOSED — if the challenge can't be
  // stored we refuse rather than fall through to a 2FA-less session.
  if (user.totp_enabled) {
    const kv = c.env.SESSION_CACHE;
    if (!kv) {
      console.error("[2fa] SESSION_CACHE unbound — cannot issue challenge");
      return c.json({ error: "Two-factor is temporarily unavailable. Try again shortly." }, 503);
    }
    const challenge = generateToken();
    try {
      // The challenge carries the remember choice through the 2FA step —
      // "<userId>" (legacy, still parsed) or "<userId>:1" when the box was
      // ticked — so a 2FA account gets the same rolling session as everyone else.
      await kv.put(`2fa:${challenge}`, remember ? `${user.id}:1` : String(user.id), {
        expirationTtl: TOTP_CHALLENGE_TTL_SECONDS,
      });
    } catch (e) {
      console.error("[2fa] challenge store failed", e);
      return c.json({ error: "Two-factor is temporarily unavailable. Try again shortly." }, 503);
    }
    return c.json({ totp_required: true, challenge });
  }

  await c.env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(user.id)
    .run();
  const token = remember
    ? await createSession(c.env, user.id, undefined, REMEMBER_TTL_SECONDS, REMEMBER_TTL_SECONDS)
    : await createSession(c.env, user.id);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  return c.json({ token, user_id: user.id, staffId: await lookupStaffId(c.env, user.id), ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

/* staffId: the caller's scm.staff uuid. The 2990 POS signs in by email through
   THIS endpoint post-#949 and keys its whole session on it (apps/pos auth.tsx
   reads body.staffId; without it the POS stored id='' — token minted, app
   unusable, which locked every non-sales member out of the POS). Best-effort by
   design: the ERP web frontend ignores the field, so a missing scm schema (the
   D1 test mirror) or a transient read must never fail the web login. Members
   without a staff row get null — the POS then fails loud instead of half-in.
   Deliberately NOT also echoing a camelCase userId: the POS fallback chain
   (staffId ?? userId ?? id) would seize on the integer and poison every
   staff-keyed store with a non-uuid. */
async function lookupStaffId(env: Env, userId: number): Promise<string | null> {
  try {
    const s = await env.DB.prepare(`SELECT id FROM scm.staff WHERE user_id = ?`)
      .bind(userId)
      .first<{ id: string }>();
    return s?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/totp/login
 * Second step of a 2FA login. Body: { challenge, code }. `code` is a 6-digit
 * TOTP or a backup code. On success the challenge is consumed and a session is
 * issued. Rate-limited per challenge to bound code-guessing.
 */
app.post("/totp/login", async (c) => {
  const body = await c.req.json<{ challenge?: string; code?: string }>();
  const challenge = (body.challenge || "").trim();
  const code = (body.code || "").trim();
  if (!challenge || !code) {
    return c.json({ error: "challenge and code are required" }, 400);
  }

  const kv = c.env.SESSION_CACHE;
  if (!kv) {
    return c.json({ error: "Two-factor is temporarily unavailable. Try again shortly." }, 503);
  }

  // 5 guesses / 5 min per challenge.
  const limited = await checkRateLimit(c, "totp", challenge, 5, 300);
  if (limited) return limited;

  const userIdRaw = await kv.get(`2fa:${challenge}`).catch(() => null);
  if (!userIdRaw) {
    return c.json({ error: "This sign-in attempt expired — start again." }, 401);
  }
  const [userIdPart, rememberPart] = String(userIdRaw).split(":");
  const userId = parseInt(userIdPart, 10);
  const remember = rememberPart === "1";

  const row = await c.env.DB.prepare(
    `SELECT totp_secret, totp_enabled, totp_backup_codes, status FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{
      totp_secret: string | null;
      totp_enabled: number;
      totp_backup_codes: string | null;
      status: string;
    }>();
  if (!row || !row.totp_enabled || !row.totp_secret || row.status !== "active") {
    return c.json({ error: "Two-factor is not available for this account." }, 401);
  }

  let ok = await verifyTotp(row.totp_secret, code);
  if (!ok && row.totp_backup_codes) {
    try {
      const remaining = await consumeBackupCode(code, JSON.parse(row.totp_backup_codes));
      if (remaining !== null) {
        ok = true;
        await c.env.DB.prepare(`UPDATE users SET totp_backup_codes = ? WHERE id = ?`)
          .bind(JSON.stringify(remaining), userId)
          .run();
      }
    } catch {
      /* malformed JSON → treat as no backup codes */
    }
  }
  /* Plain words, not "Invalid code" — and the same sentence for a wrong code
     and an expired 30-second window, because the user can't tell those apart
     and the remedy is identical: read the current code again. Backup codes are
     accepted on this endpoint, so the message names them. */
  if (!ok) {
    return c.json(
      { error: "That code didn't match — try the current code from your authenticator app, or a backup code." },
      401,
    );
  }

  // Consume the challenge (single-use) and clear the guess counter.
  await kv.delete(`2fa:${challenge}`).catch(() => {});
  await clearRateLimit(c, "totp", challenge);

  await c.env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(userId)
    .run();
  const token = remember
    ? await createSession(c.env, userId, undefined, REMEMBER_TTL_SECONDS, REMEMBER_TTL_SECONDS)
    : await createSession(c.env, userId);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  // Same staffId contract as /login — the POS email path may be 2FA-gated.
  return c.json({ token, user_id: userId, staffId: await lookupStaffId(c.env, userId), ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

/**
 * POST /api/auth/forgot-password
 * Public — the self-service half of the reset flow (mig 027 reserved
 * `requested_by = NULL` for exactly this). Anti-enumeration: always
 * answers 200 {ok} whether or not the email maps to an account, and a
 * per-user cooldown (1 request / 5 min) bounds outbound email volume.
 * Sessions are NOT revoked here — only the consume endpoint below does
 * that, once the requester has proven control of the mailbox.
 */
app.post("/forgot-password", async (c) => {
  const body = await c.req
    .json<{ email?: string }>()
    .catch(() => ({} as { email?: string }));
  const email = String(body.email || "").toLowerCase().trim();
  const done = () => c.json({ ok: true });
  if (!email || !email.includes("@")) return done();

  // Per-email rate limit (5 / 15 min). Anti-enumeration: when over the cap we
  // return the same {ok} instead of a 429, so it never reveals which emails
  // exist. Stacks with the 5-min per-user cooldown below.
  if (await checkRateLimit(c, "forgot", email, 5, 900)) return done();

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.status, u.role_id, u.department_id,
            u.position_id, u.manager_id, r.name AS role_name
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.email = ?`
  )
    .bind(email)
    .first<{
      id: number;
      email: string;
      name: string | null;
      status: string;
      role_id: number;
      department_id: number | null;
      position_id: number | null;
      manager_id: number | null;
      role_name: string | null;
    }>();
  if (!user) return done();

  // Never-joined accounts ('invited') have no password to reset — a reset
  // link would dead-end, and the old behavior (silent no-op) left invitees
  // whose original invite expired or got spam-filtered with NO way to get
  // in ("reset password but nothing arrives in Gmail", 2026-07-09). Re-send
  // their invitation instead, behind the same anti-enumeration {ok}.
  if (user.status === "invited") {
    // 5-min cooldown against repeat taps (created_at can be NULL on legacy
    // rows — treated as old).
    const lastInv = await c.env.DB.prepare(
      `SELECT created_at FROM invitations
        WHERE email = ? AND accepted_at IS NULL
        ORDER BY id DESC LIMIT 1`
    )
      .bind(email)
      .first<{ created_at: string | null }>();
    if (lastInv?.created_at) {
      const cutoff = new Date(Date.now() - 5 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      if (String(lastInv.created_at).replace("T", " ") > cutoff) return done();
    }
    const inviteToken = generateToken();
    const inviteExpires = isoIn(60 * 60 * 24 * 14); // 14 days, matches /users/invite
    await c.env.DB.prepare(
      `INSERT INTO invitations
         (email, role_id, token, invited_by, expires_at, department_id, position_id, manager_id)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
    )
      .bind(
        email,
        user.role_id,
        inviteToken,
        inviteExpires,
        user.department_id ?? null,
        user.position_id ?? null,
        user.manager_id ?? null
      )
      .run();
    // PRE-AUTH: no companyContext here — brand by the request hostname, the
    // same default the middleware would resolve (erp.2990shome.com → 2990).
    const inviteCompanyCode = defaultCompanyCodeForHost(c.req.header("host") ?? "");
    const inviteProduct = erpProductName(
      await getBrandingForCompany(c.env, inviteCompanyCode),
    );
    await sendEmail(c.env, {
      to: user.email,
      subject: `You're invited to ${inviteProduct}`,
      html: inviteEmailHtml({
        link: publicUrl(c.env, `/invite/${inviteToken}`, inviteCompanyCode),
        roleName: user.role_name || "a team member",
        inviterName: inviteProduct,
        expiresIn: "14 days",
        productName: inviteProduct,
      }),
      purpose: "member_invite",
      refType: "user",
      refId: user.id,
      companyCode: inviteCompanyCode,
    });
    return done();
  }

  // Any other non-active status (disabled, etc.) stays a silent no-op.
  if (user.status !== "active") return done();

  // Cooldown — skip silently if a reset was issued in the last 5 min.
  const last = await c.env.DB.prepare(
    `SELECT created_at FROM password_resets
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(user.id)
    .first<{ created_at: string | null }>();
  if (last?.created_at) {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    if (String(last.created_at).replace("T", " ") > cutoff) return done();
  }

  await c.env.DB.prepare(
    `UPDATE password_resets SET consumed_at = datetime('now')
      WHERE user_id = ? AND consumed_at IS NULL`
  )
    .bind(user.id)
    .run();

  const token = generateToken();
  const expiresAt = isoIn(RESET_TTL_SECONDS);
  await c.env.DB.prepare(
    `INSERT INTO password_resets (user_id, token, requested_by, expires_at)
     VALUES (?, ?, NULL, ?)`
  )
    .bind(user.id, token, expiresAt)
    .run();

  const name = (user.name || user.email.split("@")[0]).split(" ")[0];
  // PRE-AUTH: brand by request hostname (same default companyContext uses).
  const resetCompanyCode = defaultCompanyCodeForHost(c.req.header("host") ?? "");
  const resetProduct = erpProductName(
    await getBrandingForCompany(c.env, resetCompanyCode),
  );
  await sendEmail(c.env, {
    to: user.email,
    subject: `Reset your ${resetProduct} password`,
    html: resetEmailHtml({
      name,
      link: publicUrl(c.env, `/reset/${token}`, resetCompanyCode),
      expiresIn: "1 hour",
      requestedBy: null,
      productName: resetProduct,
    }),
    purpose: "password_reset",
    refType: "user",
    refId: user.id,
    companyCode: resetCompanyCode,
  });
  return done();
});

/**
 * GET /api/auth/invite/:token
 * Public preflight — lets the accept screen show "You're invited as
 * <role>" and pre-fill the email + any name preset at invite time.
 */
app.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Bad token" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT i.email, i.expires_at, i.accepted_at,
            r.name AS role_name,
            u.name AS name
       FROM invitations i
       JOIN roles r ON r.id = i.role_id
       LEFT JOIN users u ON u.email = i.email
      WHERE i.token = ?`
  )
    .bind(token)
    .first<{
      email: string;
      expires_at: string;
      accepted_at: string | null;
      role_name: string;
      name: string | null;
    }>();
  if (!row) return c.json({ error: "Invalid or expired invitation" }, 404);
  if (row.accepted_at) {
    return c.json({ error: "This invitation has already been used" }, 409);
  }
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "Invitation has expired" }, 410);
  }
  return c.json({ email: row.email, name: row.name, role_name: row.role_name });
});

/**
 * POST /api/auth/accept-invite
 * Public — exchanges an invitation token + name + password for a new
 * active user + session.
 */
app.post("/accept-invite", async (c) => {
  const body = await c.req.json<{
    token: string;
    name?: string;
    password: string;
  }>();
  if (!body.token || !body.password) {
    return c.json({ error: "token and password are required" }, 400);
  }

  const inv = await c.env.DB.prepare(
    `SELECT id, email, role_id, expires_at, accepted_at
     FROM invitations WHERE token = ?`
  )
    .bind(body.token)
    .first<{
      id: number;
      email: string;
      role_id: number;
      expires_at: string;
      accepted_at: string | null;
    }>();
  if (!inv) return c.json({ error: "Invalid or expired invitation" }, 404);
  if (inv.accepted_at) {
    return c.json({ error: "This invitation has already been used" }, 409);
  }
  if (inv.expires_at < new Date().toISOString()) {
    return c.json({ error: "Invitation has expired" }, 410);
  }

  // Strength gate runs after the invite lookup so the email local-part
  // rule can apply ("password can't contain your email name").
  const strength = validatePasswordStrength(body.password, inv.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);

  const hash = await hashPassword(body.password);

  // Promote the placeholder user (created at invite time) to active.
  const userResult = await c.env.DB.prepare(
    `UPDATE users
     SET name = COALESCE(?, name),
         password_hash = ?,
         status = 'active',
         joined_at = datetime('now'),
         role_id = ?
     WHERE email = ? AND status = 'invited'`
  )
    .bind(body.name?.trim() || null, hash, inv.role_id, inv.email)
    .run();

  if (!userResult.meta.changes) {
    return c.json({ error: "No matching invited user — invitation is stale" }, 410);
  }

  const user = await c.env.DB.prepare(
    `SELECT id FROM users WHERE email = ?`
  )
    .bind(inv.email)
    .first<{ id: number }>();
  if (!user) return c.json({ error: "User lookup failed" }, 500);

  await c.env.DB.prepare(
    `UPDATE invitations SET accepted_at = datetime('now') WHERE id = ?`
  )
    .bind(inv.id)
    .run();

  const token = await createSession(c.env, user.id);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  return c.json({ token, user_id: user.id, ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

/**
 * POST /api/auth/logout
 * Authenticated — invalidates the caller's session.
 */
app.post("/logout", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) await deleteSession(c.env, token);
  return c.json({ ok: true });
});

/**
 * GET /api/auth/me
 * Authenticated — returns the current user + permissions.
 */
app.get("/me", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  // Legacy shared key — service identity, no DB lookup.
  if (c.env.DASHBOARD_API_KEY && timingSafeEqualStr(token, c.env.DASHBOARD_API_KEY)) {
    return c.json({
      user: {
        id: 0,
        email: "service@local",
        name: "Service",
        role_id: 0,
        role_name: "Service",
        status: "active",
        permissions: ["*"],
        // The service identity is a wildcard holder, so it resolves through the
        // SAME registry rather than being handed a hand-written answer — a
        // second, hand-maintained capability map for one caller is the drift
        // this file exists to stop. The cost/margin DISPLAY switch is applied to
        // this caller too — it is GLOBAL, so even the wildcard service loses
        // scm.finance.view when costing display is turned off.
        capabilities: resolveCapabilities(
          { permissions: ["*"] },
          { costingDisplayEnabled: isCostingDisplayEnabled(c.env) },
        ),
      },
    });
  }

  const user = await getUserBySession(c.env, token);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Opportunistic prune — keeps the sessions table small. It is a WRITE, and
  // /auth/me sits at the head of every page load's critical path: awaiting it
  // charged one DELETE round trip to every navigation in the app before the
  // caller saw a byte. Nothing in the response depends on it, so it moves off
  // the critical path via waitUntil and settles after the response is sent.
  // A failed prune must not fail an otherwise valid /me either — it is a
  // housekeeping sweep, and the next request retries it.
  //
  // c.executionCtx throws when the runtime did not supply one (some test
  // harnesses); a floating promise is the correct fallback for fire-and-forget
  // work, same pattern as the error reporter in index.ts.
  const prune = pruneExpiredSessions(c.env).catch(() => {});
  try {
    c.executionCtx.waitUntil(prune);
  } catch {
    void prune;
  }

  // project_finance_viewer: single source of truth (pmsAccess) surfaced to the
  // FE so the Projects "Finances" nav item + view (not tied to one project)
  // hide for every non-director sales user. Detail-level sections use the
  // per-project _access.pms flags instead.
  //
  // product_cost_viewer: a SEPARATE question — "may you see a SKU's cost price"
  // (owner 2026-07-17: 采购 + Finance + Sales Director). It rode
  // project_finance_viewer until now, which is why Purchasing silently had no
  // cost for a month: that flag answers "are you a PMS director". Computed here,
  // beside its sibling, so the FE never re-derives either from a position-name
  // regex and the two surfaces cannot drift.
  // capabilities: the RESOLVED ANSWER SET — owner's ruling 2026-07-19, "我们的
  // 权限全部要用 backend 来做…frontend 那边就不会那么忙". Computed ONCE here, per
  // request, and consumed by desktop and mobile verbatim: the client renders a
  // control or does not, and never re-derives WHY. The two flags above are the
  // same idea grown one at a time; services/capabilities.ts is where the next
  // one goes instead of a third sibling field. They stay for compatibility with
  // a cached SPA shell that predates this response.
  //
  // A THROW HERE IS A 500, DELIBERATELY. If the capability set cannot be
  // resolved, the answer is "no" — and an unresolvable permission is an error to
  // SURFACE, not a blank to fill. There is no try/catch and no `?? {}` fallback
  // in this path: an empty object on the wire would read to the client as "no
  // rules configured", which is exactly the fail-open shape this replaces.
  return c.json({
    user: {
      ...user,
      project_finance_viewer: isFinanceViewer(user),
      product_cost_viewer: isProductCostViewer(user),
      // scm_config_writer: "may you WRITE SCM master data / config" — the SAME
      // predicate the API gate uses (scm/lib/houzs-perms.canWriteScmConfig
      // delegates to it), surfaced so a screen never re-derives it. SO
      // Maintenance asked `can('scm.config.write')`, the FLAT half only, and so
      // told every position-granted config writer the page was read-only while
      // the API would have accepted their edits. Third flag on this response for
      // the third time the FE and BE drifted by exactly one rule.
      scm_config_writer: userCanWriteScmConfig(user),
      // costingDisplayEnabled: the GLOBAL cost/margin DISPLAY switch (env
      // COSTING_DISPLAY_ENABLED). Passed here so scm.finance.view is dropped for
      // EVERYONE when display is off — the FE reads that capability and hides the
      // cost/margin columns, matching canViewScmFinance stripping the fields from
      // every SCM sales-document response. One switch, both sides of the wire.
      capabilities: resolveCapabilities(user, {
        costingDisplayEnabled: isCostingDisplayEnabled(c.env),
      }),
    },
  });
});

/**
 * GET /api/auth/reset/:token
 * Public — verifies a reset token and returns the email it's for so
 * the reset page can show "Reset password for alice@…".
 */
app.get("/reset/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Bad token" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT pr.id, pr.user_id, pr.expires_at, pr.consumed_at,
            u.email, u.name
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token = ?`
  )
    .bind(token)
    .first<{
      id: number;
      user_id: number;
      expires_at: string;
      consumed_at: string | null;
      email: string;
      name: string | null;
    }>();
  if (!row) return c.json({ error: "Invalid or expired link" }, 404);
  if (row.consumed_at) return c.json({ error: "This link has already been used" }, 410);
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "This link has expired" }, 410);
  }
  return c.json({ email: row.email, name: row.name });
});

/**
 * POST /api/auth/reset/:token
 * Public — consumes the token, sets a new password hash, invalidates
 * prior sessions. Does NOT auto-log-in; the user goes back to the
 * login page so they verify the new password works.
 */
app.post("/reset/:token", async (c) => {
  const token = c.req.param("token");
  const body = await c.req.json<{ password: string }>();
  if (!token) return c.json({ error: "Bad token" }, 400);
  if (!body.password) {
    return c.json({ error: "password is required" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT pr.id, pr.user_id, pr.expires_at, pr.consumed_at, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token = ?`
  )
    .bind(token)
    .first<{
      id: number;
      user_id: number;
      expires_at: string;
      consumed_at: string | null;
      email: string;
    }>();
  if (!row) return c.json({ error: "Invalid or expired link" }, 404);
  if (row.consumed_at) return c.json({ error: "This link has already been used" }, 410);
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "This link has expired" }, 410);
  }
  const strength = validatePasswordStrength(body.password, row.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);
  const hash = await hashPassword(body.password);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ? WHERE id = ?`
  )
    .bind(hash, row.user_id)
    .run();
  await c.env.DB.prepare(
    `UPDATE password_resets SET consumed_at = datetime('now') WHERE id = ?`
  )
    .bind(row.id)
    .run();
  // Belt + braces: kill any remaining sessions. Bust their cached-user entries
  // BEFORE the delete (reads the live tokens) so a reset password can't ride a
  // still-cached session for up to 60s.
  await bustUserSessions(c.env, row.user_id);
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.user_id).run();
  return c.json({ ok: true });
});

// /api/auth/* lives outside the global auth middleware so login etc
// are reachable pre-auth. /me endpoints need to pull the token manually
// — same pattern as the existing GET /me below.
async function requireAuthed(c: any) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { error: "Unauthorized" as const, token: "" };
  const user = await getUserBySession(c.env, token);
  if (!user) return { error: "Unauthorized" as const, token: "" };
  return { user, token };
}

/**
 * PATCH /api/auth/me
 * Authenticated — lets the signed-in user edit their own display name.
 * Email + role are NOT editable here (privileged operations).
 */
app.patch("/me", async (c) => {
  const auth = await requireAuthed(c);
  if ("error" in auth) return c.json({ error: auth.error }, 401);
  const body = await c.req.json<{ name?: string }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if (body.name != null) {
    sets.push("name = ?");
    binds.push(body.name.trim() || null);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  binds.push(auth.user.id);
  await c.env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

/**
 * POST /api/auth/me/password
 * Authenticated — user changes their own password. Requires current
 * password to prove possession of the account (defends against a
 * stolen session token being used to lock the owner out).
 */
app.post("/me/password", async (c) => {
  const auth = await requireAuthed(c);
  if ("error" in auth) return c.json({ error: auth.error }, 401);
  const body = await c.req.json<{ current: string; next: string }>();
  if (!body.current || !body.next) {
    return c.json({ error: "current and next are required" }, 400);
  }
  const strength = validatePasswordStrength(body.next, auth.user.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);
  const row = await c.env.DB.prepare(
    `SELECT password_hash FROM users WHERE id = ?`
  )
    .bind(auth.user.id)
    .first<{ password_hash: string }>();
  if (!row?.password_hash) return c.json({ error: "No password on file" }, 400);
  const ok = await verifyPassword(body.current, row.password_hash);
  if (!ok) return c.json({ error: "Current password is incorrect" }, 403);
  const next = await hashPassword(body.next);
  await c.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
    .bind(next, auth.user.id)
    .run();
  // Keep the current session alive — caller just proved they know the
  // old password. Revoke OTHER sessions on the account as a defensive
  // measure (if the old password was compromised elsewhere). Bust their
  // cached-user entries first (keeping this session's), so the revoked
  // sessions can't ride the 60s cache.
  await bustUserSessions(c.env, auth.user.id, auth.token);
  await c.env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND token != ?`
  )
    .bind(auth.user.id, auth.token)
    .run();
  return c.json({ ok: true });
});

export default app;
