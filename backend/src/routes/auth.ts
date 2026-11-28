import { Hono, type Context } from "hono";
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
  SESSION_ORIGIN_FIELD,
  SESSION_ORIGIN_PASSWORD_CHANGE,
  PASSWORD_CHANGE_SESSION_TTL_SECONDS,
} from "../services/auth";
import { fieldPinLogin } from "./fieldPinLogin";
import { bustUserSessions } from "../services/sessionCache";
import { isFinanceViewer, isProductCostViewer } from "../services/pmsAccess";
import { userCanWriteScmConfig } from "../services/positionPolicy";
import { resolveCapabilities } from "../services/capabilities";
import { isCostingDisplayEnabled } from "../scm/lib/costing-enabled";
import { sendEmail, publicUrl, resetEmailHtml, inviteEmailHtml, erpProductName } from "../services/email";
import { getBrandingForCompany } from "../services/branding";
import { defaultCompanyCodeForHost } from "../middleware/companyContext";
import { validatePasswordStrength } from "../services/passwordStrength";
import { consumeBackupCode } from "../services/totp";
import { acceptTotpCode } from "../services/totpCheck";
import { checkRateLimit, clearRateLimit, clientIp } from "../middleware/rateLimit";
import { recordFailedLogin, recordRateLimitedOnce } from "../services/failedLogins";
import { provisionPersonalMailbox } from "../lib/mail-provision";

const app = new Hono<{ Bindings: Env }>();

const TIMING_EQUALISER_HASH =
  "BF3yX+3ocRPnH9KBKydn5A==$5iHFIc7Z3t8/vEm8jA4GuwdjcaL5/yajl4dWitx/PBU=";

const RESET_TTL_SECONDS = 60 * 60;

async function passwordChangeLoginResponse(c: Context<{ Bindings: Env }>, userId: number) {
  const token = await createSession(
    c.env,
    userId,
    SESSION_ORIGIN_PASSWORD_CHANGE,
    PASSWORD_CHANGE_SESSION_TTL_SECONDS,
    null,
  );
  return c.json({ token, user_id: userId, password_change_required: true });
}
const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60;

app.get("/status", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM users WHERE status = 'active'`
  ).first<{ count: number }>();
  return c.json({ has_users: (row?.count || 0) > 0 });
});

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

  const rlKey = `${email}:${clientIp(c)}`;
  const limited = await checkRateLimit(c, "login", rlKey);
  if (limited) {
    recordRateLimitedOnce(c, email, "rate_limited", rlKey, 900);
    return limited;
  }

  const user = await c.env.DB.prepare(
    `SELECT id, password_hash, status, totp_enabled, password_change_required_at FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{
      id: number;
      password_hash: string;
      status: string;
      totp_enabled: number;
      password_change_required_at: string | null;
    }>();

  const stored = user?.password_hash || TIMING_EQUALISER_HASH;
  const ok = await verifyPassword(body.password, stored);

  if (!user || !user.password_hash || !ok) {
    /* ONE message for both halves — owner-approved 2026-07-19. Note it also
       stops the frontend telling a user who mistyped their EMAIL that their
       password was wrong, which sent people off resetting a password that was
       never the problem. */
    recordFailedLogin(
      c,
      email,
      user?.id ?? null,
      !user ? "unknown_email" : !user.password_hash ? "no_password" : "wrong_password",
    );
    return c.json({ error: "Email or password is incorrect." }, 401);
  }
  if (user.status !== "active") {
    recordFailedLogin(c, email, user.id, "disabled");
    return c.json({ error: "Account is disabled" }, 403);
  }

  await clearRateLimit(c, "login", rlKey);

  if (user.totp_enabled) {
    const kv = c.env.SESSION_CACHE;
    if (!kv) {
      console.error("[2fa] SESSION_CACHE unbound — cannot issue challenge");
      return c.json({ error: "Two-factor is temporarily unavailable. Try again shortly." }, 503);
    }
    const challenge = generateToken();
    try {
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
  if (user.password_change_required_at) return passwordChangeLoginResponse(c, user.id);
  const token = remember
    ? await createSession(c.env, user.id, undefined, REMEMBER_TTL_SECONDS, REMEMBER_TTL_SECONDS)
    : await createSession(c.env, user.id);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  return c.json({ token, user_id: user.id, staffId: await lookupStaffId(c.env, user.id), ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

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

app.post("/pin-login", fieldPinLogin);

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

  const limited = await checkRateLimit(c, "totp", challenge, 5, 300);
  if (limited) {
    recordRateLimitedOnce(c, null, "totp_rate_limited", challenge, 300);
    return limited;
  }

  const userIdRaw = await kv.get(`2fa:${challenge}`).catch(() => null);
  if (!userIdRaw) {
    recordFailedLogin(c, null, null, "totp_expired");
    return c.json({ error: "This sign-in attempt expired — start again." }, 401);
  }
  const [userIdPart, rememberPart, doorPart] = String(userIdRaw).split(":");
  const userId = parseInt(userIdPart, 10);
  const remember = rememberPart === "1";
  const fieldDoor = doorPart === "field";

  const row = await c.env.DB.prepare(
    `SELECT totp_secret, totp_enabled, totp_backup_codes, totp_last_step, status, password_change_required_at FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{
      password_change_required_at: string | null;
      totp_secret: string | null;
      totp_last_step: number | string | null;
      totp_enabled: number;
      totp_backup_codes: string | null;
      status: string;
    }>();
  if (!row || !row.totp_enabled || !row.totp_secret || row.status !== "active") {
    recordFailedLogin(c, null, Number.isFinite(userId) ? userId : null, "totp_unavailable");
    return c.json({ error: "Two-factor is not available for this account." }, 401);
  }

  let ok = await acceptTotpCode(c.env, userId, row, code);
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
    }
  }
  if (!ok) {
    recordFailedLogin(c, null, userId, "totp_failed");
    return c.json(
      { error: "That code didn't match — try the current code from your authenticator app, or a backup code." },
      401,
    );
  }

  await kv.delete(`2fa:${challenge}`).catch(() => {});
  await clearRateLimit(c, "totp", challenge);

  await c.env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(userId)
    .run();
  if (!fieldDoor && row.password_change_required_at) return passwordChangeLoginResponse(c, userId);
  const token = fieldDoor
    ? await createSession(c.env, userId, SESSION_ORIGIN_FIELD)
    : remember
      ? await createSession(c.env, userId, undefined, REMEMBER_TTL_SECONDS, REMEMBER_TTL_SECONDS)
      : await createSession(c.env, userId);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  return c.json({ token, user_id: userId, staffId: await lookupStaffId(c.env, userId), ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

app.post("/forgot-password", async (c) => {
  const body = await c.req
    .json<{ email?: string }>()
    .catch(() => ({} as { email?: string }));
  const email = String(body.email || "").toLowerCase().trim();
  const done = () => c.json({ ok: true });
  if (!email || !email.includes("@")) return done();

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

  if (user.status === "invited") {
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
    const inviteExpires = isoIn(60 * 60 * 24 * 14);
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

  if (user.status !== "active") return done();

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

  const strength = validatePasswordStrength(body.password, inv.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);

  const hash = await hashPassword(body.password);

  const userResult = await c.env.DB.prepare(
    `UPDATE users
     SET name = COALESCE(?, name),
         password_hash = ?,
         status = 'active',
         joined_at = datetime('now'),
         role_id = COALESCE(role_id, ?)
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

  try {
    await provisionPersonalMailbox(c.env, user.id);
  } catch (e) {
    console.error("[auth] accept-invite mailbox provisioning failed:", e);
  }

  const token = await createSession(c.env, user.id);
  const sessionPass = await mintSessionPass(c.env, token, Date.now());
  return c.json({ token, user_id: user.id, ...(sessionPass ? { session_pass: sessionPass } : {}) });
});

app.post("/logout", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) await deleteSession(c.env, token);
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "Unauthorized" }, 401);

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
        capabilities: resolveCapabilities(
          { permissions: ["*"] },
          { costingDisplayEnabled: isCostingDisplayEnabled(c.env) },
        ),
      },
    });
  }

  const user = await getUserBySession(c.env, token);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

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
      password_change_required: user.session_origin === SESSION_ORIGIN_PASSWORD_CHANGE,
      project_finance_viewer: isFinanceViewer(user),
      product_cost_viewer: isProductCostViewer(user),
      scm_config_writer: userCanWriteScmConfig(user),
      capabilities: resolveCapabilities(user, {
        costingDisplayEnabled: isCostingDisplayEnabled(c.env),
      }),
    },
  });
});

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
    `UPDATE users SET password_hash = ?, password_change_required_at = NULL WHERE id = ?`
  )
    .bind(hash, row.user_id)
    .run();
  await c.env.DB.prepare(
    `UPDATE password_resets SET consumed_at = datetime('now') WHERE id = ?`
  )
    .bind(row.id)
    .run();
  await bustUserSessions(c.env, row.user_id);
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.user_id).run();
  return c.json({ ok: true });
});

async function requireAuthed(c: any) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { error: "Unauthorized" as const, token: "" };
  const user = await getUserBySession(c.env, token);
  if (!user) return { error: "Unauthorized" as const, token: "" };
  return { user, token };
}

app.patch("/me", async (c) => {
  const auth = await requireAuthed(c);
  if ("error" in auth) return c.json({ error: auth.error }, 401);
  if (auth.user.session_origin === SESSION_ORIGIN_PASSWORD_CHANGE) {
    return c.json({ error: "Please choose a new password before continuing.", code: "password_change_required" }, 403);
  }
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

app.post("/me/password", async (c) => {
  const auth = await requireAuthed(c);
  if ("error" in auth) return c.json({ error: auth.error }, 401);
  const body = await c.req.json<{ current: string; next: string; remember?: boolean }>();
  if (!body.current || !body.next) {
    return c.json({ error: "current and next are required" }, 400);
  }
  const strength = validatePasswordStrength(body.next, auth.user.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);
  const row = await c.env.DB.prepare(
    `SELECT password_hash, password_change_required_at FROM users WHERE id = ?`
  )
    .bind(auth.user.id)
    .first<{ password_hash: string; password_change_required_at: string | null }>();
  if (!row?.password_hash) return c.json({ error: "No password on file" }, 400);
  const ok = await verifyPassword(body.current, row.password_hash);
  if (!ok) return c.json({ error: "Current password is incorrect" }, 403);
  if (row.password_change_required_at && body.next === body.current) {
    return c.json({ error: "Choose a password different from your current one." }, 400);
  }
  const next = await hashPassword(body.next);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_change_required_at = NULL WHERE id = ?`
  )
    .bind(next, auth.user.id)
    .run();
  if (auth.user.session_origin === SESSION_ORIGIN_PASSWORD_CHANGE) {
    await bustUserSessions(c.env, auth.user.id);
    await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`)
      .bind(auth.user.id)
      .run();
    const remember = body.remember === true;
    const token = remember
      ? await createSession(c.env, auth.user.id, undefined, REMEMBER_TTL_SECONDS, REMEMBER_TTL_SECONDS)
      : await createSession(c.env, auth.user.id);
    const sessionPass = await mintSessionPass(c.env, token, Date.now());
    return c.json({ ok: true, token, ...(sessionPass ? { session_pass: sessionPass } : {}) });
  }
  await bustUserSessions(c.env, auth.user.id, auth.token);
  await c.env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND token != ?`
  )
    .bind(auth.user.id, auth.token)
    .run();
  return c.json({ ok: true });
});

export default app;
