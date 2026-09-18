import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { getUserBySession, timingSafeEqualStr, type AuthUser, mintSessionPass } from "../services/auth";
import { tryPassAuth } from "../services/session-pass";
import { hasPermission } from "../services/permissions";
import { isSalesDirectorUser, isSalesUser, isDirectorUser } from "../services/pmsAccess";
import {
  fullAccessMap,
  meetsLevel,
  type AccessLevel,
} from "../services/pageAccess";

// Legacy "service" user — used when a request authenticates with the
// shared DASHBOARD_API_KEY env var (cron jobs, internal tooling). Has
// the wildcard permission, so it can hit anything.
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
  // Service user holds `*`, so scmAreaGuard bypasses it via the wildcard
  // branch regardless of this flag.
  scm_l2_configured: false,
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    /** Shortcut for `c.get("user").id` — set in the auth middleware
     *  alongside `user`. ASSR routes read this for audit columns
     *  (created_by, verified_by, etc.). */
    userId: number | null;
    /** Page-level access for the current request — set by
     *  `requirePageAccess`. Routes that need partial/full branching
     *  read this instead of recomputing. */
    access_level: AccessLevel;
    /** WHICH AUTH PATH THIS REQUEST TOOK — 'pass' skipped the two joined
     *  authorization reads, 'session-db' paid them. Set here and read ONLY by
     *  the read-only probe in routes/systemHealth.ts, so "is the fast path
     *  actually firing" is an observation rather than a reading of this file
     *  (docs/bugs/0593 is what a reading got wrong). */
    authPath: 'pass' | 'session-db';
    /** Per-request id (set by requestLog, echoed as X-Request-Id).
     *  The audit trail stamps it on each event so a logged action can
     *  be correlated back to its access-log line. */
    requestId: string;
    /** The DOOR this request's session was minted at — 'pos' (POS PIN login)
     *  or undefined (every other door, and every session minted before mig
     *  0120). Server-assigned at mint time and never accepted from the
     *  request, so unlike the `X-Client` header it replaced, a caller can
     *  neither claim nor shed it. Read by the SO pricing envelope
     *  (scm/routes/mfg-sales-orders.ts isPosTabletCaller).
     *
     *  This is the ONLY channel the origin may be read from inside
     *  /api/scm/*: the SCM auth bridge overwrites `user` with a pinned system
     *  staff row but leaves this var alone. Undefined = not-POS, always the
     *  safe direction. */
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

  // Service-tier access. DASHBOARD_API_KEY = legacy shared key (tooling/cron);
  // CONNECT_SERVICE_TOKEN = dedicated key for Houzs Connect's org sync, so that
  // integration has its own credential and the legacy key never needs rotating.
  // No session row exists, so `sessionOrigin` is deliberately left unset: these
  // are trusted backend callers, never a POS tablet, and must keep pricing
  // freely.
  if (
    (c.env.DASHBOARD_API_KEY && timingSafeEqualStr(token, c.env.DASHBOARD_API_KEY)) ||
    (c.env.CONNECT_SERVICE_TOKEN && timingSafeEqualStr(token, c.env.CONNECT_SERVICE_TOKEN))
  ) {
    c.set("user", SERVICE_USER);
    c.set("userId", (SERVICE_USER as any).id ?? null);
    await next();
    return;
  }

  // STAGE 3 — a valid, current signed pass authorizes with NO database read.
  // tryPassAuth returns null on ANY doubt (feature off / no pass / bad or
  // expired signature / revoked), and every one of those falls straight through
  // to the authoritative getUserBySession path below. So a pass NEVER grants
  // access on its own — it only ever SKIPS the DB when it is genuinely valid and
  // has not been revoked. When SESSION_SIGNING_KEY is unset this is a no-op and
  // every request takes the DB path exactly as before.
  const passUser = await tryPassAuth(c.env, c.req.header("X-Session-Pass") || "", token, Date.now());
  if (passUser) {
    c.set("authPath", "pass");
    c.set("user", passUser);
    c.set("userId", passUser.id);
    c.set("sessionOrigin", passUser.session_origin ?? undefined);
    await next();
    return;
  }

  // Otherwise it's a session token.
  const user = await getUserBySession(c.env, token);
  if (!user) {
    return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  }
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
     mintSessionPass returns null without it. */
  const reissued = await mintSessionPass(c.env, token, Date.now());
  if (reissued) c.header("X-Session-Pass", reissued);

  c.set("authPath", "session-db");
  c.set("user", user);
  // ASSR routes (assr.ts + assrPortal.ts) read `c.get("userId")` for
  // audit columns (created_by, verified_by, etc.). Set it alongside
  // `user` so those 15+ callsites don't all need to be rewritten —
  // and so `verified_by` no longer ends up as NULL on every patch.
  c.set("userId", user.id);
  // Republish the session's origin as a first-class request fact (mig 0120).
  // It must NOT be read off `user` downstream — the SCM auth bridge replaces
  // that object entirely — so this var is the single reader-facing channel.
  // `?? undefined` collapses the DB's NULL onto the same "not-POS" value an
  // absent var already has, so every consumer has ONE falsy case to handle.
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
    // Fast path: O(1) Set lookup. Falls back to the array form for
    // any caller that builds AuthUser without going through
    // hydrateAuthUser (e.g. tests / scripts).
    const granted = user.permissions_set ?? user.permissions;
    if (!hasPermission(granted, perm)) {
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
    // 1) Wildcard / matrix path — identical to requirePageAccess, unchanged.
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
    // 2) Additive code-keyed Sales/director admittance.
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
  // Legacy pass conditions — kept exactly as before.
  if (hasPermission(granted, "*") || hasPermission(granted, "scm.access")) {
    await next();
    return;
  }
  // Additive: any SCM page-access area granted at >= view.
  const pa = user.page_access ?? {};
  const hasScmPage = Object.entries(pa).some(
    ([key, level]) => key.startsWith("scm") && level !== "none",
  );
  if (hasScmPage) {
    await next();
    return;
  }
  // Additive (go-live review #5): a code-keyed Sales rep — Sales by STABLE ORG
  // FIELD (position "Sales …" / dept name containing "sales", pmsAccess.
  // isSalesUser), with NO matrix grant — is otherwise 403'd from the
  // Sales-Orders backend even though the FE (allowSales) shows it and every SO
  // route scopes them to own+downline (salesScope). Admit such a caller for the
  // SALES-ORDERS AREA ONLY (the /mfg-sales-orders sub-router). This used to say
  // it mirrors how assr.ts canAccessServiceCases OR-ins isSalesUser; that stopped
  // being true when Service Cases moved to the company grant, so the two gates
  // now answer "who is a rep" differently ON PURPOSE. Deliberately TIGHT — the
  // path gate keeps procurement / warehouse / finance SCM areas closed to a
  // Sales rep with no explicit grant.
  if (c.req.path.includes("/mfg-sales-orders") && isSalesUser(user)) {
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
  // Additive (PMS project logistics view, owner 2026-07): the Projects "Setup &
  // Dismantle" crew editor is READ-ONLY for Sales but must still SHOW the
  // currently-scheduled lorry plates. Admit a code-keyed Sales/Director for the
  // GET /api/scm/lorries LIST ONLY — view-only, no write path opened. TIGHT: the
  // method + exact-path check keeps every other SCM area (and every lorries
  // write) closed to a Sales rep with no explicit grant. (A Sales user with an
  // explicit SCM L2 config still passes the downstream scmAreaGuard via its
  // no-lockout fallback; if ever L2-restricted, the FE keeps a graceful empty
  // dropdown rather than 403-crashing.)
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
