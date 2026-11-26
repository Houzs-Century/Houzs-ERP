import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { getUserBySession, timingSafeEqualStr, type AuthUser, mintSessionPassFor } from "../services/auth";
import { tryPassAuth } from "../services/session-pass";
import { hasPermission } from "../services/permissions";
import { MCP_TOKEN_PREFIX } from "../services/mcp-store";
import { MCP_ACTION_HEADER, MCP_INNER_HEADER, admitMcpWrite, isMcpInner, recallVerified } from "../services/mcp-inner";
import { mcpIdentity, type McpIdentity } from "../routes/mcp";
import { hasScmUmbrella } from "../services/scmUmbrella";
import { canViewItPages } from "../services/itAccess";
import { isSalesDirectorUser, isSalesUser, isDirectorUser } from "../services/pmsAccess";
import { FIELD_SESSION_REFUSAL, fieldSessionAllowsPath, isFieldPinEligible } from "../services/fieldPin";
import {
  fullAccessMap,
  meetsLevel,
  type AccessLevel,
} from "../services/pageAccess";

const SERVICE_USER: AuthUser = {
  id: 0,
  email: "service@local",
  name: "Service",
  role_id: 0,
  role_name: "Service",
  position_id: null,
  position_name: null,
  status: "active",
  permissions: ["*"],
  permissions_set: new Set(["*"]),
  manager_id: null,
  scope_to_pic: false,
  department_id: null,
  department_name: null,
  brand_scope: null,
  page_access: fullAccessMap(),
  scm_l2_configured: false,
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    userId: number | null;
    access_level: AccessLevel;
    /** WHICH AUTH PATH THIS REQUEST TOOK — 'pass' skipped the two joined
     *  authorization reads, 'session-db' paid them. Set here and read ONLY by
     *  the read-only probe in routes/systemHealth.ts, so "is the fast path
     *  actually firing" is an observation rather than a reading of this file
     *  (docs/bugs/0593 is what a reading got wrong). */
    authPath: 'pass' | 'session-db';
    requestId: string;
    sessionOrigin?: string;
  }
}

/**
 * Auth middleware. Accepts either:
 *   - Bearer <session-token>  → validated against the sessions table
 *   - Bearer <DASHBOARD_API_KEY> → legacy shared key, treated as service user
 *
 * On success the user (with their permissions) is attached to the
 * Hono context as `c.get("user")`. Routes can then call
 * `requirePermission(perm)` for granular gating.
 */
/**
 * Public API sub-paths that live under /api/* but must NOT require
 * staff auth. Customer-facing endpoints (survey, track lookup, portal
 * case view) all sit here so Cloudflare Pages' single /api/* rewrite
 * forwards them without route collisions against SPA paths.
 *
 * THIS LIST IS NOT WHAT MAKES THOSE ROUTES PUBLIC. index.ts mounts them
 * ABOVE `app.use("/api/*", auth)`, and Hono stops the chain at the first
 * handler that returns — so a matched public route never reaches this
 * middleware and never consults this list. What the list actually does
 * is catch requests that fall THROUGH those routers to the gate (an
 * unmatched method or sub-path under a public prefix), which 401 instead
 * of 404 without it.
 *
 * ENTRIES HERE ARE LOAD-BEARING IN THE OTHER DIRECTION, and that is the
 * danger. Anything mounted BELOW the gate whose path matches an entry is
 * silently served UNAUTHENTICATED, because the gate calls next() before
 * the route is reached. Two dead entries — "/api/supplier-auth" and
 * "/api/supplier" — matched no mounted router and were removed on
 * 2026-07-17: they were a loaded gun aimed at whoever mounted a future
 * /api/supplier/* route in the ordinary place, below the gate. An entry
 * that names no router is therefore a BUG, and portalSurfaces.test.ts
 * fails the build on one.
 *
 * WHY THIS DELIBERATELY DOES NOT MIRROR index.ts's pre-auth mounts:
 * /api/pos, /api/mail-center/inbound, /api/sync/*-mirror and
 * /api/assr-form-intake are also mounted pre-auth, and are absent here on
 * purpose. They are machine-to-machine surfaces that carry their OWN
 * guard (a shared secret, or re-applied `auth` inside the router, as
 * /api/pos does for set-pin/verify-pin/sales-stats). Adding them would
 * buy nothing — mount order already makes them reachable — while arming
 * the exact foot-gun described above for every future sibling path under
 * those prefixes. The two lists SHOULD diverge; only this one grants.
 */
export const PUBLIC_API_PREFIXES = [
  "/api/survey",
  "/api/track",
  "/api/portal",
  "/api/auth",
];

/**
 * A crew PIN session (origin 'field', services/fieldPin.ts) is held to the field
 * screens HERE, on the server, for every request on both auth paths — the menus
 * hiding office modules is presentation, this is the boundary. Two refusals:
 * the member's Title stopped being a crew Title since the PIN was issued (401 —
 * the session is no longer one we would mint), or the path is outside the field
 * list (403). Every other session returns null and is untouched.
 */
export function fieldSessionRefusal(
  user: Pick<AuthUser, "session_origin" | "position_policy">,
  path: string,
): { status: 401 | 403; body: { error: string; code: string } } | null {
  if (user.session_origin !== "field") return null;
  if (!isFieldPinEligible(user.position_policy)) {
    return {
      status: 401,
      body: { error: "This account can no longer sign in with a crew PIN. Ask the office.", code: "field_pin_not_eligible" },
    };
  }
  if (!fieldSessionAllowsPath(path)) {
    return { status: 403, body: { error: FIELD_SESSION_REFUSAL, code: "field_session_scope" } };
  }
  return null;
}

export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  "Please choose a new password before continuing.";

/**
 * A session minted for a member who must change their password (origin
 * 'password_change', services/auth.ts) reaches nothing behind this gate. The
 * change-password, /me and logout endpoints live under /api/auth, which is a
 * PUBLIC prefix above and so never arrives here. Every other session returns
 * null and is untouched — including crew PIN and POS PIN sessions, which never
 * carry this origin.
 */
export function passwordChangeSessionRefusal(
  user: Pick<AuthUser, "session_origin">,
): { status: 403; body: { error: string; code: string } } | null {
  if (user.session_origin !== "password_change") return null;
  return {
    status: 403,
    body: { error: PASSWORD_CHANGE_REQUIRED_MESSAGE, code: "password_change_required" },
  };
}

export const auth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_API_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    await next();
    return;
  }

  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  }

  if (token.startsWith(MCP_TOKEN_PREFIX)) {
    if (!isMcpInner(c.req.header(MCP_INNER_HEADER))) {
      return c.json({ error: "AI Connector tokens only work through the connector." }, 403);
    }
    const isRead = c.req.method === "GET" || c.req.method === "HEAD";
    const actionId = c.req.header(MCP_ACTION_HEADER);
    if (!isRead && !actionId) {
      return c.json({ error: "The AI Connector is read-only." }, 403);
    }
    const id = recallVerified<McpIdentity>(token, Date.now()) ?? (await mcpIdentity(c.env, token));
    if (!id) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    if (!isRead && !admitMcpWrite({ method: c.req.method, path, actionId, tokenId: id.tokenId, now: Date.now() })) {
      return c.json({ error: "The AI Connector is read-only." }, 403);
    }
    c.set("authPath", "session-db");
    c.set("user", id.user);
    c.set("userId", id.user.id);
    c.set("sessionOrigin", "mcp");
    await next();
    return;
  }

  if (
    (c.env.DASHBOARD_API_KEY && timingSafeEqualStr(token, c.env.DASHBOARD_API_KEY)) ||
    (c.env.CONNECT_SERVICE_TOKEN && timingSafeEqualStr(token, c.env.CONNECT_SERVICE_TOKEN))
  ) {
    c.set("user", SERVICE_USER);
    c.set("userId", (SERVICE_USER as any).id ?? null);
    await next();
    return;
  }

  const passUser = await tryPassAuth(c.env, c.req.header("X-Session-Pass") || "", token, Date.now());
  if (passUser) {
    const refused = fieldSessionRefusal(passUser, path) ?? passwordChangeSessionRefusal(passUser);
    if (refused) return c.json(refused.body, refused.status);
    c.set("authPath", "pass");
    c.set("user", passUser);
    c.set("userId", passUser.id);
    c.set("sessionOrigin", passUser.session_origin ?? undefined);
    await next();
    return;
  }

  const user = await getUserBySession(c.env, token);
  if (!user) {
    return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  }
  const refused = fieldSessionRefusal(user, path) ?? passwordChangeSessionRefusal(user);
  if (refused) return c.json(refused.body, refused.status);
  /* RE-ISSUE THE PASS HERE, because reaching this line means the caller has no
     usable one — and until now the only way to get one was to LOG IN AGAIN.
     A pass lives 8 hours (SESSION_PASS_TTL_MS); a session lives 7 days
     (SESSION_TTL_SECONDS). Nothing minted a pass anywhere except the four login
     endpoints, so from hour 9 to day 7 — about 95% of a session's life — every
     request fell back to the two joined authorization reads above, exactly as if
     the feature had never shipped. `docs/bugs/0593-*`.

     Safe by the board's own design, which anticipated this: revocation compares
     a pass's `iat` against the revoke timestamp, so "a pass minted AFTER the
     event (a fresh login, OR A RE-ISSUE) has a newer iat and is honoured"
     (services/session-revocation.ts header). A logout destroys the session row,
     so getUserBySession fails and nothing is minted; a role change re-reads the
     envelope HERE and the new pass carries the new one.

     Costs one authoritative read per 8 hours per session instead of one per
     request, and stays a no-op while SESSION_SIGNING_KEY is unset —
     mintSessionPassFor returns null without it. Signed from the `user` just
     read above: re-reading it here cost a second session read (HC-0002). */
  const reissued = await mintSessionPassFor(c.env, user, token, Date.now());
  if (reissued) c.header("X-Session-Pass", reissued);

  c.set("authPath", "session-db");
  c.set("user", user);
  c.set("userId", user.id);
  c.set("sessionOrigin", user.session_origin ?? undefined);
  await next();
};

/**
 * Per-route permission gate. Pass a single permission key.
 *
 * Usage:
 *   app.post("/", requirePermission("users.manage"), async (c) => {...})
 */
export function requirePermission(perm: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (!hasPermission(granted, perm)) {
      return c.json({ error: "You don't have permission to do that." }, 403);
    }
    await next();
  };
}

/** Gate for the IT pages (System Health, AI usage). See services/itAccess.ts. */
export function requireItPages(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- typed as set, but unset if a route forgets authMiddleware
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
    if (!canViewItPages(user.permissions_set ?? user.permissions)) {
      return c.json({ error: "You don't have permission to do that." }, 403);
    }
    await next();
  };
}

/**
 * ADDITIVE gate: admit the caller if they hold `perm` OR they are a
 * "Sales Director" (STABLE ORG FIELD position_name, see
 * services/pmsAccess.isSalesDirectorUser). Used on the Team endpoints
 * (members list, invite, departments list) so a Sales Director gains a
 * DEPARTMENT-SCOPED admittance WITHOUT holding the full users.manage /
 * users.read permission.
 *
 * This middleware only OPENS the door — it never widens scope. The handler
 * MUST still call `salesDirectorScope(...)` (routes/users.ts) to restrict a
 * caller admitted purely as a Sales Director to their own department. A caller
 * who already holds `perm` keeps their existing full-admin behaviour unchanged.
 */
export function requirePermissionOrSalesDirector(
  perm: string,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (hasPermission(granted, perm) || isSalesDirectorUser(user)) {
      await next();
      return;
    }
    return c.json({ error: "You don't have permission to do that." }, 403);
  };
}

/**
 * ADDITIVE gate: admit the caller if they hold `perm` OR they are Sales staff /
 * a director by STABLE ORG FIELD (services/pmsAccess.isSalesUser /
 * isDirectorUser). READ-ONLY use only — put this on GET reference endpoints the
 * PMS project page needs (fleet crew list, etc.) that a Sales Director's
 * position was never granted in the permission matrix (positions get no
 * backfill). It only OPENS the door; it never widens scope and never applies to
 * writes. A caller who already holds `perm` keeps their existing behaviour.
 */
export function requirePermissionOrSalesView(
  perm: string,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (hasPermission(granted, perm) || isDirectorUser(user) || isSalesUser(user)) {
      await next();
      return;
    }
    return c.json({ error: "You don't have permission to do that." }, 403);
  };
}

/**
 * ADDITIVE page-access gate for the PMS project page's Sales section. Passes if
 * `requirePageAccess(pageKey)` WOULD pass (wildcard or a page-access matrix
 * level ≥ minLevel) OR the caller is Sales/director by STABLE ORG FIELD
 * (isSalesUser / isDirectorUser). Fixes the root-cause split where the project
 * page authorises via the org-POSITION tier (pmsAccess) but the inner data
 * calls authorise via the flat matrix a Sales Director's position was never
 * granted → sections render then 403. Purely additive: the matrix path is
 * checked first and unchanged, so no non-sales user is weakened.
 *
 * `access_level` is set for downstream branching, matching requirePageAccess:
 *   - wildcard / matrix grant → the real matrix level (unchanged)
 *   - admitted as director     → "full"    (sees every entry — canManage)
 *   - admitted as sales staff  → "partial" (own+downline via existing scoping)
 */
export function requirePageAccessOrSalesView(
  pageKey: string,
  minLevel: AccessLevel = "partial",
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (hasPermission(granted, "*")) {
      c.set("access_level", "full");
      await next();
      return;
    }
    const level: AccessLevel = (user.page_access?.[pageKey] ?? "none") as AccessLevel;
    if (meetsLevel(level, minLevel)) {
      c.set("access_level", level);
      await next();
      return;
    }
    if (isDirectorUser(user)) {
      c.set("access_level", "full");
      await next();
      return;
    }
    if (isSalesUser(user)) {
      c.set("access_level", "partial");
      await next();
      return;
    }
    return c.json(
      { error: "You don't have permission to view this page." },
      403,
    );
  };
}

/**
 * Per-route gate that accepts ANY of the listed permissions. Used where
 * a narrow permission (e.g. projects.chat) and a broader one
 * (projects.write) should both unlock the same endpoint, so admins can
 * pick the least-privilege fit per role.
 *
 * Usage:
 *   app.post("/:id/notes",
 *     requireAnyPermission(["projects.write", "projects.chat"]),
 *     handler);
 */
export function requireAnyPermission(perms: string[]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (!perms.some((p) => hasPermission(granted, p))) {
      return c.json(
        { error: "You don't have permission to do that." },
        403
      );
    }
    await next();
  };
}

const HR_ATTENDANCE_READ_PATHS = ["/api/hr/attendance", "/api/hr/working-hours"];
export const requireHrRead: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = c.get("user");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auth sets user; keep the 401 for a bare context (tests/scripts)
  if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  const granted = user.permissions_set ?? user.permissions;
  if (hasPermission(granted, "hr.employees.read") || hasPermission(granted, "hr.employees.manage")) return next();
  const path = c.req.path;
  const timeRead =
    c.req.method === "GET" &&
    hasPermission(granted, "hr.attendance.read") &&
    HR_ATTENDANCE_READ_PATHS.some((base) => path === base || path.startsWith(`${base}/`));
  if (timeRead) return next();
  return c.json({ error: "You don't have permission to do that." }, 403);
};

/**
 * SCM umbrella gate for `/api/scm/*`. ADDITIVE on top of the legacy
 * permission check — preserves the EXACT existing pass conditions so no
 * current SCM user loses access:
 *   - `*` wildcard           → pass (Owner / IT Admin)   [unchanged]
 *   - `scm.access` permission → pass                      [unchanged]
 *   - ANY `scm*` page-access key at level !== 'none' → pass  [NEW]
 *
 * The new branch only ADDS access for positions explicitly granted an
 * SCM area in the page-access matrix; it can never deny a caller who
 * already passes the first two conditions. Coarse by design — per-area
 * route checks are a later, riskier slice.
 */
export const requireScmAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const granted = user.permissions_set ?? user.permissions;
  if (hasScmUmbrella(user)) {
    await next();
    return;
  }
  if (c.req.path.includes("/mfg-sales-orders") && isSalesUser(user)) {
    await next();
    return;
  }
  // Additive (owner 2026-09-30, 申请付款): a holder of the flat key
  // scm.payment_request.create — a sales PIC asking Finance to pay an event's
  // rental — reaches the payment-request router and nothing else. TIGHT: that one
  // prefix; the router answers such a caller with their OWN requests only and
  // keeps every voucher, account and supplier behind Finance's own doors. A
  // Sales caller by stable org field reaches it too (owner 2026-10-14, option
  // A): the refund they asked for from an order is a request of their own, read
  // there — raising any other request still takes the key.
  if (/\/scm\/payment-requests(\/|$)/.test(c.req.path)
    && (hasPermission(granted, "scm.payment_request.create") || isSalesUser(user))) {
    await next();
    return;
  }
  // Additive (owner 2026-10-06, product request: Sales 都能提, Purchaser 批): a
  // Sales caller by stable org field, or a holder of either flat product-request
  // key, reaches the product-request router and nothing else. The router shows
  // a requester their own requests only; the Purchaser's key sees all.
  if (/\/scm\/product-requests(\/|$)/.test(c.req.path)
    && (isSalesUser(user) || hasPermission(granted, "scm.product_request.create") || hasPermission(granted, "scm.product_request.approve"))) {
    await next();
    return;
  }
  // Additive (owner 2026-07-16): a code-keyed Sales rep must be able to READ the
  // Delivery Orders / Sales Invoices generated from their OWN Sales Orders (e.g.
  // to find + resend a customer's invoice) and the relationship-map graph that
  // links them. Admit isSalesUser for GET-only on those three read paths; the
  // sub-routers already row-scope every read to own+downline (lib/salesScope) and
  // strip cost/margin from non-finance callers (canViewScmFinance). Deliberately
  // TIGHT — GET only (a rep still cannot create/edit a DO/SI), and only these
  // paths; every other SCM area + all writes stay closed to an ungranted rep.
  if (
    c.req.method === "GET" &&
    (c.req.path.includes("/delivery-orders-mfg") ||
      c.req.path.includes("/sales-invoices") ||
      c.req.path.includes("/document-flow")) &&
    isSalesUser(user)
  ) {
    await next();
    return;
  }
  if (
    c.req.method === "GET" &&
    /\/scm\/lorries\/?$/.test(c.req.path) &&
    (isSalesUser(user) || isDirectorUser(user))
  ) {
    await next();
    return;
  }
  return c.json(
    { error: "You don't have permission to open this area." },
    403,
  );
};

/**
 * Per-page access gate. Reads `user.page_access[pageKey]` and compares
 * against `minLevel` (default 'partial' — i.e. user needs ≥partial to
 * enter). The wildcard `*` permission short-circuits to 'full'.
 *
 * Sets `c.var.access_level` so downstream handlers can branch on the
 * resolved level without re-checking.
 *
 * Usage:
 *   app.get("/", requirePageAccess("sales"), async (c) => {
 *     const level = c.get("access_level"); // 'partial' | 'full'
 *     ...
 *   });
 *
 *   app.post("/", requirePageAccess("sales", "full"), handler); // write
 */
export function requirePageAccess(
  pageKey: string,
  minLevel: AccessLevel = "partial",
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (hasPermission(granted, "*")) {
      c.set("access_level", "full");
      await next();
      return;
    }
    const level: AccessLevel = (user.page_access?.[pageKey] ?? "none") as AccessLevel;
    if (!meetsLevel(level, minLevel)) {
      return c.json(
        { error: "You don't have permission to view this page." },
        403,
      );
    }
    c.set("access_level", level);
    await next();
  };
}
