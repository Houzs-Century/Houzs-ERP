import { Hono } from "hono";
import type { Env } from "../types";
import { assrOpenStageSql } from "../services/assrStages";
import {
  createAssrCase,
  getAssrDetail,
  transitionStage,
  markCaseOpened,
  patchAssrCase,
  listAssrCases,
  exportAssrCases,
  issueSurveyToken,
  lookupSOItems,
  addItems,
  removeItem,
  assrAttachmentKey,
  saveAttachment,
  createLogistics,
  patchLogistics,
  logActivity,
  nextServicePONumber,
  setCaseCreditorManual,
  setItemRemark,
  setItemSupplierRemark,
  setItemQty,
  setItemCartonQty,
} from "../services/assr";
import { normalizeSlaHours } from "../services/assrSla";
import { runSlaEscalation } from "../services/assrEscalation";
import { issueStaffToken, issueSalesToken, revokeCaseTokens } from "../services/caseTracking";
import { sendEmail, publicUrl } from "../services/email";
import { resolveCompanyCode, getBrandingForCompany } from "../services/branding";
import { AutoCountClient, routeRegion, isAutoCountSyncDisabled } from "../services/autocount";
import { upsertSalesOrder } from "../services/pull";
import { requirePermission, requireAnyPermission } from "../middleware/auth";
import { baseKeyOf, isThumbKey, THUMB_MAX_BYTES, thumbKeyFor } from "../services/photoThumbs";
import {
  houzsCompanyId,
  allowedCompanyIds,
  allowedCompaniesSql,
  activeCompanyId,
  type CompanyScopeCtx,
} from "../scm/lib/companyScope";
import { hasPermission } from "../services/permissions";
import { subtreeUserIds } from "../services/orgScope";
/* Row-level case visibility + the creditor strip. Lives in services/ so the
   PRINT route can apply the SAME rule — see assrVisibility.ts. */
import {
  assrUnrestricted, assrVisibleUserIds, assrVisibilityPredicateSql,
  assrCaseRowInScope, assrCallerIsScoped, stripCreditorFields, listMyCases,
} from "../services/assrVisibility";
import { notifyServiceCaseResponsible } from "../services/assrNotify";
import { isDirectorUser } from "../services/pmsAccess";
import type { AuthUser } from "../services/auth";
import type { Context, MiddlewareHandler } from "hono";
import { normalizePhone } from "../scm/shared/phone";

/* The context the extracted handlers below receive. They are exported so the
   route tests can drive them directly; the shape is exactly what app.get/post
   would have passed to an inline handler — including the PATH literal, which is
   what keeps c.req.param("id") a plain string rather than string | undefined. */
type HandlerCtx = Context<{ Bindings: Env }, "/:id/cost-suggestion">;
const app = new Hono<{ Bindings: Env }>();

// AUDIT H5 — enforce case-level tenant + ownership scope on every MUTATING
// /:id[...] route. The detail GET and its download sub-routes run their own
// scope check; the write handlers historically did not, so a scoped user could
// PATCH / reassign / rewrite / mint a survey token for ANY case by walking the
// sequential id. Centralising the guard here means the read and write paths can
// never drift again. GET is exempt (each GET handler self-checks). Routes whose
// first path segment is not the numeric case id (/attachments/:attId,
// /activity/:actId, /creditors/create, /resync-so/:docNo) are not matched by
// these patterns and are tracked as a follow-up (they need a parent-case lookup).
// /bulk/* is a fifth miss of the same kind — worse, because those ids arrive in
// the BODY, so ONE call reached every case. They carry the predicate themselves.
const enforceCaseScope: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.method === "GET") return next();
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return next();
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
  return next();
};
app.use("/:id{[0-9]+}", enforceCaseScope);
app.use("/:id{[0-9]+}/*", enforceCaseScope);

// ── Company access to Service Cases (owner rule 8, 2026-07;
//    re-keyed from job title to the COMPANY grant 2026-08-20) ──
// Service Cases + My Case are granted WITHOUT relying on the configurable
// permission matrix: whoever is authorised for the company may VIEW cases,
// CREATE cases, and see the status of cases they handled. Their DATA is still
// narrowed by assrVisibilityPredicateSql — this gate only decides who gets
// THROUGH the route, not which rows they see.
//
// WHAT CHANGED AND WHY. The middle term used to be `isSalesUser(user)`: a
// `/^sales/i` test on `position_name` plus a "sales" substring on
// `department_name`. The owner ruled that out on 2026-08-20 —
// "有 Houzs 这家公司的授权 就好（不看职称）" / "我们不 control Agent，可是我们
// control Company." A job TITLE is owner-editable free text that nobody
// re-checks against this gate, so a rename or a department move silently
// revoked Service Cases from people who still had the job. The company grant is
// provisioned deliberately, in one place, by someone who meant to.
//
// `canAccessServiceCases` passes when the caller holds ANY of the given
// permissions (the legacy path — unchanged for existing ASSR staff), OR holds
// the HOUZS company grant, OR is a director (Owner/IT `*`, Super Admin, Sales
// Director, Finance Manager). It is applied ONLY to the read + create endpoints
// — NOT to write / manage / approve / delete, which keep their original
// `requirePermission` gate so this never widens mutation access.
//
// Takes the context, not just the user, because a company grant is resolved per
// REQUEST by companyContext. Required, never optional: a gate that silently
// keeps its old answer when a caller forgets to pass the context is the
// optional-param-noop bug class at the top of BUG-HISTORY.md.
export function canAccessServiceCases(
  c: CompanyScopeCtx,
  user: AuthUser | null | undefined,
  perms: string[],
): boolean {
  if (!user) return false;
  const granted = user.permissions_set ?? user.permissions ?? [];
  if (perms.some((p) => hasPermission(granted, p))) return true;
  return holdsHouzsCompanyGrant(c) || isDirectorUser(user);
}

/**
 * Does this caller hold the HOUZS company grant?
 *
 * Reads the same three-state sentinel every other company helper does:
 *   `undefined` — company context UNRESOLVED (pre-migration, D1 test mirror,
 *                 cold start). Degrade to the legacy single-company answer, YES,
 *                 exactly as `allowedCompaniesSql` degrades to no predicate.
 *                 Treating it as "no grant" would 403 every caller on a blip.
 *   `[]`        — resolved, and the caller is granted NO active company. NO.
 *   non-empty   — YES when HOUZS is among them.
 *
 * A companies master with no HOUZS row answers NO rather than YES: at that point
 * the caller's grants are resolved and simply do not include the company this
 * gate names, and inventing a grant is never the safe direction.
 *
 * Exported for backend/tests/assrVisibilityRule.test.ts.
 */
export function holdsHouzsCompanyGrant(c: CompanyScopeCtx): boolean {
  const allowed = allowedCompanyIds(c);
  if (allowed === undefined) return true; // unresolved -> legacy single-company
  const houzs = houzsCompanyId(c);
  if (houzs === undefined) return false;
  return allowed.includes(houzs);
}

/** Route gate that admits the service_cases permission holder OR a HOUZS company
 *  grantee OR a director (see canAccessServiceCases). `perms` defaults to the
 *  read key. */
function requireServiceCaseAccess(
  perms: string[] = ["service_cases.read"],
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
    if (!canAccessServiceCases(c, user, perms)) {
      return c.json({ error: "You don't have permission to open service cases." }, 403);
    }
    await next();
  };
}

// ── Multi-company (cross-company module) ──────────────────────
// Decision trail: 2026-07-16 ASSR shipped HOUZS-only ("Service pricing CANNOT
// merge") → 2026-07-19 owner: "Assr 是兩個公司的" (reads widened for office /
// directors) → 2026-07-20 owner: 2990 raises Service Cases on the merged
// platform too, and Service Cases now follow the caller's GRANTED companies
// like the rest of the SCM portal — no ASSR-specific role pin. A rank-and-file
// rep sees ONLY their own company (a HOUZS rep's grant is {HOUZS}; a future
// 2990 rep's is {2990}); managers / office / directors granted both see the
// combined HOUZS+2990 queue. Every reader scopes to allowedCompanyIds, every
// creator stamps the switcher's active company, and an SO-attached case takes
// the SO's OWN company (createAssrCase override). Verified safe on the flip
// from the old HOUZS pin (2026-07-20): all 77 active staff carry explicit
// user_companies grants and every both-company grantee is already office /
// director, so no rank-and-file rep's scope changes today. The helpers return
// "" / [] / undefined when the companies master is unresolved (pre-migration /
// D1 test mirror / cold-start), so legacy single-company SQL runs unchanged.
//
/* Exported for backend/tests/assrCompanyScope.test.ts AND for routes/search.ts,
   which kept its own copy and drifted — global search and /api/assr answered the
   same rep differently. Takes CompanyScopeCtx, not Context<any>: all it needs is
   a `get`, and demanding a whole Hono Context is what pushes a caller into
   re-implementing it locally. */
export function assrCompanySql(c: CompanyScopeCtx, col = "company_id"): string {
  return allowedCompaniesSql(c, col);
}
// `number[] | undefined` — `undefined` = company context unresolved (degrade to
// no predicate), `[]` = caller granted no active company (match nothing). See
// the sentinel doc on allowedCompanyIds.
function assrCompanyIds(c: Context<any>): number[] | undefined {
  return allowedCompanyIds(c);
}
// CREATE stamp resolver (owner 2026-07-20 — 2990 runs Service Cases here).
// Every creator raises a case for the company their top-bar switcher sits on,
// falling back to HOUZS when no active company resolves (single-company legacy
// / cold-start). When the case's doc_no resolves to a local scm SO,
// createAssrCase overrides this with the SO's own company. Exported for
// backend/tests/assrCompanyScope.test.ts.
export function assrCreateCompanyId(c: Context<any>): number | undefined {
  return activeCompanyId(c) ?? houzsCompanyId(c);
}

// ` AND (...)` wrapper around THE row-visibility rule, for the AGGREGATE
// endpoints (/summary, /metrics, /by-creditor, /metrics/drill, /logistics/all),
// which build their WHERE by interpolation. The rule itself is
// assrVisibilityPredicateSql (services/assrVisibility.ts) — the same string the
// paginated list and the CSV export splice in through pushVisibilityScope, and
// the same one the detail / print row check asks the database. ONE rule, ONE
// home: this used to be a hand-maintained TWIN of pushVisibilityScope, and a
// drift between them is what `fix/assr-aggregate-scope` had to close when the
// list and its own totals disagreed.
//
// `binds` is now always EMPTY — every id is inlined after re-validation, so
// there is nothing positional left to get wrong. The field is kept because the
// aggregate handlers splice it into their own bind arrays at the position the
// fragment appears; spreading an empty array there is a no-op and removing it
// would touch every one of those call sites for no behaviour change.
function assrVisibilitySql(
  ids: number[] | undefined,
  prefix: string,
): { sql: string; binds: string[] } {
  const pred = assrVisibilityPredicateSql(ids, prefix);
  if (pred === null) return { sql: "", binds: [] };
  return { sql: ` AND (${pred})`, binds: [] };
}

/** The row-level scope for the aggregate endpoints, resolved once per request.
 *  Returns a builder because the same scope has to be rendered against several
 *  table aliases within one handler. */
async function assrVisibilityScope(c: {
  get(key: "user"): unknown;
  env: Env;
}): Promise<(prefix?: string) => { sql: string; binds: string[] }> {
  const ids = await assrVisibleUserIds(c);
  // "assr_cases." — not "" — for an unaliased `FROM assr_cases`: the rule
  // references doc_no inside a subquery-bearing expression and an unqualified
  // column there is ambiguous. See assrVisibilityPredicateSql.
  return (prefix = "c.") => assrVisibilitySql(ids, prefix);
}

/**
 * True when the case identified by `caseId` is within the caller's scope on BOTH
 * dimensions — the case's company is in the caller's granted set, and the
 * row-visibility rule admits it. Sales-reachable SUB-routes (attachment /
 * timeline download, sales comment / nudge) go through here so they cannot
 * reach a case the list would not show. A missing/unknown case returns false so
 * the caller gets the same 404 as a nonexistent id (never distinguishes
 * existence across the scope boundary). Raw env.DB reads return snake_case
 * columns (D1-compat shim — same as the customer-history query below).
 *
 * The row rule is NOT restated here: it delegates to assrCaseRowInScope, which
 * answers through the same SQL predicate the list builds its WHERE from. This
 * function used to carry its own copy of the id + agent-name test, which is two
 * places to change and one to forget.
 */
async function caseInCallerScope(
  c: { get(key: "user"): unknown; env: Env },
  caseId: number,
): Promise<boolean> {
  const visibleIds = await assrVisibleUserIds(c);
  // Every caller passes a full Hono Context; the structural param type above is
  // just the minimal shape this fn reads. assrCompanyIds wants the real Context.
  const allowedCo = assrCompanyIds(c as Context<any>);
  // Fully unrestricted on BOTH dimensions — no read needed.
  if (visibleIds === undefined && allowedCo === undefined) return true;
  const row = await c.env.DB.prepare(
    `SELECT id, created_by, assigned_to, assigned_to_2, doc_no, company_id FROM assr_cases WHERE id = ?`,
  )
    .bind(caseId)
    .first<{ id: number; created_by: number | null; assigned_to: number | null; assigned_to_2: number | null; doc_no: string | null; company_id: number | null }>();
  if (!row) return false;
  // Company scope FIRST — mirrors the detail GET (see the /:id handler): when the
  // caller's company set is resolved, the case's company must be inside it. This
  // must precede the visibility early-return below, or a visibility-unrestricted
  // director scoped to company A could still reach company B's case.
  if (allowedCo) {
    const caseCo = Number(row.company_id ?? NaN);
    if (Number.isFinite(caseCo) && !allowedCo.includes(caseCo)) return false;
  }
  if (visibleIds === undefined) return true; // unrestricted visibility tier
  return assrCaseRowInScope(c as Context<any>, row);
}

// ── Module-level settings (default assignees) ─────────────────
//
// Stored in `system_settings` under keys `assr_default_assignee_id`
// (primary) and `assr_default_assignee2_id` (co-assignee — the desk
// is run by two people). Read on each create_case call so changes
// take effect immediately without a deploy.

const DEFAULT_ASSIGNEE_KEYS = {
  default_assignee_id: "assr_default_assignee_id",
  default_assignee2_id: "assr_default_assignee2_id",
} as const;

app.get("/settings", requirePermission("service_cases.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.key AS key, u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM system_settings s
       LEFT JOIN users u ON CAST(s.value AS INTEGER) = u.id
      WHERE s.key IN ('assr_default_assignee_id', 'assr_default_assignee2_id')`
  ).all<{
    key: string;
    user_id: number | null;
    user_name: string | null;
    user_email: string | null;
  }>();
  const byKey = new Map((rows.results ?? []).map((r) => [r.key, r]));
  const primary = byKey.get("assr_default_assignee_id");
  const second = byKey.get("assr_default_assignee2_id");
  return c.json({
    default_assignee_id: primary?.user_id ?? null,
    default_assignee_name: primary?.user_name ?? null,
    default_assignee_email: primary?.user_email ?? null,
    default_assignee2_id: second?.user_id ?? null,
    default_assignee2_name: second?.user_name ?? null,
    default_assignee2_email: second?.user_email ?? null,
  });
});

app.put("/settings", requirePermission("service_cases.manage"), async (c) => {
  const body = await c.req.json<{
    default_assignee_id?: number | null;
    default_assignee2_id?: number | null;
  }>();
  for (const [field, key] of Object.entries(DEFAULT_ASSIGNEE_KEYS)) {
    if (!(field in body)) continue; // untouched fields stay as-is
    const id = body[field as keyof typeof DEFAULT_ASSIGNEE_KEYS];
    if (id === null || id === undefined) {
      await c.env.DB.prepare(`DELETE FROM system_settings WHERE key = ?`).bind(key).run();
    } else {
      if (typeof id !== "number" || isNaN(id)) {
        return c.json({ error: `${field} must be a number or null` }, 400);
      }
      // INSERT OR REPLACE so we don't care whether the row exists yet.
      await c.env.DB.prepare(
        `INSERT INTO system_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
        .bind(key, String(id))
        .run();
    }
  }
  return c.json({ ok: true });
});

// ── Lookups (mig 065) ─────────────────────────────────────────
//
// Per-module pickers maintained from Service Maintenance. Same
// shape across the four kinds — slug + name + sort_order + active —
// so one set of routes handles them all via a `kind` path param.
// Slugs are stable values; names are display labels admins can
// rename without breaking historical case data.

const LOOKUP_TABLES = {
  "issue-categories": "assr_issue_categories",
  "resolution-methods": "assr_resolution_methods",
  "priorities": "assr_priorities",
  "ncr-categories": "assr_ncr_categories",
  // Mig 0112 — mirrors AutoCount's item groups; seeded with the common
  // furniture groups, admin-maintained until the AutoCount reconnect
  // back-fills the authoritative list.
  "product-categories": "assr_product_categories",
} as const;
type LookupKind = keyof typeof LOOKUP_TABLES;

function lookupTable(kind: string): string | null {
  return (LOOKUP_TABLES as Record<string, string>)[kind] ?? null;
}


app.get("/lookups/:kind", requireServiceCaseAccess(), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const includeInactive = c.req.query("include_inactive") === "1";
  // priorities surface sla_hours so the manager UI can edit it; the
  // other three only have the common columns. Casting to ANY at the
  // bind layer because column shape varies.
  const slaCol = kind === "priorities" ? ", sla_hours" : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, name, sort_order, active${slaCol}
       FROM ${table}
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY sort_order ASC, name ASC`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/lookups/:kind", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const body = await c.req.json<{
    name: string;
    slug?: string;
    sort_order?: number;
    sla_hours?: number;
  }>();
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  // Auto-slug when not provided. Lowercased, spaces → underscores,
  // strip anything that isn't alnum/underscore. Manual override is
  // accepted to keep historical slugs stable.
  const slug = (
    body.slug?.trim() ||
    name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
  );
  const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0;
  if (kind === "priorities") {
    const sla = normalizeSlaHours(body.sla_hours);
    if (sla === false) {
      return c.json({ error: "sla_hours must be a positive whole number of hours, or blank" }, 400);
    }
    await c.env.DB.prepare(
      `INSERT INTO assr_priorities (slug, name, sort_order, sla_hours)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(slug, name, sortOrder, sla)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO ${table} (slug, name, sort_order) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(slug, name, sortOrder)
      .run();
  }
  return c.json({ ok: true, slug });
});

app.patch("/lookups/:kind/:id", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<Record<string, any>>();

  const allowed = ["name", "sort_order", "active"];
  if (kind === "priorities") allowed.push("sla_hours");
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      if (k === "sla_hours") {
        const sla = normalizeSlaHours(body.sla_hours);
        if (sla === false) {
          return c.json({ error: "sla_hours must be a positive whole number of hours, or blank" }, 400);
        }
        sets.push("sla_hours = ?");
        binds.push(sla);
        continue;
      }
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return c.json({ error: "no fields to update" }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

// Bulk reorder. Same shape as the project bulk-reorder endpoints:
// `{ ids: [...] }` in the new display order; sort_order is rewritten
// in steps of 10 so future inserts can slot between rows.
app.put("/lookups/:kind/reorder", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
    return c.json({ error: "ids must be an array of integers" }, 400);
  }
  const ids = body.ids as number[];
  if (ids.length === 0) return c.json({ ok: true });
  await c.env.DB.batch(
    ids.map((id, idx) =>
      c.env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
        .bind((idx + 1) * 10, id),
    ),
  );
  return c.json({ ok: true });
});

app.delete("/lookups/:kind/:id", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Soft-delete only — historical case rows still hold the slug as
  // their `priority` / `resolution_method` / etc., and we don't want
  // to break filters retroactively. `active = 0` just hides from the
  // picker.
  await c.env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Cost auto-fill suggestion ─────────────────────────────────
//
// Looks up the case's item_code in (a) the linked sales order's lines,
// and (b) the linked purchase order's lines. Returns the unit-price ×
// qty for each side so the frontend can offer to populate
// customer_amount and po_amount in one click. The user can still edit
// after — this is a suggestion, not a write.

export const assrCostSuggestionHandler = async (c: HandlerCtx) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const caseRow = await c.env.DB.prepare(
    `SELECT doc_no, po_no, item_code FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ doc_no: string | null; po_no: string | null; item_code: string | null }>();
  if (!caseRow) return c.json({ error: "Not found" }, 404);
  /* Go-live review #11 — this sub-panel used requirePermission("service_cases.
     read"), 403-ing a Sales viewer who legitimately opened this case. Gate on
     requireServiceCaseAccess (admits Sales / director) + the SAME case-in-scope
     check the detail GET performs, so a scoped viewer of THIS case can load the
     panel while an out-of-scope case still answers 404. */
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);

  const itemCode = (caseRow.item_code || "").trim();
  if (!itemCode) {
    return c.json({
      customer_amount: null,
      po_amount: null,
      sources: { so: null, po: null },
      reason: "Case has no item_code — set one before auto-filling.",
    });
  }

  // ── Sales order lookup (revenue side) ──────────────────────────
  // SO line detail isn't cached in D1; fetch live from AutoCount.
  let customerAmount: number | null = null;
  let soSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.doc_no) {
    try {
      const client = new AutoCountClient(c.env);
      const lines = await client.getDetail(caseRow.doc_no);
      const match = matchLine(lines as any[], itemCode);
      if (match) {
        const qty = num((match as any).Qty) ?? 1;
        const price = num((match as any).UnitPrice) ?? 0;
        const amount = num((match as any).Amount) ?? qty * price;
        customerAmount = amount;
        soSource = { doc_no: caseRow.doc_no, unit_price: price, qty };
      }
    } catch (e: any) {
      console.warn(`[assr.cost-suggestion] SO lookup failed for ${caseRow.doc_no}:`, e?.message || e);
    }
  }

  // ── Purchase order lookup (supplier cost side) ─────────────────
  let poAmount: number | null = null;
  let poSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.po_no) {
    // PO line table is purchase_orders (one row per outstanding line),
    // keyed by (doc_no, item_code). Pull the matching line.
    // The PO line table stores `original_qty` (the full line quantity at
    // doc creation, added in migration 030) and `remaining_qty` (still
    // outstanding). Earlier code referenced `ordered_qty`, which never
    // existed and crashed auto-fill with a SQLite "no such column" error.
    const poRow = await c.env.DB.prepare(
      `SELECT remaining_qty AS qty,
              original_qty  AS ord_qty,
              unit_price    AS price
         FROM purchase_orders
        WHERE doc_no = ? AND item_code = ?
        LIMIT 1`
    )
      .bind(caseRow.po_no, itemCode)
      .first<{ qty: number | null; ord_qty: number | null; price: number | null }>();
    if (poRow && poRow.price != null) {
      const qty = poRow.ord_qty ?? poRow.qty ?? 1;
      poAmount = qty * poRow.price;
      poSource = { doc_no: caseRow.po_no, unit_price: poRow.price, qty };
    }
  }

  return c.json({
    customer_amount: customerAmount,
    po_amount: poAmount,
    sources: { so: soSource, po: poSource },
  });
};
app.get("/:id/cost-suggestion", requireServiceCaseAccess(), assrCostSuggestionHandler);

// ── Summary ───────────────────────────────────────────────────

app.get("/summary", requirePermission("service_cases.read"), async (c) => {
  // Accept the same period filter the /metrics endpoint takes so the
  // ServiceMetrics dashboard can share one dropdown. The pulse row
  // (Pending Review / Aging / Breach) and Stage Funnel below now narrow
  // to cases whose complaint / creation date falls inside the window —
  // previously they were always "real-time across all data" and so
  // looked frozen as the user switched periods.
  const sinceDays = Math.min(730, Math.max(1, parseInt(c.req.query("since_days") || "90", 10) || 90));
  const periodAnd =
    `AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`;
  // Allowed-companies predicates ("" when unresolved) — one per table alias
  // used below.
  const coC = assrCompanySql(c, "c.company_id");
  const coBare = assrCompanySql(c);
  // Row-level visibility, the SAME scope the list applies. Without it every
  // tile below counted the whole company for a caller whose list showed only
  // their own subtree. "" for the unrestricted tier, so a director's SQL is
  // unchanged.
  const vis = await assrVisibilityScope(c);
  const visC = vis("c.");
  const visBare = vis("assr_cases.");

  // These 13 aggregates are independent of one another and depend only on the
  // predicates resolved above, so they run as ONE concurrent wave instead of 13
  // serial round trips. They share a Postgres client either way (routes/search.ts
  // and routes/finance.ts do the same over env.DB), so this only removes
  // round-trip latency — every statement is byte-identical to its serial form.
  // Measured serially at ~219ms, the slower half of the Service Cases page load
  // (docs/modules/service-case.md section 5, which prescribes exactly this fix).
  const [
    totals,
    active,
    byStage,
    byStatus,
    byLocation,
    byCategory,
    recent,
    aging,
    breach,
    pendingReview,
    avgE2E,
    funnel,
    csatTrend,
  ] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM assr_cases WHERE 1=1${coBare}${visBare.sql}`
    )
      .bind(...visBare.binds)
      .first<{ total: number }>(),

    // Active backlog: cases still in progress (not completed) and not
    // archived — "how many cases are open right now". Deliberately NOT
    // period-filtered: the Overview KPI reflects the live workload, not a
    // rolling window. 'completed' is the only terminal stage (same
    // definition the breach / aging queries use).
    c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM assr_cases
      WHERE ${assrOpenStageSql()} AND archived_at IS NULL${coBare}${visBare.sql}`
    )
      .bind(...visBare.binds)
      .first<{ count: number }>(),

    c.env.DB.prepare(
      `SELECT stage, COUNT(*) as count FROM assr_cases WHERE 1=1${coBare}${visBare.sql} GROUP BY stage`
    )
      .bind(...visBare.binds)
      .all(),

    c.env.DB.prepare(
      `SELECT status, COUNT(*) as count FROM assr_cases WHERE 1=1${coBare}${visBare.sql} GROUP BY status`
    )
      .bind(...visBare.binds)
      .all(),

    c.env.DB.prepare(
      `SELECT location, COUNT(*) as count FROM assr_cases
     WHERE location IS NOT NULL${coBare}${visBare.sql}
     GROUP BY location ORDER BY count DESC LIMIT 5`
    )
      .bind(...visBare.binds)
      .all(),

    // Group by issue_category. The intake form now captures this on
    // every new case (replacing the older service_category-driven flow),
    // so this gives dispatchers a live view of what's coming in.
    c.env.DB.prepare(
      `SELECT issue_category as name, COUNT(*) as count FROM assr_cases
     WHERE issue_category IS NOT NULL${coBare}${visBare.sql}
     GROUP BY issue_category ORDER BY count DESC LIMIT 5`
    )
      .bind(...visBare.binds)
      .all(),

    c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM assr_cases
     WHERE complained_date IS NOT NULL
       AND complained_date >= date('now', '-30 days')${coBare}${visBare.sql}`
    )
      .bind(...visBare.binds)
      .first<{ count: number }>(),

    // Aging: cases still open that have been in their current stage >3 days
    c.env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM assr_cases c
      WHERE ${assrOpenStageSql("c")}
        ${periodAnd}${coC}${visC.sql}
        AND julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(a.created_at)
                   FROM assr_activity a
                  WHERE a.assr_id = c.id
                    AND a.action = 'stage_change'
                    AND a.to_value = c.stage),
                c.created_at
              )
            ) > 3`
    )
      .bind(...visC.binds)
      .first<{ count: number }>(),

    // SLA breach: open cases whose CURRENT stage has crossed 100% of its
    // snapshotted per-stage target. Uses the SAME stage-level definition as
    // the Stage Funnel below (assr_stage_history.target_days + entered_at)
    // so the KPI tile and the funnel's breach totals reconcile. Previously
    // this used case-level deadline_at, which diverged from the funnel and
    // showed a different number on the same page.
    c.env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM assr_cases c
       JOIN assr_stage_history h
              ON h.assr_id = c.id AND h.exited_at IS NULL
      WHERE ${assrOpenStageSql("c")}
        AND c.archived_at IS NULL
        ${periodAnd}${coC}${visC.sql}
        AND h.target_days IS NOT NULL AND h.target_days > 0
        AND (julianday('now') - julianday(h.entered_at)) / h.target_days >= 1`
    )
      .bind(...visC.binds)
      .first<{ count: number }>(),

    // v3.1 — Pending Review tile
    c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM assr_cases c
      WHERE c.stage = 'pending_review' AND c.archived_at IS NULL
        ${periodAnd}${coC}${visC.sql}`
    )
      .bind(...visC.binds)
      .first<{ count: number }>(),

    // v3.1 — Avg end-to-end lead time (days), completed cases only.
    // Filter out rows where closed_at < created_at — legacy data has
    // some rows with a closed_at predating the case created_at (likely
    // imported from AutoCount with a different timestamp source), and
    // including them produces a wildly negative average. Window now
    // honours the dashboard's since_days instead of the old hardcoded 90d.
    c.env.DB.prepare(
      `SELECT AVG(julianday(closed_at) - julianday(created_at)) AS avg_days
       FROM assr_cases
      WHERE stage = 'completed'
        AND closed_at IS NOT NULL
        AND julianday(closed_at) > julianday(created_at)
        AND (julianday(closed_at) - julianday(created_at)) < 365
        AND closed_at >= date('now', '-${sinceDays} days')${coBare}${visBare.sql}`
    )
      .bind(...visBare.binds)
      .first<{ avg_days: number | null }>(),

    // v3.1 — Stage funnel: count by 9-stage enum, in canonical order,
    // with breach-aware fill colour (% of cases in this stage that have
    // crossed 100% of their snapshotted target). sub_return (Nico
    // 2026-08-22) counts the supplier bucket's RETURN leg so the funnel
    // card reads "X await pickup · Y await return" for supplier chasing.
    // (No -- comments inside prepared SQL: a quote in one breaks the
    // d1-compat placeholder scan — the 2026-08-11 prod outage.)
    c.env.DB.prepare(
      `SELECT c.stage AS stage,
            COUNT(*) AS total,
            SUM(CASE
                  WHEN h.target_days IS NOT NULL AND h.target_days > 0
                   AND (julianday('now') - julianday(h.entered_at)) / h.target_days >= 1
                  THEN 1 ELSE 0 END) AS breached,
            SUM(CASE WHEN COALESCE(c.sub_status, 'none') = 'pending_supplier_return' THEN 1 ELSE 0 END) AS sub_return
       FROM assr_cases c
       LEFT JOIN assr_stage_history h
              ON h.assr_id = c.id AND h.exited_at IS NULL
      WHERE c.archived_at IS NULL
        ${periodAnd}${coC}${visC.sql}
      GROUP BY c.stage`
    )
      .bind(...visC.binds)
      .all<{ stage: string; total: number; breached: number; sub_return: number }>(),

    // v3.1 — CSAT 13-week rolling trend (weekly average ratings)
    c.env.DB.prepare(
      `SELECT strftime('%Y-W%W', closed_at) AS week,
            AVG(satisfaction_rating) AS avg_rating,
            COUNT(satisfaction_rating) AS n
       FROM assr_cases
      WHERE stage = 'completed'
        AND satisfaction_rating IS NOT NULL
        AND closed_at >= date('now', '-91 days')${coBare}${visBare.sql}
      GROUP BY week
      ORDER BY week`
    )
      .bind(...visBare.binds)
      .all<{ week: string; avg_rating: number; n: number }>(),
  ]);

  return c.json({
    total: totals?.total || 0,
    active_count: active?.count || 0,
    by_stage: byStage.results,
    by_status: byStatus.results,
    by_location: byLocation.results,
    by_category: byCategory.results,
    recent_30d: recent?.count || 0,
    aging_count: aging?.count || 0,
    breach_count: breach?.count || 0,
    // v3.1 enrichments
    pending_review_count: pendingReview?.count || 0,
    avg_e2e_days: avgE2E?.avg_days != null ? Number(Number(avgE2E.avg_days).toFixed(1)) : null,
    stage_funnel: funnel.results ?? [],
    csat_trend: csatTrend.results ?? [],
  });
});

// ── List ──────────────────────────────────────────────────────

app.get("/", requireServiceCaseAccess(), async (c) => {
  const assignedToParam = c.req.query("assigned_to");
  const visibleIds = await assrVisibleUserIds(c);
  const result = await listAssrCases(c.env, {
    visible_to_user_ids: visibleIds,
    allowed_company_ids: assrCompanyIds(c),
    stage: c.req.query("stage"),
    status: c.req.query("status"),
    search: c.req.query("search"),
    assigned_to: assignedToParam ? parseInt(assignedToParam, 10) : undefined,
    creditor_code: c.req.query("creditor_code") || undefined,
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
    include_archived: c.req.query("include_archived") === "1",
    archived_only: c.req.query("archived_only") === "1",
    exclude_stage: c.req.query("exclude_stage") || undefined,
    // Calendar month-window bound (perf/servicecase-board-calendar-bound).
    // Additive: absent from/to leaves the query unbounded (List view et al).
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    date_field: c.req.query("date_field") === "deadline" ? "deadline" : "reported",
    sort_by: c.req.query("sort_by") || undefined,
    sort_dir: (c.req.query("sort_dir") || "").toLowerCase() === "asc" ? "asc" : "desc",
  });
  if (visibleIds !== undefined) {
    for (const row of (result.data as any[]) ?? []) stripCreditorFields(row);
  }
  return c.json(result);
});

// Manually re-run the item → creditor lookup for a single case.
// Useful for backfilling existing cases whose creditor_code is null
// (e.g. cases created before the auto-resolve hook shipped).
app.post("/:id/resolve-creditor", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT item_code FROM assr_cases WHERE id = ? AND archived_at IS NULL`
  )
    .bind(id)
    .first<{ item_code: string | null }>();
  if (!row) return c.json({ error: "Case not found" }, 404);
  if (!row.item_code)
    return c.json({ error: "Case has no item_code — set one first" }, 400);

  try {
    const { resolveCreditorForCase } = await import("../services/stockItems");
    const creditorCode = await resolveCreditorForCase(c.env, id, row.item_code, { force: true });
    return c.json({
      ok: true,
      item_code: row.item_code,
      creditor_code: creditorCode,
      message: creditorCode
        ? `Resolved ${row.item_code} → ${creditorCode}`
        : `${row.item_code} has no MainSupplier in AutoCount`,
    });
  } catch {
    // Plain-language rule: never surface raw exception text to the user.
    return c.json({ error: "Couldn't reach AutoCount to resolve the supplier. Try again shortly." }, 502);
  }
});

// Manual AutoCount DO-mirror refresh. The daily 02:00 cron does this
// unattended; this path exists for the first backfill right after deploy
// and for "the DO I just cut isn't showing yet" moments. Incremental via
// getSince where the middleware supports it; otherwise streams the full
// ~70 MB dump, so expect a few seconds.
app.post("/sync-delivery-orders", requirePermission("service_cases.manage"), async (c) => {
  try {
    const { runDoMirrorSync } = await import("../services/doMirror");
    const r = await runDoMirrorSync(c.env, "MANUAL");
    return c.json(r);
  } catch {
    // Plain-language rule: never surface raw exception text to the user.
    return c.json({ error: "Couldn't reach AutoCount to refresh delivery orders. Try again shortly." }, 502);
  }
});

// ── Creditor search / manual assignment ──────────────────────
// AutoCount's creditor sync is partial and many items carry no
// MainSupplier, so staff can search the local creditors mirror and
// hand-link a supplier — or register one AutoCount doesn't have yet
// (type='MANUAL'). Hand-picked links set creditor_source='manual' so
// auto-resolution leaves them alone.

app.get("/creditors/search", requireServiceCaseAccess(), async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const like = `%${q}%`;
  // Company scope (owner audit 2026-07-22): creditors gained company_id in mig
  // 0083 (all HOUZS today, but nothing on the DB side enforces that). Without a
  // predicate here, the moment a 2990 creditor lands, a 2990-only ASSR caller
  // sees it under Houzs — same class as the /search-so leak fixed in PR #990.
  // ASSR is Houzs-exclusive by owner rule, so pin to the caller's ASSR reach.
  const rows = await c.env.DB.prepare(
    `SELECT creditor_code, company_name, phone1
       FROM creditors
      WHERE (LOWER(creditor_code) LIKE ? OR LOWER(COALESCE(company_name, '')) LIKE ?)${assrCompanySql(c)}
      ORDER BY company_name
      LIMIT 20`
  )
    .bind(like, like)
    .all();
  return c.json({ results: rows.results ?? [] });
});

app.post("/creditors/create", requirePermission("service_cases.write"), async (c) => {
  const body = await c.req.json<{
    creditor_code?: string;
    company_name?: string;
    phone?: string;
    email?: string;
  }>();
  const name = (body.company_name || "").trim();
  if (!name) return c.json({ error: "Supplier name is required" }, 400);

  let code = (body.creditor_code || "").trim();
  if (!code) {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM creditors WHERE creditor_code LIKE 'MAN-%'`
    ).first<{ n: number }>();
    code = `MAN-${String(Number(row?.n ?? 0) + 1).padStart(4, "0")}`;
  }

  const dup = await c.env.DB.prepare(
    `SELECT creditor_code, company_name FROM creditors WHERE creditor_code = ?`
  )
    .bind(code)
    .first<{ creditor_code: string; company_name: string | null }>();
  if (dup) {
    return c.json(
      { error: `Supplier code ${code} already exists (${dup.company_name || "unnamed"})` },
      409
    );
  }

  await c.env.DB.prepare(
    `INSERT INTO creditors (creditor_code, company_name, phone1, email, type, type_description, updated_at)
     VALUES (?, ?, ?, ?, 'MANUAL', 'Added manually from Service Cases', datetime('now'))`
  )
    // phone1 is stored E.164 like every other creditor phone written through
    // the SCM supplier routes; this "add supplier from a Service Case" path was
    // the one creditor writer that only trimmed, so it seeded rows the supplier
    // screens then displayed in a different format from their neighbours.
    .bind(code, name, normalizePhone(body.phone), (body.email || "").trim() || null)
    .run();

  return c.json({ creditor_code: code, company_name: name }, 201);
});

app.post("/:id{[0-9]+}/set-creditor", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{ creditor_code?: string | null }>();
  const userId = (c as any).get?.("userId") ?? null;
  const code =
    body.creditor_code == null ? null : String(body.creditor_code).trim() || null;
  const res = await setCaseCreditorManual(c.env, id, code, userId);
  if (!res.ok) return c.json({ error: res.error }, res.status);
  return c.json({ ok: true, creditor_code: code, creditor_name: res.creditor_name });
});

// ── Cases grouped by creditor ────────────────────────────────
// Feeds the "By Creditor" tab. One row per creditor_code with open /
// closed / breached counts, joined to the creditors mirror for the
// display name. Null creditor_code (unresolved) rolls up into a
// separate `unassigned` bucket so the caller can surface it.
app.get("/by-creditor", requirePermission("service_cases.read"), async (c) => {
  const search = (c.req.query("search") || "").trim();
  const like = search ? `%${search}%` : null;
  const coC = assrCompanySql(c, "c.company_id");
  const vis = await assrVisibilityScope(c);
  const visC = vis("c.");
  const visBare = vis("assr_cases.");

  const rowsQ = c.env.DB.prepare(
    `SELECT c.creditor_code,
            cr.company_name AS creditor_name,
            cr.email        AS email,
            cr.phone1       AS phone,
            COUNT(*) AS total,
            SUM(CASE WHEN ${assrOpenStageSql("c")} THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN c.stage  = 'completed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN ${assrOpenStageSql("c")}
                      AND c.deadline_at IS NOT NULL
                      AND datetime('now') > c.deadline_at THEN 1 ELSE 0 END) AS breached,
            MAX(c.updated_at) AS last_activity_at
       FROM assr_cases c
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
      WHERE c.archived_at IS NULL
        AND c.creditor_code IS NOT NULL${coC}${visC.sql}
        ${like ? "AND (cr.company_name LIKE ? OR c.creditor_code LIKE ?)" : ""}
      GROUP BY c.creditor_code
      ORDER BY total DESC, creditor_name ASC`
  );
  // Binds are positional and the visibility fragment sits BEFORE the search
  // clause in the SQL above, so its binds must lead here too.
  const rows = like
    ? await rowsQ.bind(...visC.binds, like, like).all()
    : await rowsQ.bind(...visC.binds).all();

  const unassigned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ${assrOpenStageSql()} THEN 1 ELSE 0 END) AS open
       FROM assr_cases
      WHERE archived_at IS NULL AND (creditor_code IS NULL OR creditor_code = '')${assrCompanySql(c)}${visBare.sql}`
  )
    .bind(...visBare.binds)
    .first<{ total: number; open: number }>();

  return c.json({
    rows: rows.results ?? [],
    unassigned: {
      total: unassigned?.total ?? 0,
      open: unassigned?.open ?? 0,
    },
  });
});

// ── Bulk actions ──────────────────────────────────────────────
// Operate on a list of case IDs in one request. Each item is best-effort:
// failures are collected per-id rather than aborting the batch, so a stale
// row in the selection (e.g. someone else just archived it) doesn't kill
// the rest. Returns counts + per-id errors so the UI can show a useful
// summary toast.

async function bulkRun(
  ids: number[],
  fn: (id: number) => Promise<void>
): Promise<{ ok: number; failed: { id: number; error: string }[] }> {
  let ok = 0;
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    try {
      await fn(id);
      ok++;
    } catch (e: any) {
      failed.push({ id, error: e?.message || String(e) });
    }
  }
  return { ok, failed };
}

/* COMPANY SCOPE ON THE BULK WRITES.

   enforceCaseScope (top of this file) CANNOT reach these: it is mounted on
   "/:id{[0-9]+}" and "/:id{[0-9]+}/*", so it fires only when the first path
   segment is the numeric case id. These three are /bulk/..., their ids arrive in
   the BODY, and ids are sequential integers — so one call reached the other
   company's cases wholesale while the detail GET 404s the same case. The client
   is service-role (RLS bypassed, mig 0061), so the route predicate is the only
   boundary.

   assrCompanySql is the SAME helper the reads use, and it emits "" when the
   company context is unresolved, so single-company installs are unchanged. */

app.post("/bulk/archive", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? null;
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const coSql = assrCompanySql(c);
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases
          SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL${coSql}`
    )
      .bind(userId, id)
      .run();
  });
  return c.json(result);
});

app.post("/bulk/unarchive", requirePermission("service_cases.manage"), async (c) => {
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const coSql = assrCompanySql(c);
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases
          SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NOT NULL${coSql}`
    )
      .bind(id)
      .run();
  });
  return c.json(result);
});

app.post("/bulk/assign", requirePermission("service_cases.manage"), async (c) => {
  // company-scope: scoped by string-built SQL the checker cannot see — :1116 takes assrCompanySql (allowedCompaniesSql, the caller's granted companies) and :1119 applies it to the UPDATE itself. Out of scope moves no row, and :1123 stops rather than log an assignment that did not happen. Verified 2026-08-19.
  const userId = (c as any).get?.("userId") ?? null;
  const body = await c.req.json<{ ids?: number[]; assigned_to?: number | null }>();
  // De-dupe: a repeated id would assign + notify the SAME case twice, posting
  // two identical "reassigned" cards (owner 2026-07-20).
  const ids = [...new Set((body.ids || []).filter((n) => Number.isInteger(n)))];
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const assigneeId = body.assigned_to ?? null;
  const coSql = assrCompanySql(c);
  const result = await bulkRun(ids, async (id) => {
    const res = await c.env.DB.prepare(
      `UPDATE assr_cases SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?${coSql}`
    )
      .bind(assigneeId, id)
      .run();
    /* Out of scope -> no row moved. Stop rather than log an assignment that did
       not happen; bulkRun collects the throw as this id's per-item error. */
    if (!res.meta.changes) throw new Error("Not found");
    await c.env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
       VALUES (?, 'assignment', NULL, ?, 'bulk', ?)`
    )
      .bind(id, String(assigneeId ?? ""), userId)
      .run();
    // Same responsible-change notice as the single PATCH (owner 2026-07-15):
    // tell the new assignee + their upline. Only on assignment TO someone
    // (un-assign has nobody new to notify). Best-effort — never throws.
    if (assigneeId != null) {
      const row = await c.env.DB.prepare(
        `SELECT assr_no, customer_name FROM assr_cases WHERE id = ?`,
      )
        .bind(id)
        .first<{ assr_no: string | null; customer_name: string | null }>();
      await notifyServiceCaseResponsible(c.env, {
        reason: "reassigned",
        assrNo: row?.assr_no ?? null,
        customerName: row?.customer_name ?? null,
        userIds: [assigneeId],
      });
    }
  });
  return c.json(result);
});

// ── CSV export ────────────────────────────────────────────────
// Returns the full filtered case list (capped at 10k rows) as CSV.
// Honors the same filters as the list endpoint so "what you see is
// what you export" matches the table.

app.get("/export.csv", requireServiceCaseAccess(), async (c) => {
  const csvVisibleIds = await assrVisibleUserIds(c);
  const rows = await exportAssrCases(c.env, {
    visible_to_user_ids: csvVisibleIds,
    allowed_company_ids: assrCompanyIds(c),
    stage: c.req.query("stage"),
    status: c.req.query("status"),
    search: c.req.query("search"),
    include_archived: c.req.query("include_archived") === "1",
    archived_only: c.req.query("archived_only") === "1",
    exclude_stage: c.req.query("exclude_stage") || undefined,
  });
  const headers = [
    "ASSR No", "SO No", "Delivery Order", "Stage", "Status", "Priority",
    "Customer", "Phone", "Location", "Salesperson",
    "Category", "NCR Category", "Resolution",
    "Item", "Issue",
    "Complained Date", "Created", "Deadline",
    "PO Amount", "PO No",
    "Assigned To", "Created By", "Creditor",
    "SLA Breached",
  ];
  const fields = [
    "assr_no", "doc_no", "delivery_order", "stage", "status", "priority",
    "customer_name", "customer_phone", "location", "sales_agent",
    "service_category", "ncr_category", "resolution_method",
    "item_code", "complaint_issue",
    "complained_date", "created_at", "deadline_at",
    "po_amount", "po_no",
    "assigned_to_name", "created_by_name", "creditor_name",
    "is_breached",
  ];
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows as any[]) {
    if (csvVisibleIds !== undefined) stripCreditorFields(r);
    // Hand-entered DO wins; the live SCM merge (do_numbers) fills the rest —
    // same precedence as the list's DO No column.
    r.delivery_order = r.delivery_order || r.do_numbers || null;
    lines.push(fields.map((f) => esc(r[f])).join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n");
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="service-cases-${date}.csv"`,
    },
  });
});

// ── SO item lookup ────────────────────────────────────────────

app.get("/lookup-items/:docNo", requireServiceCaseAccess(), async (c) => {
  const docNo = c.req.param("docNo");
  const items = await lookupSOItems(c.env, docNo);
  return c.json({ items });
});

// ── SO search (typeahead for create-case intake) ──────────────
// Returns up to 20 SO candidates matched by partial DocNo, reference
// number, customer name, or — SCM arm only — the linked AutoCount
// DocNo (case-insensitive).
//
// Company reach mirrors the ASSR read rule (assrCompanySql): every caller
// searches across their GRANTED companies — a rank-and-file rep sees only their
// own company's SOs, while managers / office / directors granted both see the
// combined HOUZS + 2990 set (2990 orders became attachable with the owner's
// 2026-07-20 "2990 加 service case"). Two sources, merged:
//   (1) public.sales_orders — the Houzs AutoCount mirror (no company_id; Houzs
//       only). Unchanged legacy behaviour.
//   (2) scm.mfg_sales_orders — the SCM-native SO table carrying both companies'
//       orders, filtered by assrCompanySql. This adds the 2990 orders (for the
//       cross-company portal) and Houzs SCM SOs that never reached the mirror.
// Deduped by doc_no (prefer the SCM row — it carries a company tag), newest
// first, capped at 20.
app.get("/search-so", requireServiceCaseAccess(), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ results: [] });
  const pattern = `%${q.toLowerCase()}%`;

  // (1) Houzs AutoCount mirror — legacy source. This table is HOUZS-only
  // (`'HOUZS' AS company_code` hardcoded below), so a caller whose allowed
  // company set does NOT include HOUZS must NOT see any rows from it.
  // Before this guard, a 2990-only rep (like a rank-and-file POS salesperson
  // opening a Service Case) could search "125" and see every matching HOUZS
  // AutoCount SO — bare `SO-XXXXXX` numbers with no `2990-` prefix — leaked
  // straight across the company boundary. (owner sighting 2026-07-22:
  // Scarlett Chong Kar Yin, sales_executive on co_2 only, saw HOUZS SOs.)
  // Aligned to the SCM-side scoping the block below already applies.
  //
  // `allowed === undefined` = company context unresolved (pre-migration /
  // legacy single-company); fall through to the existing behaviour so nothing
  // breaks in that mode. Empty set (RESTRICTED-TO-NOTHING) also skips.
  const houzsId = houzsCompanyId(c);
  const allowed = assrCompanyIds(c);
  const includesHouzs = allowed === undefined
    || (houzsId != null && allowed.includes(houzsId));
  const acRows = includesHouzs
    ? await c.env.DB.prepare(
        `SELECT doc_no, ref, debtor_name, phone, doc_date, sales_agent, 'HOUZS' AS company_code
           FROM sales_orders
          WHERE LOWER(doc_no) LIKE ?
             OR LOWER(COALESCE(ref, '')) LIKE ?
             OR LOWER(COALESCE(debtor_name, '')) LIKE ?
          ORDER BY doc_date DESC
          LIMIT 20`
      )
        .bind(pattern, pattern, pattern)
        .all()
    : { results: [] as Array<Record<string, unknown>> };

  // (2) SCM-native SOs. assrCompanySql pins rank-and-file SALES to HOUZS
  // (inlining the validated int id, or "" when unresolved -> degrades to all
  // rows, same as legacy single-company); office/backend/directors get their
  // allowed set. This is the fix that stops 2990 orders leaking into the
  // service-case SO picker for a both-company SALES user.
  const coFilter = assrCompanySql(c, "so.company_id");
  // Migrated/写回 orders keep their AutoCount number in linked_ac_docno (doc_no is the ERP one); customers quote it.
  const scmRows = await c.env.DB.prepare(
    `SELECT so.doc_no, so.ref, so.debtor_name, so.phone,
            so.so_date AS doc_date, so.agent AS sales_agent, co.code AS company_code
       FROM scm."mfg_sales_orders" so
       LEFT JOIN companies co ON co.id = so.company_id
      WHERE (LOWER(so.doc_no) LIKE ?
          OR LOWER(COALESCE(so.ref, '')) LIKE ?
          OR LOWER(COALESCE(so.debtor_name, '')) LIKE ?
          OR LOWER(COALESCE(so.linked_ac_docno, '')) LIKE ?)
        AND so.status <> 'DRAFT' AND so.status <> 'CANCELLED'${coFilter}
      ORDER BY so.so_date DESC
      LIMIT 20`
  )
    .bind(pattern, pattern, pattern, pattern)
    .all();

  // Merge: SCM rows first so a doc_no present in both keeps the company-tagged
  // SCM row; dedupe by doc_no; newest doc_date first; cap 20.
  const seen = new Set<string>();
  const merged = [
    ...((scmRows.results ?? []) as Array<Record<string, unknown>>),
    ...((acRows.results ?? []) as Array<Record<string, unknown>>),
  ]
    .filter((r) => {
      const k = String(r.doc_no ?? "");
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => String(b.doc_date ?? "").localeCompare(String(a.doc_date ?? "")))
    .slice(0, 20);

  // Existing-case annotation (owner 2026-07-27: "create case 的时候显示这个
  // order 有没有 create 过 Service case") — duplicate cases keep appearing
  // because intake staff can't see that an SO already has one. Stamp each
  // candidate with how many non-archived cases it already carries so the
  // picker can warn BEFORE the operator fills the whole form (the POST
  // duplicate guard only fires at submit, and only on exact item overlap).
  // LOWER() both sides: picker-selected doc_nos are exact, but hand-typed
  // ones (saved on blur) can differ in case. Company scope mirrors the
  // read rule — a caller never learns about cases outside their companies.
  if (merged.length) {
    const keys = merged.map((r) => String(r.doc_no).toLowerCase());
    const placeholders = keys.map(() => "?").join(",");
    try {
      const counts = await c.env.DB.prepare(
        `SELECT LOWER(doc_no) AS k,
                COUNT(*) AS case_count,
                SUM(CASE WHEN ${assrOpenStageSql()} THEN 1 ELSE 0 END) AS open_case_count
           FROM assr_cases
          WHERE archived_at IS NULL
            AND LOWER(doc_no) IN (${placeholders})${assrCompanySql(c, "company_id")}
          GROUP BY LOWER(doc_no)`
      )
        .bind(...keys)
        .all<{ k: string; case_count: number; open_case_count: number }>();
      const byKey = new Map(
        (counts.results ?? []).map((r) => [r.k, r] as const)
      );
      for (const r of merged) {
        const hit = byKey.get(String(r.doc_no).toLowerCase());
        r.case_count = Number(hit?.case_count ?? 0);
        r.open_case_count = Number(hit?.open_case_count ?? 0);
      }
    } catch (e) {
      console.warn("[assr.search-so] case-count annotation failed:", e);
    }
  }

  return c.json({ results: merged });
});

// ── Existing cases for an SO (create-intake duplicate warning) ─
// Once the operator picks (or types) an SO in the New Case form, the
// client calls this to show "this order already has N case(s)" with
// enough detail to recognise — and jump to — the existing case instead
// of opening a duplicate. Read-scoped like every other ASSR read:
// non-archived only, company-filtered. Case-insensitive on doc_no for
// the same hand-typed reason as the search-so annotation above.
app.get("/so-cases/:docNo", requireServiceCaseAccess(), async (c) => {
  const docNo = (c.req.param("docNo") ?? "").trim();
  if (!docNo) return c.json({ cases: [] });
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.assr_no, c.doc_no, c.stage, c.status, c.priority,
            c.complaint_issue, c.issue_category, c.complained_date,
            c.created_at, c.item_code, u.name AS created_by_name
       FROM assr_cases c
       LEFT JOIN users u ON u.id = c.created_by
      WHERE LOWER(c.doc_no) = ?
        AND c.archived_at IS NULL${assrCompanySql(c, "c.company_id")}
      ORDER BY c.id DESC
      LIMIT 10`
  )
    .bind(docNo.toLowerCase())
    .all();
  return c.json({ cases: rows.results ?? [] });
});

// ── Manual single-SO backfill into the local mirror ───────────
// The cron pull is incremental (getSince) AND content-filtered by the
// AutoCount middleware, so a doc can be absent from `sales_orders` even
// though it exists in AutoCount — e.g. one modified during a sync outage
// that never re-surfaced in an incremental batch (SO-011902 was one such
// gap: KL/WEST, passes routeRegion, filter-fields identical to synced
// neighbours). This fetches the doc directly via getSingle — which
// bypasses the getSince content filter — and upserts it through the SAME
// routeRegion path the cron uses, so the re-match typeahead can find it.
// Gated at service_cases.write: the same permission that PATCH (where the
// SO-No re-match lives) already requires.
app.post("/resync-so/:docNo", requirePermission("service_cases.write"), async (c) => {
  const docNo = (c.req.param("docNo") ?? "").trim();
  if (!docNo) return c.json({ error: "docNo required" }, 400);
  if (isAutoCountSyncDisabled(c.env)) {
    return c.json({ error: "AutoCount sync is disabled (AUTOCOUNT_SYNC_DISABLED)" }, 503);
  }

  let so;
  try {
    so = await new AutoCountClient(c.env).getSingle(docNo);
  } catch (e) {
    return c.json({ error: `AutoCount getSingle failed: ${String(e)}` }, 502);
  }
  if (!so) return c.json({ error: "SO not found in AutoCount", docNo }, 404);

  // Same skip rule the cron applies — an SO that doesn't route to a known
  // region is intentionally not mirrored, so report that explicitly rather
  // than silently dropping it.
  const region = routeRegion(so);
  if (!region) {
    return c.json(
      {
        error: "SO does not route to a known region (skipped by routeRegion)",
        docNo,
        salesLocation: so.SalesLocation ?? null,
        invAddr3: so.InvAddr3 ?? null,
      },
      422
    );
  }

  await upsertSalesOrder(c.env, so, region);
  // Read-back scope (owner audit 2026-07-22): dormant today because AutoCount
  // mirror rows are backfilled to HOUZS, but the moment a 2990-side AutoCount
  // mirror is added this becomes a cross-company read-back. Mirrors the
  // /search-so fix in PR #990.
  const row = await c.env.DB.prepare(
    `SELECT doc_no, ref, debtor_name, phone, doc_date, sales_agent, region
       FROM sales_orders
      WHERE LOWER(doc_no) = LOWER(?)${assrCompanySql(c)}`
  )
    .bind(so.DocNo)
    .first();
  return c.json({ ok: true, region, mirrored: row });
});

// ── My Cases (sales-side portal) ──────────────────────────────
// A case is YOURS if you RAISED it (created_by, self + downline BY ID — owner
// ruling 2026-08-21: submitting is claiming) OR if the legacy free-text
// `sales_agent` names someone in your reporting subtree. THE RULE and the
// measurement that says both arms have to stay live in
// services/assrVisibility.ts `myCasesPredicateSql` — this handler only resolves
// the per-REQUEST company predicate, which is the one thing a service cannot.
app.get("/my-cases", requireServiceCaseAccess(), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  if (!userId) return c.json({ cases: [] });
  return c.json(await listMyCases(c.env, Number(userId), assrCompanySql(c)));
});

// ── Sales comment ─────────────────────────────────────────────
// Sales rep posts a comment on a case they own (matched by
// sales_agent). Lands in assr_activity with source_channel=
// 'sales_portal' so the timeline distinguishes it from staff /
// customer / supplier notes.
app.post("/:id{[0-9]+}/sales-comment", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Scope guard — this append-only write must be limited to cases the caller
  // may see (self + downline; directors/admins unrestricted). Out-of-scope →
  // 404, indistinguishable from a nonexistent id (mirrors the detail GET).
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const text = (body.text || "").trim();
  if (!text) return c.json({ error: "Comment cannot be empty" }, 400);
  if (text.length > 2000) return c.json({ error: "Comment is too long" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel, user_id)
     VALUES (?, 'sales_comment', ?, 'system', 'sales_portal', ?)`
  )
    .bind(id, text, userId || null)
    .run();
  return c.json({ ok: true }, 201);
});

// ── Sales nudge ───────────────────────────────────────────────
// One-tap "poke the office" from the sales portal — the rep can't
// dispatch or reassign but they can flag that the customer is on
// their case, so ops treats the row as fresh. Rate-limited to one
// nudge per hour per case so it stays useful (spam ≠ signal).
app.post("/:id{[0-9]+}/sales-nudge", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Scope guard — same as sales-comment: only nudge cases the caller may see.
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const note = (body.text || "").trim().slice(0, 500) || "Sales rep is asking for an update.";
  const cutoffIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await c.env.DB.prepare(
    `SELECT id FROM assr_activity
      WHERE assr_id = ?
        AND action = 'sales_nudge'
        AND source_channel = 'sales_portal'
        AND created_at > ?
      LIMIT 1`
  )
    .bind(id, cutoffIso)
    .first<{ id: number }>();
  if (recent?.id) {
    return c.json({ error: "Ops was already nudged for this case within the last hour." }, 429);
  }
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel, user_id)
     VALUES (?, 'sales_nudge', ?, 'system', 'sales_portal', ?)`
  )
    .bind(id, note, userId || null)
    .run();
  return c.json({ ok: true }, 201);
});

// ── Detail ────────────────────────────────────────────────────

// Numeric-only guard on the catch-all detail route. Hono's
// RegExpRouter is order-sensitive — declaring `/:id` before
// `/metrics` lets `/:id` swallow `GET /api/assr/metrics` because
// "metrics" matches the param. The `{[0-9]+}` constraint scopes the
// param to digits so /metrics + any future literal route under
// /api/assr falls through to its dedicated handler.
app.get("/:id{[0-9]+}", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.json({ error: "Not found" }, 404);
  /* Multi-company: a case must fall inside the caller's ASSR company scope
     (same rule as the list). Rank-and-file SALES are pinned to HOUZS; office /
     backend / directors get their allowed set. A case tagged with a company
     outside that scope (e.g. one wrongly stamped 2990 before the Houzs pin
     shipped, viewed by a sales rep) answers 404 here too. Out-of-scope answers
     404, indistinguishable from a nonexistent id.
     Skipped only when the scope is UNRESOLVED (undefined — pre-migration / D1
     test mirror). An EMPTY scope is not the same thing: it means the caller is
     granted no active company, and every company-stamped case must 404. Those
     two states used to share `[]` and the merged state failed open. */
  const allowedCo = assrCompanyIds(c);
  if (allowedCo) {
    const caseRow = (detail as { case?: Record<string, unknown> }).case ?? {};
    const caseCo = Number(
      (caseRow as any).companyId ?? (caseRow as any).company_id ?? NaN,
    );
    if (Number.isFinite(caseCo) && !allowedCo.includes(caseCo)) {
      return c.json({ error: "Not found" }, 404);
    }
  }
  /* Row-level visibility — same rule as the list: a scoped caller may open
     only cases created by / assigned to them or their downline. Out-of-scope
     answers 404, indistinguishable from a nonexistent id (mirrors the SCM SO
     detail behavior). Dual-read camelCase ?? snake_case — the PG driver
     camelCases result columns. */
  const visibleIds = await assrVisibleUserIds(c);
  {
    const row = (detail as { case?: Record<string, any> }).case ?? (detail as Record<string, any>);
    if (!(await assrCaseRowInScope(c as any, row))) return c.json({ error: "Not found" }, 404);
  }
  /* Supplier identity is office + supplier-portal only — see
     stripCreditorFields above. */
  if (visibleIds !== undefined) {
    stripCreditorFields((detail as { case?: Record<string, any> }).case);
  }
  return c.json(detail);
});

// ── Supplier rating ──────────────────────────────────────────
// Posted from the Close-Case prompt when the case had a supplier
// assigned. Stored on the case row (one rating per case) and
// stamped with the rater + timestamp for audit. Re-posting the
// same case overwrites — staff can correct a misclick.

// ── Customer history ──────────────────────────────────────────
// Returns prior cases for the same customer (matched on phone if
// present, otherwise on exact name) so staff can spot repeat
// complaints. Excludes the current case and archived rows.

app.get("/:id/customer-history", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Column is `phone`, not `customer_phone` — pre-v3.1 naming kept for
  // SQL compatibility. Same applies to the WHERE below.
  const cur = await c.env.DB.prepare(
    `SELECT customer_name, phone FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ customer_name: string | null; phone: string | null }>();
  if (!cur) return c.json({ error: "Not found" }, 404);
  /* Go-live review #11 — same fix as /cost-suggestion: admit a scoped Sales
     viewer of this case (requireServiceCaseAccess + case-in-scope) instead of
     403-ing on the raw service_cases.read permission. */
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);

  const phone = (cur.phone || "").trim();
  const name = (cur.customer_name || "").trim();
  if (!phone && !name) return c.json({ cases: [] });

  const where: string[] = ["c.id != ?", "c.archived_at IS NULL"];
  const binds: any[] = [id];
  if (phone) {
    where.push("c.phone = ?");
    binds.push(phone);
  } else {
    where.push("c.customer_name = ?");
    binds.push(name);
  }
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.assr_no, c.doc_no, c.stage, c.status, c.priority,
            c.complaint_issue, c.complained_date, c.created_at, c.item_code,
            c.resolution_method
       FROM assr_cases c
      WHERE ${where.join(" AND ")}${assrCompanySql(c, "c.company_id")}
      ORDER BY c.id DESC
      LIMIT 25`
  )
    .bind(...binds)
    .all();
  return c.json({ cases: rows.results ?? [] });
});

// ── Create ────────────────────────────────────────────────────

app.post(
  "/",
  // Owner rule 8: Sales may CREATE cases too. Widen the existing create/write/
  // manage gate to also admit Sales / director (canAccessServiceCases). The new
  // case is stamped created_by = caller, so the creator owns it and the
  // self+downline data scope (rule 9) lets them see it afterwards.
  requireServiceCaseAccess([
    "service_cases.create",
    "service_cases.write",
    "service_cases.manage",
  ]),
  async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    doc_no: string;
    items?: { item_code: string; item_description?: string; qty?: number }[];
    item_code?: string;
    complaint_issue: string;
    issue_category?: string | null;
    priority?: string | null;
    complained_date?: string | null;
    ref_no?: string | null;
    customer_email?: string | null;
    service_category?: string | string[] | null;
    assigned_to?: number | null;
  }>();

  // Owner ruling (2026-07): Issue Category is REQUIRED and must be enforced
  // server-side, not only by the FE button gate — the server previously
  // accepted a null/blank category. Treat whitespace-only as missing.
  const hasCategory =
    typeof body.issue_category === "string" && body.issue_category.trim().length > 0;
  if (!body.doc_no || !body.complaint_issue || !hasCategory) {
    return c.json(
      { error: "doc_no, complaint_issue and issue_category are required" },
      400,
    );
  }

  // Support both old format (item_code string) and new (items array).
  //
  // Owner audit 2026-07-22 — items[] MAY be empty. A Service Case is not
  // necessarily about a defective product: a driver damaged the customer's
  // floor, a lorry problem left the delivery incomplete, etc. Those cases
  // legitimately have no item_code, and the previous 400 "At least one item
  // is required" forced staff to invent a fake code just to submit.
  const items = body.items?.length
    ? body.items
    : body.item_code
    ? [{ item_code: body.item_code }]
    : [];

  // Duplicate-open-case guard (owner audit 2026-07-22). If ANY of the items
  // being submitted is already attached to a still-OPEN case on the same SO
  // (any stage that isn't 'completed' or archived), refuse with a payload the
  // caller can turn into a friendly "Case #XXX is already open on this item"
  // dialog. Office and sales often opened parallel cases on the same fault
  // because neither saw the other's; this makes the DB the arbiter, not luck.
  //
  // No-item cases (see block above) can't collide by item_code, so they skip
  // this check — a floor-damage / lorry-issue case has no product signature
  // to conflict on. Coordinators can still dedupe those manually.
  if (items.length) {
    const codes = Array.from(new Set(
      items.map((it) => (it.item_code ?? "").trim()).filter((s) => s.length > 0),
    ));
    if (codes.length) {
      const placeholders = codes.map(() => "?").join(",");
      const dup = await c.env.DB.prepare(
        `SELECT c.id, c.doc_no, c.stage, c.customer_name, c.created_at, i.item_code
           FROM assr_cases c
           JOIN assr_items i ON i.assr_id = c.id
          WHERE c.archived_at IS NULL
            AND ${assrOpenStageSql("c")}
            AND c.doc_no = ?
            AND i.item_code IN (${placeholders})${assrCompanySql(c, "c.company_id")}`,
      )
        .bind(body.doc_no, ...codes)
        .all<{ id: number; doc_no: string; stage: string | null; customer_name: string | null; created_at: string | null; item_code: string }>();
      const rows = dup.results ?? [];
      if (rows.length) {
        // Group by case id so a single case that spans several ticked items
        // shows once with its items[] rather than N repeated rows.
        const byCase = new Map<number, {
          id: number; docNo: string; stage: string | null;
          customerName: string | null; createdAt: string | null; items: string[];
        }>();
        for (const r of rows) {
          const cur = byCase.get(r.id);
          if (cur) { if (!cur.items.includes(r.item_code)) cur.items.push(r.item_code); }
          else byCase.set(r.id, {
            id: r.id, docNo: r.doc_no, stage: r.stage,
            customerName: r.customer_name, createdAt: r.created_at,
            items: [r.item_code],
          });
        }
        const existing = [...byCase.values()];
        return c.json({
          error: "duplicate_open_case",
          message: existing.length === 1
            ? `Case #${existing[0]!.id} is already open on this SO for ${existing[0]!.items.join(", ")}. Please add to that case instead of opening a new one.`
            : `${existing.length} cases are already open on this SO for the item(s) you selected. Please add to one of them instead of opening a new one.`,
          existing,
        }, 409);
      }
    }
  }

  // Normalise the intake extras: trim strings to null, coerce the
  // assignee to a valid positive integer or null. Null-safe so the
  // existing minimal create flow (no extras) is unaffected.
  const trimOrNull = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length ? t : null;
  };
  let assignedTo: number | null = null;
  if (body.assigned_to != null) {
    const n =
      typeof body.assigned_to === "number"
        ? body.assigned_to
        : parseInt(String(body.assigned_to), 10);
    if (Number.isFinite(n) && n > 0) assignedTo = n;
  }

  const result = await createAssrCase(c.env, {
    doc_no: body.doc_no,
    items,
    complaint_issue: body.complaint_issue,
    issue_category: body.issue_category ?? null,
    priority: body.priority ?? null,
    complained_date: trimOrNull(body.complained_date),
    ref_no: trimOrNull(body.ref_no),
    customer_email: trimOrNull(body.customer_email),
    // Multi-select: pass an array straight through (createAssrCase resolves
    // it against the lookup); trim only the legacy single-string form.
    service_category: Array.isArray(body.service_category)
      ? body.service_category
      : trimOrNull(body.service_category),
    assigned_to: assignedTo,
    created_by: userId,
    // Owner 2026-07-20: 2990 raises Service Cases on the merged platform too.
    // The case's company = the SO's own company when the doc resolves to a
    // local scm SO (createAssrCase override); else the switcher's active
    // company (assrCreateCompanyId). Undefined pre-migration / cold-start ->
    // createAssrCase falls back to the Houzs default, else omits the column
    // (single-company safe).
    company_id: assrCreateCompanyId(c),
  });

  // Notify the responsible person(s) + their recursive upline that a new case
  // landed (owner 2026-07-15). createAssrCase resolves the effective assignees
  // (explicit or the admin defaults) and mirrors the SO's sales_agent, so read
  // the committed row back for the actual values. Best-effort: notify never
  // throws, and it is awaited so it can't be dropped by isolate suspension —
  // it adds only one small insert. A raw env.DB read returns snake_case.
  try {
    const row = await c.env.DB.prepare(
      `SELECT assigned_to, assigned_to_2, sales_agent, customer_name, created_by
         FROM assr_cases WHERE id = ?`,
    )
      .bind(result.id)
      .first<{
        assigned_to: number | null;
        assigned_to_2: number | null;
        sales_agent: string | null;
        customer_name: string | null;
        created_by: number | null;
      }>();
    if (row) {
      // Notify the CREATOR too (owner 2026-07-16): the salesperson who opened
      // the case should hear that it landed. The notify service de-dupes +
      // expands upline, so adding created_by is safe even when the creator is
      // also an assignee.
      await notifyServiceCaseResponsible(c.env, {
        reason: "created",
        assrNo: result.assr_no,
        customerName: row.customer_name,
        userIds: [row.assigned_to, row.assigned_to_2, row.created_by],
        agentNames: [row.sales_agent],
      });
    }
  } catch (e) {
    console.error("[assr.create] notify failed:", (e as Error).message);
  }

  return c.json(result, 201);
});

// ── Patch ─────────────────────────────────────────────────────

// Same digit-only constraint as the GET — keeps any future literal
// route under /api/assr (e.g. /metrics, /summary) reachable when the
// methods overlap.
const SUB_STATUS_VALUES = new Set([
  "pending_inspection",
  "qc_issue_result",
  "pending_supplier_pickup",
  "pending_supplier_return",
]);

app.patch("/:id{[0-9]+}", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<Record<string, any>>();
  if (
    body.sub_status !== undefined &&
    body.sub_status !== null &&
    !SUB_STATUS_VALUES.has(String(body.sub_status))
  ) {
    return c.json({ error: "Unknown sub-status" }, 400);
  }
  // Snapshot the responsible fields BEFORE the patch so we notify only on an
  // ACTUAL change (owner 2026-07-15). A doc_no re-match inside patchAssrCase can
  // also rewrite sales_agent, so we compare committed before/after values
  // rather than trusting which keys the caller sent. Raw env.DB read is
  // snake_case (D1-compat shim).
  const before = await c.env.DB.prepare(
    `SELECT assigned_to, assigned_to_2, sales_agent FROM assr_cases WHERE id = ?`,
  )
    .bind(id)
    .first<{ assigned_to: number | null; assigned_to_2: number | null; sales_agent: string | null }>();

  const ok = await patchAssrCase(c.env, id, body, userId);
  if (!ok) return c.json({ error: "Not found or no changes" }, 404);

  // Notify newly-responsible people (+ their recursive upline) when an assignee
  // or the sales_agent changed. Best-effort: never fails the PATCH.
  try {
    const after = await c.env.DB.prepare(
      `SELECT assigned_to, assigned_to_2, sales_agent, customer_name, assr_no
         FROM assr_cases WHERE id = ?`,
    )
      .bind(id)
      .first<{
        assigned_to: number | null;
        assigned_to_2: number | null;
        sales_agent: string | null;
        customer_name: string | null;
        assr_no: string | null;
      }>();
    if (after && before) {
      const changedUserIds: number[] = [];
      // Only a change TO a non-null assignee is worth a notice (un-assignment
      // has no new person to tell). NaN != NaN would false-positive when both
      // are null, but the `!= null` guard suppresses that case.
      if (
        after.assigned_to != null &&
        Number(after.assigned_to) !== Number(before.assigned_to ?? NaN)
      ) {
        changedUserIds.push(Number(after.assigned_to));
      }
      if (
        after.assigned_to_2 != null &&
        Number(after.assigned_to_2) !== Number(before.assigned_to_2 ?? NaN)
      ) {
        changedUserIds.push(Number(after.assigned_to_2));
      }
      const changedAgents: string[] = [];
      const beforeAgent = (before.sales_agent ?? "").trim().toLowerCase();
      const afterAgent = (after.sales_agent ?? "").trim();
      if (afterAgent && afterAgent.toLowerCase() !== beforeAgent) {
        changedAgents.push(afterAgent);
      }
      if (changedUserIds.length || changedAgents.length) {
        await notifyServiceCaseResponsible(c.env, {
          reason: "reassigned",
          assrNo: after.assr_no,
          customerName: after.customer_name,
          userIds: changedUserIds,
          agentNames: changedAgents,
        });
      }
    }
  } catch (e) {
    console.error("[assr.patch] notify failed:", (e as Error).message);
  }

  return c.json({ ok: true });
});

// ── Mark opened by Service Admin ──────────────────────────────
// Frontend fires this when the detail page mounts. Server checks
// the case is still at pending_review; if so it auto-advances to
// under_verification and stamps the activity log. Requires write
// permission so a read-only viewer opening the case doesn't kick
// the stage — Sales sees pending_review, SA opening it advances.
app.post("/:id{[0-9]+}/mark-opened", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const advanced = await markCaseOpened(c.env, id, userId);
  return c.json({ advanced });
});

// ── Generate a staff-sourced portal tracking link ─────────────
// Dispatcher clicks "Copy portal link" — returns a token that the
// frontend turns into a full URL, then copied into WhatsApp.
//
// This said "30-day TTL so the customer can reopen it over the life of
// the case" until 2026-07-17. It was true when written (mig 017 minted
// staff tokens with a 30-day expiry) and was superseded by mig 0076 /
// D1 113: Nick 2026-07-07 ruled that shared WhatsApp links must keep
// working forever, and that migration extended every existing token to
// PERMANENT_EXPIRES_AT. The comment outlived the behaviour it
// described and kept promising a bound this endpoint no longer had, on
// the surface whose only protection is the token. Links are permanent
// by design; DELETE /:id/track-link below is what ends one.
app.post("/:id/track-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueStaffToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

// ── Sales portal link ─────────────────────────────────────────
// Same per-case portal as the customer link but source='sales' —
// the portal shows the salesperson variant (full stage progress,
// comments attributed to sales). Idempotent per case.
app.post("/:id/sales-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueSalesToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

// ── Revoke every portal link for a case ───────────────────────
//
// The counterpart to the two issuers above. Portal links are permanent
// by ruling (see the track-link comment), which is right up until one
// is forwarded to the wrong WhatsApp group -- before this the only
// remedy was hand-editing case_track_tokens. Kills staff + sales + any
// live 30-min customer session for the case; re-clicking Generate
// mints a fresh link, so this doubles as rotation.
//
// Gated on service_cases.write, matching the issuers: anyone who can
// hand out a link can take it back. A stricter gate would mean the
// dispatcher who leaked it cannot contain it without escalating.
app.delete("/:id/track-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  /* COMPANY SCOPE — this existence check is the ONLY gate on revokeCaseTokens
     below, so unscoped it let one company kill the other company's customer
     tracking links. Same fix and same discovery as POST /:id/approve. */
  const revokeCoSql = assrCompanySql(c);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?${revokeCoSql}`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  await revokeCaseTokens(c.env, id);
  // Revoking access to an unauthenticated surface is a security event:
  // it belongs in the case timeline, not just a server log. category
  // 'system' keeps it off the portal -- of the buckets (mig 121) only
  // 'customer' renders there, and a revocation record is the last
  // thing that should be readable through the link it just killed.
  const userId = (c as any).get?.("userId") ?? null;
  await logActivity(
    c.env,
    id,
    "portal_links_revoked",
    null,
    null,
    "Portal links revoked — previously shared links no longer open this case.",
    userId,
    "system",
  );
  return c.json({ ok: true });
});

// ── Supplier portal link (v3.1) ───────────────────────────────
//
// Idempotent: re-clicking the button returns the existing active
// token. Scoped to the case's resolved creditor_code so the supplier
// only sees jobs assigned to them.

app.post("/:id/supplier-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, creditor_code FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; creditor_code: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const { issueSupplierToken } = await import("../services/supplierPortal");
  const token = await issueSupplierToken(c.env, id, row.creditor_code);
  return c.json({ token, path: `/portal/supplier/${token}` }, 201);
});

// ── Revoke the supplier portal links for a case ───────────────
//
// The counterpart to the issuer above, and what finally makes
// resolveSupplierToken's revoked_at check reachable — it had no caller
// since the portal shipped, so a supplier link could only end by
// hitting its 30-day TTL. Needed most when a case is re-assigned: the
// previous supplier's token stays valid otherwise.
app.delete("/:id/supplier-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  /* COMPANY SCOPE — same shape as DELETE /:id/track-link above: this read is
     the only gate on revokeSupplierTokensForCase. */
  const revokeCoSql = assrCompanySql(c);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?${revokeCoSql}`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const { revokeSupplierTokensForCase } = await import("../services/supplierPortal");
  await revokeSupplierTokensForCase(c.env, id);
  const userId = (c as any).get?.("userId") ?? null;
  await logActivity(
    c.env,
    id,
    "supplier_links_revoked",
    null,
    null,
    "Supplier portal links revoked — previously shared links no longer open this case.",
    userId,
    "system",
  );
  return c.json({ ok: true });
});

// ── Generate satisfaction survey token ────────────────────────

app.post("/:id/survey-token", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const token = await issueSurveyToken(c.env, id);
  return c.json({ token });
});

// ── Soft-delete (archive) endpoints ───────────────────────────
// No rows are ever physically deleted. Archive stamps archived_at +
// archived_by; restore clears them. Default queries skip archived
// rows so the UI is clean without losing data or audit trail.

async function setArchived(
  env: Env,
  table: string,
  where: string,
  binds: any[],
  userId: number | null,
  archive: boolean
): Promise<boolean> {
  const r = await env.DB.prepare(
    archive
      ? `UPDATE ${table}
            SET archived_at = datetime('now'),
                archived_by = ?
          WHERE ${where} AND archived_at IS NULL`
      : `UPDATE ${table}
            SET archived_at = NULL,
                archived_by = NULL
          WHERE ${where} AND archived_at IS NOT NULL`
  )
    .bind(...(archive ? [userId, ...binds] : binds))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// Case — archive/unarchive. Manager-level (service_cases.manage).
// No predicate here BY DESIGN: the path is /<numeric id>/archive, so
// enforceCaseScope has already run caseInCallerScope — company AND row scope.
app.post("/:id/archive", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(c.env, "assr_cases", "id = ?", [id], userId || null, true);
  if (!ok) return c.json({ error: "Not found or already archived" }, 404);
  await logActivity(c.env, id, "archived", null, null, null, userId || null);
  return c.json({ ok: true });
});

app.post("/:id/unarchive", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(c.env, "assr_cases", "id = ?", [id], userId || null, false);
  if (!ok) return c.json({ error: "Not found or not archived" }, 404);
  await logActivity(c.env, id, "unarchived", null, null, null, userId || null);
  return c.json({ ok: true });
});

// Logistics entry archive.
app.post("/:id/logistics/:logId/archive", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const logId = parseInt(c.req.param("logId"), 10);
  if (isNaN(id) || isNaN(logId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(
    c.env,
    "assr_logistics",
    "id = ? AND assr_id = ?",
    [logId, id],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Attachment archive — hard replacement for the old "delete" wish.
app.post("/attachments/:attId/archive", requireAnyPermission(["service_cases.write", "service_cases.manage"]), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  // Resolve the owning case + file so the removal is recorded on the right
  // timeline (append-only — the record survives the file being archived).
  const att = await c.env.DB.prepare(
    `SELECT assr_id, category, file_name FROM assr_attachments WHERE id = ?`
  )
    .bind(attId)
    .first<{ assr_id: number | null; category: string | null; file_name: string | null }>();
  const ok = await setArchived(
    c.env,
    "assr_attachments",
    "id = ?",
    [attId],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  if (att?.assr_id != null) {
    await logActivity(
      c.env,
      att.assr_id,
      "attachment_removed",
      att.file_name ?? null,
      null,
      `Removed ${att.category ?? "attachment"}${att.file_name ? ` (${att.file_name})` : ""}`,
      userId || null,
      { category: "service", source_channel: "app" }
    );
  }
  return c.json({ ok: true });
});

// Activity archive — only non-system actions (notes, customer and
// sales comments). Stage transitions, created, approval, po_generated,
// escalated, survey_submitted are all part of the audit trail and
// must not be archive-able.
const ARCHIVABLE_ACTIONS = new Set(["note", "customer_comment", "sales_comment"]);

app.post("/activity/:actId/archive", requirePermission("service_cases.write"), async (c) => {
  const actId = parseInt(c.req.param("actId"), 10);
  if (isNaN(actId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const row = await c.env.DB.prepare(
    `SELECT action FROM assr_activity WHERE id = ?`
  )
    .bind(actId)
    .first<{ action: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!ARCHIVABLE_ACTIONS.has(row.action)) {
    return c.json({ error: "This activity entry is part of the audit trail and cannot be archived" }, 403);
  }

  const ok = await setArchived(
    c.env,
    "assr_activity",
    "id = ?",
    [actId],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Toggle an attachment's visibility to the portal customer ──
// Lets staff hide an internal photo so it doesn't show up on the
// customer's portal view of the case.
app.patch("/attachments/:attId/visibility", requirePermission("service_cases.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req
    .json<{ visible_to_customer?: boolean }>()
    .catch(() => ({} as { visible_to_customer?: boolean }));
  if (typeof body.visible_to_customer !== "boolean") {
    return c.json({ error: "Please choose whether this is visible to the customer." }, 400);
  }
  const r = await c.env.DB.prepare(
    `UPDATE assr_attachments SET visible_to_customer = ? WHERE id = ?`
  )
    .bind(body.visible_to_customer ? 1 : 0, attId)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Manual SLA escalation sweep ───────────────────────────────

app.post("/run-escalation", requirePermission("service_cases.manage"), async (c) => {
  const result = await runSlaEscalation(c.env);
  return c.json(result);
});

// ── Quality metrics (for manager dashboard) ───────────────────

app.get("/metrics", requirePermission("service_cases.read"), async (c) => {
  const sinceDays = Math.min(730, Math.max(1, parseInt(c.req.query("since_days") || "90", 10) || 90));
  // Period filter falls back to created_at when complained_date is
  // NULL — legacy rows + manual SQL inserts often skipped the intake
  // date, so a strict `complained_date >= …` was silently excluding
  // them from EVERY window (which makes 30d / 90d / 365d look identical
  // because the same too-small subset survives the filter).
  const sinceFor = (prefix = "") =>
    `AND COALESCE(${prefix}complained_date, ${prefix}created_at) >= date('now', '-${sinceDays} days')`;
  const sinceClause = sinceFor();
  // Allowed-companies predicates per table alias ("" when unresolved).
  const coBare = assrCompanySql(c);
  const coC = assrCompanySql(c, "c.company_id");
  const coA = assrCompanySql(c, "a.company_id");
  // Row-level visibility, per alias — the SAME scope the list applies. The
  // repeat_customers roll-up below is the reason this is not cosmetic: it
  // ships customer_name + phone, so an unscoped GROUP BY handed a caller the
  // contact details of cases outside their reporting chain.
  const vis = await assrVisibilityScope(c);
  const visBare = vis("assr_cases.");
  const visC = vis("c.");
  const visA = vis("a.");

  // Headline numbers. avg_resolution_hours filters out legacy rows
  // where julianday(closed_at) <= julianday(created_at) (corrupt
  // timestamps from old imports) OR the diff exceeds 1 year — a
  // healthy ASSR case never takes that long, so it's almost certainly
  // a data anomaly skewing the mean.
  const headline = await c.env.DB.prepare(
    `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN stage = 'completed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN ${assrOpenStageSql()} THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN ${assrOpenStageSql()} AND deadline_at IS NOT NULL
                  AND datetime('now') > deadline_at THEN 1 ELSE 0 END) as breached,
        SUM(CASE WHEN quality_review_passed = 1 THEN 1 ELSE 0 END) as qa_passed,
        AVG(CASE WHEN stage = 'completed' AND closed_at IS NOT NULL
                  AND julianday(closed_at) > julianday(created_at)
                  AND (julianday(closed_at) - julianday(created_at)) < 365
                  THEN (julianday(closed_at) - julianday(created_at)) * 24
                  END) as avg_resolution_hours,
        AVG(CASE WHEN satisfaction_rating IS NOT NULL THEN satisfaction_rating END) as avg_satisfaction
      FROM assr_cases
     WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}`
  )
    .bind(...visBare.binds)
    .first();

  // NCR category breakdown — engineering taxonomy (material_defect /
  // workmanship / transit_damage / …). Used for quality root-cause
  // analysis. Distinct from `issue_category` below, which is the
  // customer-facing category captured at intake.
  const ncr = await c.env.DB.prepare(
    `SELECT COALESCE(ncr_category, 'unclassified') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}
      GROUP BY ncr_category
      ORDER BY count DESC`
  )
    .bind(...visBare.binds)
    .all();

  // Customer-facing issue category — what the dashboards in the legacy
  // Excel called "Service issues category". One row per ISSUE_CATEGORIES
  // value (Product defect / Incorrect item delivered / etc.) plus an
  // "Other" bucket for anything else.
  const issueCategories = await c.env.DB.prepare(
    `SELECT COALESCE(issue_category, 'Other') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}
      GROUP BY issue_category
      ORDER BY count DESC`
  )
    .bind(...visBare.binds)
    .all();

  // Case Duration buckets — mirrors the legacy Excel "Case Duration"
  // tile. All counts are *open* cases (${assrOpenStageSql()}) bucketed by
  // age since complaint date. The buckets are non-overlapping so the
  // sum + still-younger-than-2wks == opening_count.
  //
  // avg_per_month is the rolling monthly intake over the last 4 months
  // (matching the Excel formula `monthly_case/month (last 4 month data)`).
  const caseDuration = await c.env.DB.prepare(
    `SELECT
        SUM(CASE WHEN ${assrOpenStageSql()} THEN 1 ELSE 0 END) AS opening_count,
        SUM(CASE WHEN ${assrOpenStageSql()}
                  AND complained_date IS NOT NULL
                  AND julianday('now') - julianday(complained_date) >= 30
                 THEN 1 ELSE 0 END) AS over_1_month,
        SUM(CASE WHEN ${assrOpenStageSql()}
                  AND complained_date IS NOT NULL
                  AND julianday('now') - julianday(complained_date) >= 21
                  AND julianday('now') - julianday(complained_date) < 30
                 THEN 1 ELSE 0 END) AS over_3_weeks,
        SUM(CASE WHEN ${assrOpenStageSql()}
                  AND complained_date IS NOT NULL
                  AND julianday('now') - julianday(complained_date) >= 14
                  AND julianday('now') - julianday(complained_date) < 21
                 THEN 1 ELSE 0 END) AS over_2_weeks
       FROM assr_cases
      WHERE 1=1${coBare}${visBare.sql}`
  )
    .bind(...visBare.binds)
    .first<{
      opening_count: number;
      over_1_month: number;
      over_3_weeks: number;
      over_2_weeks: number;
    }>();

  const avgPerMonth = await c.env.DB.prepare(
    `SELECT CAST(COUNT(*) AS REAL) / 4.0 AS avg_per_month
       FROM assr_cases
      WHERE COALESCE(complained_date, created_at) >= date('now', '-4 months')${coBare}${visBare.sql}`
  )
    .bind(...visBare.binds)
    .first<{ avg_per_month: number | null }>();

  // Resolution method mix
  const resolutions = await c.env.DB.prepare(
    `SELECT COALESCE(resolution_method, 'unset') as method, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}
      GROUP BY resolution_method
      ORDER BY count DESC`
  )
    .bind(...visBare.binds)
    .all();

  // Repeat offenders — items with >= 2 cases in window
  const repeatItems = await c.env.DB.prepare(
    `SELECT i.item_code,
            COUNT(DISTINCT i.assr_id) as cases,
            MAX(c.complained_date) as latest
       FROM assr_items i
       JOIN assr_cases c ON c.id = i.assr_id
      WHERE 1=1 ${sinceFor("c.")}${coC}${visC.sql}
      GROUP BY i.item_code
      HAVING COUNT(DISTINCT i.assr_id) >= 2
      ORDER BY cases DESC, latest DESC
      LIMIT 20`
  )
    .bind(...visC.binds)
    .all();

  // Repeat customers — customers with >= 2 cases in window
  const repeatCustomers = await c.env.DB.prepare(
    `SELECT customer_name, phone,
            COUNT(*) as cases,
            MAX(complained_date) as latest
       FROM assr_cases
      WHERE customer_name IS NOT NULL
        ${sinceClause}${coBare}${visBare.sql}
      GROUP BY customer_name, phone
      HAVING COUNT(*) >= 2
      ORDER BY cases DESC, latest DESC
      LIMIT 20`
  )
    .bind(...visBare.binds)
    .all();

  // Creditor performance (within window). Joined against the
  // creditors mirror via a.creditor_code rather than the old
  // suppliers table — creditor is now the source of truth.
  const creditorPerf = await c.env.DB.prepare(
    `SELECT a.creditor_code as creditor_code,
            cr.company_name as name,
            COUNT(DISTINCT a.id) as total_cases,
            SUM(CASE WHEN a.stage = 'completed' THEN 1 ELSE 0 END) as closed_cases,
            SUM(CASE WHEN ${assrOpenStageSql("a")} AND a.deadline_at IS NOT NULL
                      AND datetime('now') > a.deadline_at THEN 1 ELSE 0 END) as breached,
            AVG(CASE WHEN a.satisfaction_rating IS NOT NULL
                      THEN a.satisfaction_rating END) as avg_rating,
            AVG(CASE WHEN a.stage = 'completed' AND a.closed_at IS NOT NULL
                      AND julianday(a.closed_at) > julianday(a.created_at)
                      AND (julianday(a.closed_at) - julianday(a.created_at)) < 365
                      THEN (julianday(a.closed_at) - julianday(a.created_at)) * 24
                      END) as avg_resolution_hours
       FROM assr_cases a
       LEFT JOIN creditors cr ON cr.creditor_code = a.creditor_code
      WHERE a.creditor_code IS NOT NULL
        ${sinceFor("a.")}${coA}${visA.sql}
      GROUP BY a.creditor_code, cr.company_name
      ORDER BY total_cases DESC
      LIMIT 15`
  )
    .bind(...visA.binds)
    .all();

  // Monthly trend (last 12 months of case opens). Use complained_date
  // when populated, fall back to created_at — legacy rows imported
  // before the intake form required complained_date have it NULL, and
  // excluding them left the chart blank for tenants whose oldest data
  // predated the form change. strftime returns NULL on bad inputs;
  // HAVING strips those rows so the chart never receives a NULL month.
  const trend = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', COALESCE(complained_date, created_at)) as month,
            COUNT(*) as opened,
            SUM(CASE WHEN stage = 'completed' THEN 1 ELSE 0 END) as closed
       FROM assr_cases
      WHERE COALESCE(complained_date, created_at) >= date('now', '-12 months')${coBare}${visBare.sql}
      GROUP BY month
      HAVING strftime('%Y-%m', COALESCE(complained_date, created_at)) IS NOT NULL
      ORDER BY month`
  )
    .bind(...visBare.binds)
    .all();

  return c.json({
    since_days: sinceDays,
    headline,
    ncr: ncr.results ?? [],
    issue_categories: issueCategories.results ?? [],
    resolutions: resolutions.results ?? [],
    repeat_items: repeatItems.results ?? [],
    repeat_customers: repeatCustomers.results ?? [],
    creditor_performance: creditorPerf.results ?? [],
    monthly_trend: trend.results ?? [],
    case_duration: {
      opening_count: caseDuration?.opening_count ?? 0,
      over_1_month: caseDuration?.over_1_month ?? 0,
      over_3_weeks: caseDuration?.over_3_weeks ?? 0,
      over_2_weeks: caseDuration?.over_2_weeks ?? 0,
      avg_per_month: avgPerMonth?.avg_per_month ?? null,
    },
  });
});

// ── Metric drill-down ─────────────────────────────────────────
//
// Returns the case list behind a single ServiceMetrics card. The
// frontend just passes which card was clicked (`metric=`) plus the
// active period window (`since_days=`, matching the dashboard's
// FilterPills) and the route resolves both into a WHERE clause.
//
// Response shape is slim — only what the side-panel rows render. The
// case detail page is fetched separately when the user clicks through.

const DRILL_METRICS = new Set([
  "pending_review",
  "aging",
  "breach_now",
  "open_now",
  "total_period",
  "closed_period",
  "breach_period",
  "qa_passed",
  "over_1_month",
  "over_3_weeks",
  "over_2_weeks",
  "opening_count",
  "customer_cases",
  "item_cases",
] as const);

app.get("/metrics/drill", requirePermission("service_cases.read"), async (c) => {
  const metric = (c.req.query("metric") || "").trim();
  if (!DRILL_METRICS.has(metric as any)) {
    return c.json({ error: `Unknown metric: ${metric}` }, 400);
  }
  const sinceDays = Math.min(730, Math.max(1, parseInt(c.req.query("since_days") || "90", 10) || 90));
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);

  // Collect WHERE fragments + their bind values together so user input
  // (customer_name / phone / item_code) is always parameterised. The
  // hard-coded `sinceDays` is parsed to an int above so interpolating
  // it into the SQL string is safe.
  const conds: string[] = ["c.archived_at IS NULL"];
  const binds: any[] = [];
  let joinItems = false;

  switch (metric) {
    case "pending_review":
      conds.push("c.stage = 'pending_review'");
      break;
    case "aging":
      conds.push(`${assrOpenStageSql("c")}
        AND julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(a.created_at)
                   FROM assr_activity a
                  WHERE a.assr_id = c.id
                    AND a.action = 'stage_change'
                    AND a.to_value = c.stage),
                c.created_at
              )
            ) > 3`);
      break;
    case "breach_now":
      conds.push(`${assrOpenStageSql("c")}
        AND c.deadline_at IS NOT NULL
        AND datetime('now') > c.deadline_at`);
      break;
    case "open_now":
    case "opening_count":
      conds.push(assrOpenStageSql("c"));
      break;
    case "total_period":
      conds.push(`COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "closed_period":
      conds.push(`c.stage = 'completed' AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "breach_period":
      conds.push(`${assrOpenStageSql("c")}
        AND c.deadline_at IS NOT NULL
        AND datetime('now') > c.deadline_at
        AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "qa_passed":
      conds.push(`c.quality_review_passed = 1 AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "over_1_month":
      conds.push(`${assrOpenStageSql("c")}
        AND c.complained_date IS NOT NULL
        AND julianday('now') - julianday(c.complained_date) >= 30`);
      break;
    case "over_3_weeks":
      conds.push(`${assrOpenStageSql("c")}
        AND c.complained_date IS NOT NULL
        AND julianday('now') - julianday(c.complained_date) >= 21
        AND julianday('now') - julianday(c.complained_date) < 30`);
      break;
    case "over_2_weeks":
      conds.push(`${assrOpenStageSql("c")}
        AND c.complained_date IS NOT NULL
        AND julianday('now') - julianday(c.complained_date) >= 14
        AND julianday('now') - julianday(c.complained_date) < 21`);
      break;
    case "customer_cases": {
      // Repeat-customer drill — feeds the "Repeat Customers" panel
      // when a row is clicked. Match by name (required) and phone
      // (optional, mirroring how the metrics group identifies a
      // customer). Window by sinceDays so the panel matches the
      // count on the originating card.
      const name = (c.req.query("customer_name") || "").trim();
      const phone = (c.req.query("phone") || "").trim();
      if (!name) {
        return c.json({ error: "We couldn't load that customer's cases. Please try again." }, 400);
      }
      conds.push(`c.customer_name = ? AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      binds.push(name);
      if (phone) {
        conds.push("c.phone = ?");
        binds.push(phone);
      } else {
        // The metrics aggregate groups by (customer_name, phone) so a
        // NULL-phone row is its own bucket. Match the same shape here.
        conds.push("c.phone IS NULL");
      }
      break;
    }
    case "item_cases": {
      // Repeat-item drill — joins assr_items so we can filter by
      // item_code. Window by sinceDays for parity with the card.
      const code = (c.req.query("item_code") || "").trim();
      if (!code) {
        return c.json({ error: "We couldn't load that item's cases. Please try again." }, 400);
      }
      joinItems = true;
      conds.push(`i.item_code = ? AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      binds.push(code);
      break;
    }
  }

  const fromClause = joinItems
    ? "FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code JOIN assr_items i ON i.assr_id = c.id"
    : "FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code";
  const distinct = joinItems ? "DISTINCT" : "";
  // Row-level visibility. This endpoint returns the CASES behind a tile, so an
  // unscoped drill handed the caller the rows themselves, not just a count —
  // and `total` below is the length of this fetch, so scoping here fixes both.
  // Appended last, and its binds go last, because binds are positional.
  const visDrill = (await assrVisibilityScope(c))("c.");
  const where =
    conds.join(" AND ") + assrCompanySql(c, "c.company_id") + visDrill.sql;
  binds.push(...visDrill.binds);

  const rows = await c.env.DB.prepare(
    `SELECT ${distinct} c.id, c.assr_no, c.customer_name, c.stage, c.priority,
            c.complained_date, c.deadline_at, c.issue_category,
            c.creditor_code,
            cr.company_name AS creditor_name,
            (julianday('now') - julianday(c.complained_date)) AS age_days,
            CASE WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at
                 THEN 1 ELSE 0 END AS is_breached
       ${fromClause}
      WHERE ${where}
      ORDER BY c.complained_date DESC, c.id DESC
      LIMIT ${limit}`
  )
    .bind(...binds)
    .all();

  return c.json({
    metric,
    cases: rows.results ?? [],
    total: rows.results?.length ?? 0,
    limited: (rows.results?.length ?? 0) >= limit,
  });
});

// ── Auto-generate service PO number ───────────────────────────

app.post("/:id/generate-po", requirePermission("service_cases.manage"), async (c) => {
  // company-scope: the READ at :2683 carries assrCompanySql and :2691 returns 404 when it misses, so the unscoped UPDATE at :2699 can only ever reach an id this company owns. Verified 2026-08-19.
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  // A case's supplier is its creditor_code resolved against the creditors
  // mirror. assr_cases has never had a `supplier` column, so the old SELECT
  // raised `column "supplier" does not exist` and 500'd every click. Same join
  // the case detail already uses (services/assr.ts:489).
  /* COMPANY SCOPE — this read is the gate for the PO mint and the UPDATE that
     follows, both keyed on the same id. Unscoped, one company could burn a
     service-PO number onto the other company's case. Aliased column because the
     statement joins. */
  const poCoSql = assrCompanySql(c, "c.company_id");
  const existing = await c.env.DB.prepare(
    `SELECT c.po_no, c.creditor_code, cr.company_name AS creditor_name
       FROM assr_cases c
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
      WHERE c.id = ?${poCoSql}`
  )
    .bind(id)
    .first<{
      po_no: string | null;
      creditor_code: string | null;
      creditor_name: string | null;
    }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (existing.po_no) {
    return c.json({ error: `PO already exists: ${existing.po_no}`, po_no: existing.po_no }, 409);
  }

  const poNo = await nextServicePONumber(c.env);
  await c.env.DB.prepare(
    `UPDATE assr_cases SET po_no = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(poNo, id)
    .run();

  // Name when the mirror has the creditor, else the raw code — a case can carry
  // a creditor_code the mirror has not synced yet, and the code still tells the
  // reader who the PO is for.
  const supplierLabel = existing.creditor_name || existing.creditor_code;
  await logActivity(
    c.env,
    id,
    "po_generated",
    null,
    poNo,
    supplierLabel ? `Supplier: ${supplierLabel}` : null,
    userId
  );

  return c.json({ po_no: poNo }, 201);
});

// ── Manager approval / quality sign-off ───────────────────────

app.post("/:id/approve", requirePermission("service_cases.approve"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    quality_review_passed?: boolean;
    ncr_category?: string | null;
    note?: string;
  }>();

  const now = new Date().toISOString();
  /* COMPANY SCOPE. Found 2026-08-18 by check-company-scope.mjs, which could not
     see this statement until its raw-SQL table list learned about assr_cases:
     this UPDATE keyed on id alone while every sibling writer in this file
     (bulk/archive, bulk/unarchive, bulk/assign) carries assrCompanySql. So a
     HOUZS approver could sign off the other company's case and stamp their own
     NCR category on it — a quality record, written into books they cannot read
     back. */
  const approveCoSql = assrCompanySql(c);
  const r = await c.env.DB.prepare(
    `UPDATE assr_cases
        SET approved_by = ?, approved_at = ?,
            quality_review_passed = ?,
            ncr_category = COALESCE(?, ncr_category),
            updated_at = datetime('now')
      WHERE id = ?${approveCoSql}`
  )
    .bind(
      userId || null,
      now,
      body.quality_review_passed == null ? null : body.quality_review_passed ? 1 : 0,
      body.ncr_category ?? null,
      id
    )
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);

  // Log to activity trail so the timeline captures the sign-off.
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
     VALUES (?, 'approval', NULL, ?, ?, ?)`
  )
    .bind(
      id,
      body.quality_review_passed ? "passed" : "review",
      body.note ?? null,
      userId || null
    )
    .run();

  return c.json({ ok: true, approved_at: now });
});

// ── Stage transition ──────────────────────────────────────────

app.post("/:id/transition", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ stage: string; note?: string }>();
  if (!body.stage) return c.json({ error: "stage is required" }, 400);

  try {
    const ok = await transitionStage(c.env, id, body.stage as any, userId, body.note);
    if (!ok) return c.json({ error: "Not found" }, 404);

    // Auto-dispatch satisfaction survey when case is completed.
    // Fire-and-forget: if email is disabled or the customer has no
    // survey recipient, the email service silently skips (and still
    // logs the attempt). Prefer `email_for_survey` (proposal §14 —
    // separate from notify channel) and fall back to `customer_email`.
    if (body.stage === "completed") {
      const row = await c.env.DB.prepare(
        `SELECT assr_no, customer_name, customer_email, email_for_survey, company_id
           FROM assr_cases WHERE id = ?`
      )
        .bind(id)
        .first<{
          assr_no: string;
          customer_name: string | null;
          customer_email: string | null;
          email_for_survey: string | null;
          company_id: number | null;
        }>();
      const surveyTo = row?.email_for_survey || row?.customer_email;
      if (surveyTo) {
        // Customer-facing: carry the DOCUMENT's company identity (the case
        // row's company_id), not the operator's active company.
        const caseCompanyCode = await resolveCompanyCode(c.env, row!.company_id);
        const token = await issueSurveyToken(c.env, id);
        const link = publicUrl(c.env, `/survey/${token}`, caseCompanyCode);
        const name = (row!.customer_name || "").split(" ")[0] || "there";
        // Footer must carry the CASE's company (2990 cases must not sign off as
        // Houzs) — derive it from the document's branding, not a hardcode.
        const caseBranding = await getBrandingForCompany(c.env, caseCompanyCode);
        await sendEmail(c.env, {
          to: surveyTo,
          subject: `How was your experience with case ${row!.assr_no}?`,
          html: surveyEmailHtml(name, row!.assr_no, link, caseBranding.companyName),
          purpose: "assr_survey",
          refType: "assr",
          refId: id,
          companyCode: caseCompanyCode,
        });
      }
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

function surveyEmailHtml(name: string, assrNo: string, link: string, companyName: string): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 12px">Thanks for your patience, ${name}.</h2>
      <p>We've wrapped up your service case <strong>${assrNo}</strong>. Your feedback helps us improve.</p>
      <p style="margin:24px 0">
        <a href="${link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Rate your experience
        </a>
      </p>
      <p style="color:#777;font-size:13px">Takes about 30 seconds — one rating + an optional note.</p>
      <p style="color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:14px;margin-top:28px">
        ${companyName}
      </p>
    </div>`;
}

// ── Notes ─────────────────────────────────────────────────────

// Manual-note audience buckets (mig 0108). Legacy 'purchasing' from
// not-yet-refreshed clients maps to 'service'; unknown values fall back
// to 'service' too so nothing lands unclassified.
const NOTE_CATEGORIES = new Set(["service", "customer", "supplier", "sales"]);
function noteCategory(v?: string): "service" | "customer" | "supplier" | "sales" {
  if (v === "purchasing") return "service";
  return NOTE_CATEGORIES.has(v ?? "") ? (v as any) : "service";
}

app.post("/:id/notes", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    note: string;
    category?: string;
  }>();
  if (!body.note?.trim()) return c.json({ error: "note is required" }, 400);
  // Manual notes pick an audience bucket (mig 0108): service (internal,
  // the old 'purchasing'), customer (portal-visible), supplier or sales.
  // 'system' is reserved for auto-emitted events, and anything unknown
  // (incl. the legacy 'purchasing' from stale clients) falls back to
  // 'service', so a misconfigured client can't impersonate an event.
  const category = noteCategory(body.category);
  await logActivity(c.env, id, "note", null, null, body.note, userId, {
    category,
    source_channel: "app",
  });
  return c.json({ ok: true });
});

// ── Service Log corrections (v3.1 mig 077) ────────────────────
//
// assr_activity is append-only: instead of editing a row, post a new
// "correction" entry that references the prior one. Useful for fixing
// a misposted note or stage_change without erasing the audit trail.

app.post("/:id/notes/:noteId/correct", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const noteId = parseInt(c.req.param("noteId"), 10);
  if (isNaN(id) || isNaN(noteId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ note: string; category?: string }>();
  if (!body.note?.trim()) return c.json({ error: "correction note is required" }, 400);

  // Verify the referenced entry belongs to this case.
  const prior = await c.env.DB.prepare(
    `SELECT id FROM assr_activity WHERE id = ? AND assr_id = ?`
  )
    .bind(noteId, id)
    .first<{ id: number }>();
  if (!prior) return c.json({ error: "Referenced entry not found on this case" }, 404);

  await logActivity(c.env, id, "note", null, null, body.note, userId, {
    category: noteCategory(body.category),
    source_channel: "app",
    references_entry_id: noteId,
    is_correction: true,
  });
  return c.json({ ok: true });
});

// ── Service Log export (CSV) ────────────────────────────────────
//
// Full audit trail for one case in CSV form. Manager-only — internal
// notes + supplier comms aren't customer-safe.

app.get("/:id/timeline.csv", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  // Scope guard — a Sales caller admitted by org field may DOWNLOAD the timeline
  // of a case within their reporting chain (self + downline), but not an
  // arbitrary case. Out-of-scope → 404 (mirrors the detail GET). Directors /
  // service_cases.manage stay unrestricted (caseInCallerScope short-circuits).
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT assr_no FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ assr_no: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.created_at, a.action, a.category, a.source_channel,
            a.from_value, a.to_value, a.note,
            a.stage_elapsed_days, a.stage_target_days,
            a.is_correction, a.references_entry_id,
            u.name AS user_name
       FROM assr_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.assr_id = ? AND a.archived_at IS NULL
      ORDER BY a.created_at ASC, a.id ASC`
  )
    .bind(id)
    .all<any>();

  const lines: string[] = [
    [
      "id",
      "timestamp",
      "action",
      "category",
      "source_channel",
      "from",
      "to",
      "elapsed_days",
      "target_days",
      "user",
      "note",
      "is_correction",
      "references_entry_id",
    ].join(","),
  ];
  for (const r of rows.results ?? []) {
    const fields = [
      r.id,
      r.created_at,
      r.action,
      r.category,
      r.source_channel || "",
      r.from_value || "",
      r.to_value || "",
      r.stage_elapsed_days != null ? Number(r.stage_elapsed_days).toFixed(2) : "",
      r.stage_target_days != null ? Number(r.stage_target_days).toFixed(2) : "",
      r.user_name || "",
      r.note || "",
      r.is_correction ? "1" : "0",
      r.references_entry_id ?? "",
    ];
    lines.push(fields.map(csvField).join(","));
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${row.assr_no}-timeline.csv"`,
    },
  });
});

function csvField(v: any): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Items ─────────────────────────────────────────────────────

app.post("/:id/items", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    items: { item_code: string; item_description?: string; qty?: number }[];
  }>();
  if (!body.items?.length) return c.json({ error: "items required" }, 400);
  await addItems(c.env, id, body.items);
  return c.json({ ok: true });
});

app.delete("/:id/items/:itemId", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const itemId = parseInt(c.req.param("itemId"), 10);
  await removeItem(c.env, id, itemId);
  return c.json({ ok: true });
});

// Per-item remark — prints in the ITEMS table's REMARK column on both
// the customer and supplier copies (Nick 2026-07-15).
app.patch("/:id/items/:itemId", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(id) || isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{ remark?: string | null; supplier_remark?: string | null; qty?: number; qty_carton?: number }>();
  const userId = (c as any).get?.("userId") ?? null;
  const prevItem = await c.env.DB.prepare(
    `SELECT item_code, remark, supplier_remark, qty FROM assr_items WHERE id = ? AND assr_id = ?`
  )
    .bind(itemId, id)
    .first<{ item_code: string | null; remark: string | null; supplier_remark: string | null; qty: number | null }>();
  if (!prevItem) return c.json({ error: "Not found" }, 404);
  const code = prevItem.item_code ?? `#${itemId}`;

  // Quantity — clamp to a positive integer; log the change.
  if (body.qty !== undefined) {
    const qty = Math.max(1, Math.round(Number(body.qty) || 0));
    const ok = await setItemQty(c.env, id, itemId, qty);
    if (!ok) return c.json({ error: "Not found" }, 404);
    if ((prevItem.qty ?? 1) !== qty) {
      await logActivity(
        c.env,
        id,
        "item_qty",
        String(prevItem.qty ?? 1),
        String(qty),
        `Quantity on ${code}: ${prevItem.qty ?? 1} → ${qty}`,
        userId,
        { category: "service", source_channel: "app" }
      );
    }
  }

  // Carton quantity — a second, user-selected quantity. Not logged to the
  // timeline (date + remark only, owner 2026-07-21).
  if (body.qty_carton !== undefined) {
    const qtyCarton = Math.max(1, Math.round(Number(body.qty_carton) || 0));
    const ok = await setItemCartonQty(c.env, id, itemId, qtyCarton);
    if (!ok) return c.json({ error: "Not found" }, 404);
  }

  // Remark — capture the prior value so the change is recorded
  // append-only on the timeline (removing logs a "cleared" event).
  if (body.remark !== undefined) {
    const remark = body.remark == null ? null : String(body.remark).trim() || null;
    const ok = await setItemRemark(c.env, id, itemId, remark);
    if (!ok) return c.json({ error: "Not found" }, 404);
    if ((prevItem.remark ?? null) !== remark) {
      await logActivity(
        c.env,
        id,
        "item_remark",
        prevItem.remark ?? null,
        remark,
        remark
          ? `Product remark on ${code}: ${prevItem.remark ? `"${prevItem.remark}" → ` : ""}"${remark}"`
          : `Product remark on ${code} cleared${prevItem.remark ? ` (was "${prevItem.remark}")` : ""}`,
        userId,
        { category: "service", source_channel: "app" }
      );
    }
  }
  // Supplier-copy remark — same append-only audit trail, supplier
  // timeline bucket.
  if (body.supplier_remark !== undefined) {
    const remark = body.supplier_remark == null ? null : String(body.supplier_remark).trim() || null;
    const ok = await setItemSupplierRemark(c.env, id, itemId, remark);
    if (!ok) return c.json({ error: "Not found" }, 404);
    if ((prevItem.supplier_remark ?? null) !== remark) {
      await logActivity(
        c.env,
        id,
        "item_supplier_remark",
        prevItem.supplier_remark ?? null,
        remark,
        remark
          ? `Supplier remark on ${code}: ${prevItem.supplier_remark ? `"${prevItem.supplier_remark}" → ` : ""}"${remark}"`
          : `Supplier remark on ${code} cleared${prevItem.supplier_remark ? ` (was "${prevItem.supplier_remark}")` : ""}`,
        userId,
        { category: "supplier", source_channel: "app" }
      );
    }
  }
  return c.json({ ok: true });
});

// ── Attachments ───────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "mov", "webm", "pdf"]);
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

app.put("/:id/attachments", requireAnyPermission(["service_cases.write", "service_cases.create", "service_cases.manage"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const category = c.req.query("category") || "complaint";
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const fileName = c.req.query("name") || null;

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 400);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_SIZE) {
    return c.json({ error: "File too large (max 25MB)" }, 400);
  }

  const contentType =
    ext === "mp4" ? "video/mp4" :
    ext === "mov" ? "video/quicktime" :
    ext === "webm" ? "video/webm" :
    ext === "pdf" ? "application/pdf" :
    `image/${ext === "jpg" ? "jpeg" : ext}`;

  const key = assrAttachmentKey(id, category, ext);
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  const attachId = await saveAttachment(c.env, id, key, fileName, contentType, category, userId);

  await logActivity(
    c.env,
    id,
    "attachment_added",
    null,
    fileName ?? key,
    `Added ${category} attachment${fileName ? ` (${fileName})` : ""}`,
    userId || null,
    { category: "service", source_channel: "app" }
  );

  return c.json({ id: attachId, key }, 201);
});

// WO-7 — optional client-generated thumbnail for a photo attachment, stored
// at `<r2_key>.thumb`. The frontend uploads it right after the main PUT above;
// old clients never call this and nothing changes for them. Best-effort by
// design: a failed thumb never invalidates the already-saved attachment.
app.put("/:id/attachments/thumb", requireAnyPermission(["service_cases.write", "service_cases.create", "service_cases.manage"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const key = c.req.query("key") || "";
  // The key must be a real attachment of THIS case — never trust the caller's
  // key shape (mirrors the download route's ownership rule).
  const att = await c.env.DB.prepare(
    `SELECT assr_id FROM assr_attachments WHERE r2_key = ?`,
  )
    .bind(key)
    .first<{ assr_id: number | null }>();
  if (Number(att?.assr_id ?? NaN) !== id) return c.json({ error: "Not found" }, 404);

  const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "Thumbnails must be images" }, 400);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > THUMB_MAX_BYTES) {
    return c.json({ error: "Thumbnail too large (max 1MB)" }, 400);
  }

  await c.env.POD_BUCKET.put(thumbKeyFor(key), body, { httpMetadata: { contentType } });
  return c.json({ ok: true, key: thumbKeyFor(key) }, 201);
});

app.get("/attachments/:key{.+}", requireServiceCaseAccess(), async (c) => {
  const key = c.req.param("key");
  // Resolve the attachment's OWNING case from its r2_key (canonical — never
  // trust the caller-supplied key's shape), then enforce the same self+downline
  // scope as the case detail: a Sales caller may download attachments only for
  // cases within their reporting chain. Unknown key or out-of-scope case → 404,
  // indistinguishable from a nonexistent object. Directors / service_cases.manage
  // stay unrestricted (caseInCallerScope short-circuits).
  // WO-7: a `<r2_key>.thumb` request is authorised against its BASE key's row
  // (thumbs have no assr_attachments row); missing thumb objects 404 below and
  // the frontend falls back to the original.
  const att = await c.env.DB.prepare(
    `SELECT assr_id FROM assr_attachments WHERE r2_key = ?`,
  )
    .bind(isThumbKey(key) ? baseKeyOf(key) : key)
    .first<{ assr_id: number | null }>();
  const caseId = Number(att?.assr_id ?? NaN);
  if (!Number.isFinite(caseId)) return c.json({ error: "Not found" }, 404);
  if (!(await caseInCallerScope(c, caseId))) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);

  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      // Block MIME-sniffing the server-derived content-type back into
      // html/svg (parity with mail-center.ts's INLINE_SAFE serve).
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ── Logistics ─────────────────────────────────────────────────

/**
 * Service-wide logistics feed for the Logistics tab's Service sub-tab.
 * Returns ASSR logistics rows joined with case context so ops can see
 * pickups/deliveries across all open cases in one list.
 */
app.get("/logistics/all", requirePermission("service_cases.read"), async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const perPage = Math.min(200, Math.max(10, parseInt(c.req.query("per_page") || "50", 10)));
  const status = c.req.query("status");
  const type = c.req.query("type");
  const search = (c.req.query("search") || "").trim();

  const where: string[] = ["l.archived_at IS NULL", "ca.archived_at IS NULL"];
  const binds: any[] = [];
  if (status) { where.push("l.status = ?"); binds.push(status); }
  if (type) { where.push("l.type = ?"); binds.push(type); }
  if (search) {
    where.push("(ca.assr_no LIKE ? OR ca.customer_name LIKE ? OR l.notes LIKE ?)");
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  // Row-level visibility + the company pin, both keyed off the joined case.
  // This feed had NEITHER: it is the one ASSR read `fix/assr-scope-creator2`
  // missed when it swapped the company helper across the module, so it was the
  // only place a logistics row could cross both the company and the reporting
  // boundary. Appended last; binds are positional and follow in the same order.
  const visLog = (await assrVisibilityScope(c))("ca.");
  const whereSql =
    `WHERE ${where.join(" AND ")}` +
    assrCompanySql(c, "ca.company_id") +
    visLog.sql;
  binds.push(...visLog.binds);

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as n
       FROM assr_logistics l
       JOIN assr_cases ca ON ca.id = l.assr_id
      ${whereSql}`
  ).bind(...binds).first<{ n: number }>();

  const offset = (page - 1) * perPage;
  const rows = await c.env.DB.prepare(
    `SELECT l.*,
            ca.assr_no,
            ca.customer_name,
            ca.stage,
            ca.priority,
            u.name as assigned_to_name
       FROM assr_logistics l
       JOIN assr_cases ca ON ca.id = l.assr_id
       LEFT JOIN users u ON u.id = l.assigned_to
      ${whereSql}
      ORDER BY COALESCE(l.scheduled_date, l.created_at) DESC, l.id DESC
      LIMIT ? OFFSET ?`
  ).bind(...binds, perPage, offset).all<any>();

  return c.json({
    rows: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    per_page: perPage,
  });
});

app.post("/:id/logistics", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    type: string;
    scheduled_date?: string;
    scheduled_time_range?: string;
    assigned_to?: number;
    notes?: string;
  }>();
  if (!body.type) return c.json({ error: "type is required" }, 400);
  const logId = await createLogistics(c.env, id, body);
  return c.json({ id: logId }, 201);
});

app.patch("/:id/logistics/:logId", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const logId = parseInt(c.req.param("logId"), 10);
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchLogistics(c.env, id, logId, body);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Cost-suggestion helpers ───────────────────────────────────

/** Parse the AutoCount line set: case-insensitive ItemCode match. */
function matchLine(
  lines: Array<Record<string, any>> | null | undefined,
  itemCode: string
): Record<string, any> | null {
  if (!lines || !Array.isArray(lines)) return null;
  const target = itemCode.toLowerCase();
  for (const ln of lines) {
    const code = String(ln.ItemCode ?? ln.itemCode ?? ln.item_code ?? "").toLowerCase();
    if (code === target) return ln;
  }
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

export default app;
