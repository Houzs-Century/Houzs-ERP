import { Hono } from "hono";
import { assrNoteCategory } from "../services/assrNoteCategories";
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
  setCaseCreditorManual,
  setItemRemark,
  setItemSupplierRemark,
  setItemQty,
  setItemCartonQty,
} from "../services/assr";
import { normalizeSlaHours } from "../services/assrSla";
import { assignServicePoNumber, nextManualCreditorCode } from "../services/assrNumbers";
import { assrWindow } from "./lib/assr-window";
import { openSupplierReturnRoute, patchSupplierReturnRoute, archiveSupplierReturnRoute } from "../services/assrSupplierReturns";
import { addReturnDoRoute, archiveReturnDoRoute, patchReturnDoRoute, qcInspectionFieldsError } from "../services/assrReturnDos";
import { reopenCaseRoute } from "../services/assrReopen";
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
  companyCodeMap,
  type CompanyScopeCtx,
} from "../scm/lib/companyScope";
import { officeCreateFromDeliveryIssue } from "../scm/lib/delivery-issue";
import { hasPermission } from "../services/permissions";
import { subtreeUserIds } from "../services/orgScope";
import {
  assrUnrestricted, assrVisibleUserIds, assrVisibilityPredicateSql,
  assrCaseRowInScope, assrCallerIsScoped, stripCreditorFields, listMyCases,
} from "../services/assrVisibility";
import { notifyServiceCaseResponsible } from "../services/assrNotify";
import { grantCaseAccess, revokeCaseAccess } from "./assrAccess";
import { isDirectorUser } from "../services/pmsAccess";
import type { AuthUser } from "../services/auth";
import type { Context, MiddlewareHandler } from "hono";
import { normalizePhone } from "../scm/shared/phone";
import { ASSR_SUB_STATUS_KEYS } from "../scm/shared/assr-sub-statuses";
import { pickupTrackingError } from "../scm/shared/assr-pickup-tracking";
import { verificationFieldsError } from "../scm/shared/assr-verification-fields";
import { getVerificationNotes, saveVerificationNotes, takeVerificationNotes } from "../services/assrVerificationNotes";
import { getQcNotes, saveQcNotes, takeQcNotes } from "../services/assrQcNotes";
import { caseAddressError, getCaseAddress, saveCaseAddress, takeCaseAddress } from "../services/assrCaseAddress";
import { sendCompletionSurvey } from "../services/assrCompletionSurvey";
import { sendServiceCaseReceivedAck } from "../services/assrConnectAck";
import { overviewFilter, withOverviewFilter } from "./lib/assr-overview-filter";
import { todayMyt } from "../scm/lib/my-time";
import { assrExportShowsCost, buildAssrCasesCsv } from "./lib/assr-export-csv";
import { caseCompanySql, namedSupplierGroups, showErpSupplierNames, withErpSuppliers } from "../services/assrCreditorFill";

type HandlerCtx = Context<{ Bindings: Env }, "/:id/cost-suggestion">;
const app = new Hono<{ Bindings: Env }>();

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
// ANY company grant, OR is a director (Owner/IT `*`, Super Admin, Sales
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
  return holdsAnyCompanyGrant(c) || isDirectorUser(user);
}

/**
 * Does this caller hold a company grant AT ALL?
 *
 * THE GATE ASKS "WHICH COMPANY", NOT "WHICH COMPANY IS IT". The 2026-08-20
 * ruling (docs/SERVICE-CASE-VISIBILITY-DECISION.md) replaced a JOB TITLE with a
 * COMPANY GRANT — 「我们不 control Agent，可是我们 control Company」,
 * 「有 Houzs 这家公司的授权 就好（不看职称）」. The load-bearing half is the
 * parenthesis: the title stops deciding. The fix shipped with the HOUZS literal
 * because the incident was HOUZS agents losing access, and that literal is
 * NARROWER than the rule it implements — the 2026-07-20 trail below already
 * said Service Cases follow the caller's GRANTED companies and anticipated
 * "a future 2990 rep's is {2990}".
 *
 * census-service-case-visibility.mjs §1 had even named the cohort in advance:
 * "the 2990-only cohort the literal rule would strand". It was measured and
 * the literal shipped anyway.
 *
 * ADMITTING IS NOT SHOWING. Every read in this module is already scoped by
 * assrCompanySql -> allowedCompaniesSql, so a 2990 grantee admitted here sees
 * 2990's cases and nothing else; and the AutoCount mirror arm keeps its OWN
 * HOUZS test (that table holds only HOUZS rows), so opening the door does not
 * open that book.
 *
 * Same three-state sentinel as holdsHouzsCompanyGrant, and it must stay that
 * way: `undefined` (unresolved / pre-migration / cold start) degrades to YES so
 * a blip cannot 403 everyone, `[]` (granted nothing) is NO.
 */
export function holdsAnyCompanyGrant(c: CompanyScopeCtx): boolean {
  const allowed = allowedCompanyIds(c);
  if (allowed === undefined) return true;
  return allowed.length > 0;
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
  if (allowed === undefined) return true;
  const houzs = houzsCompanyId(c);
  if (houzs === undefined) return false;
  return allowed.includes(houzs);
}

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
export function assrCompanySql(c: CompanyScopeCtx, col = "company_id"): string {
  return allowedCompaniesSql(c, col);
}
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
export async function assrVisibilityScope(c: {
  get(key: "user"): unknown;
  env: Env;
}): Promise<(prefix?: string) => { sql: string; binds: string[] }> {
  const ids = await assrVisibleUserIds(c);
  return (prefix = "c.") => assrVisibilitySql(ids, prefix);
}

async function caseInCallerScope(
  c: { get(key: "user"): unknown; env: Env },
  caseId: number,
): Promise<boolean> {
  const visibleIds = await assrVisibleUserIds(c);
  const allowedCo = assrCompanyIds(c as Context<any>);
  if (visibleIds === undefined && allowedCo === undefined) return true;
  const row = await c.env.DB.prepare(
    `SELECT id, created_by, assigned_to, assigned_to_2, doc_no, company_id FROM assr_cases WHERE id = ?`,
  )
    .bind(caseId)
    .first<{ id: number; created_by: number | null; assigned_to: number | null; assigned_to_2: number | null; doc_no: string | null; company_id: number | null }>();
  if (!row) return false;
  if (allowedCo) {
    const caseCo = Number(row.company_id ?? NaN);
    if (Number.isFinite(caseCo) && !allowedCo.includes(caseCo)) return false;
  }
  if (visibleIds === undefined) return true;
  return assrCaseRowInScope(c as Context<any>, row);
}


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
    if (!(field in body)) continue;
    const id = body[field as keyof typeof DEFAULT_ASSIGNEE_KEYS];
    if (id === null || id === undefined) {
      await c.env.DB.prepare(`DELETE FROM system_settings WHERE key = ?`).bind(key).run();
    } else {
      if (typeof id !== "number" || isNaN(id)) {
        return c.json({ error: `${field} must be a number or null` }, 400);
      }
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


const LOOKUP_TABLES = {
  "issue-categories": "assr_issue_categories",
  "resolution-methods": "assr_resolution_methods",
  "priorities": "assr_priorities",
  "ncr-categories": "assr_ncr_categories",
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
  await c.env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});


export const assrCostSuggestionHandler = async (c: HandlerCtx) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const caseRow = await c.env.DB.prepare(
    `SELECT doc_no, po_no, item_code, company_id FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ doc_no: string | null; po_no: string | null; item_code: string | null; company_id: number | null }>();
  if (!caseRow) return c.json({ error: "Not found" }, 404);
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

  let poAmount: number | null = null;
  let poSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.po_no) {
    const poRow = await c.env.DB.prepare(
      `SELECT remaining_qty AS qty,
              original_qty  AS ord_qty,
              unit_price    AS price
         FROM purchase_orders
        WHERE doc_no = ? AND item_code = ? AND company_id = ?
        LIMIT 1`
    )
      .bind(caseRow.po_no, itemCode, caseRow.company_id)
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


app.get("/summary", requirePermission("service_cases.read"), async (c) => {
  const win = assrWindow({ from: c.req.query("from"), to: c.req.query("to"), since_days: c.req.query("since_days") });
  const sinceDays = win.days;
  const periodAnd =
    `AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`;
  const coC = assrCompanySql(c, "c.company_id");
  const coBare = assrCompanySql(c);
  const vis = withOverviewFilter(await assrVisibilityScope(c), overviewFilter(c));
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

    c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM assr_cases c
      WHERE c.stage = 'pending_review' AND c.archived_at IS NULL
        ${periodAnd}${coC}${visC.sql}`
    )
      .bind(...visC.binds)
      .first<{ count: number }>(),

    c.env.DB.prepare(
      `SELECT AVG(julianday(closed_at) - julianday(created_at)) AS avg_days
       FROM assr_cases
      WHERE stage = 'completed'
        AND closed_at IS NOT NULL
        AND julianday(closed_at) > julianday(created_at)
        AND (julianday(closed_at) - julianday(created_at)) < 365
        AND ${win.sql("closed_at")}${coBare}${visBare.sql}`
    )
      .bind(...visBare.binds)
      .first<{ avg_days: number | null }>(),

    c.env.DB.prepare(
      `SELECT c.stage AS stage,
            COUNT(*) AS total,
            SUM(CASE
                  WHEN h.target_days IS NOT NULL AND h.target_days > 0
                   AND (julianday('now') - julianday(h.entered_at)) / h.target_days >= 1
                  THEN 1 ELSE 0 END) AS breached,
            SUM(CASE WHEN COALESCE(c.sub_status, 'none') = 'pending_supplier_return' THEN 1 ELSE 0 END) AS sub_return,
            SUM(CASE WHEN COALESCE(c.sub_status, 'none') = 'pending_customer_pickup' THEN 1 ELSE 0 END) AS sub_customer
       FROM assr_cases c
       LEFT JOIN assr_stage_history h
              ON h.assr_id = c.id AND h.exited_at IS NULL
      WHERE c.archived_at IS NULL
        ${periodAnd}${coC}${visC.sql}
      GROUP BY c.stage`
    )
      .bind(...visC.binds)
      .all<{ stage: string; total: number; breached: number; sub_return: number; sub_customer: number }>(),

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
    pending_review_count: pendingReview?.count || 0,
    avg_e2e_days: avgE2E?.avg_days != null ? Number(Number(avgE2E.avg_days).toFixed(1)) : null,
    stage_funnel: funnel.results ?? [],
    csat_trend: csatTrend.results ?? [],
  });
});


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

app.post("/:id/resolve-creditor", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT item_code FROM assr_cases WHERE id = ? AND archived_at IS NULL${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ item_code: string | null }>();
  if (!row) return c.json({ error: "Case not found" }, 404);
  if (!row.item_code)
    return c.json({ error: "Case has no item_code — set one first" }, 400);

  try {
    const { resolveCreditorForCase } = await import("../services/stockItems");
    const { code: creditorCode, soMissing, kept } = await resolveCreditorForCase(c.env, id, row.item_code, { force: true });
    return c.json({
      ok: true,
      item_code: row.item_code,
      creditor_code: creditorCode,
      message: soMissing ? "SO not in the ERP; supplier kept" : kept ? `${row.item_code} has no supplier on its PO or SO — kept ${creditorCode}` : creditorCode
        ? `Resolved ${row.item_code} → ${creditorCode}`
        : `${row.item_code} has no supplier on its PO or SO — pick one by hand`,
    });
  } catch {
    return c.json({ error: "Couldn't look up the supplier. Try again shortly." }, 502);
  }
});

app.post("/sync-delivery-orders", requirePermission("service_cases.manage"), async (c) => {
  try {
    const { runDoMirrorSync } = await import("../services/doMirror");
    const r = await runDoMirrorSync(c.env, "MANUAL");
    return c.json(r);
  } catch {
    return c.json({ error: "Couldn't reach AutoCount to refresh delivery orders. Try again shortly." }, 502);
  }
});


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
    .all<{ creditor_code: string; company_name: string | null; phone1: string | null }>();
  return c.json({ results: await withErpSuppliers(c.env, assrCompanyIds(c), q, rows.results ?? []) });
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
    code = await nextManualCreditorCode(c.env);
  }

  // company-scope: creditor_code is the table's GLOBAL primary key (0000_baseline), so the duplicate check must see every company or the INSERT below fails on the key.
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

  const creditorCo = assrCreateCompanyId(c);
  await c.env.DB.prepare(
    `INSERT INTO creditors (creditor_code, company_name, phone1, email, type, type_description, updated_at${creditorCo != null ? ", company_id" : ""})
     VALUES (?, ?, ?, ?, 'MANUAL', 'Added manually from Service Cases', datetime('now')${creditorCo != null ? ", ?" : ""})`
  )
    .bind(code, name, normalizePhone(body.phone), (body.email || "").trim() || null, ...(creditorCo != null ? [creditorCo] : []))
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

app.get("/by-creditor", requirePermission("service_cases.read"), async (c) => {
  const search = (c.req.query("search") || "").trim();
  const coC = assrCompanySql(c, "c.company_id");
  const vis = await assrVisibilityScope(c);
  const visC = vis("c.");
  const visBare = vis("assr_cases.");

  const coCol = caseCompanySql(c.env, "c.");
  const grouped = await c.env.DB.prepare(
    `SELECT c.creditor_code,
            ${coCol} AS company_id,
            cr.company_name AS creditor_name,
            cr.email        AS creditor_email,
            cr.phone1       AS creditor_phone,
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
      GROUP BY c.creditor_code, ${coCol}, cr.company_name, cr.email, cr.phone1
      ORDER BY total DESC, creditor_name ASC`
  ).bind(...visC.binds).all<Record<string, unknown>>();
  const rows = await namedSupplierGroups(c.env, grouped.results ?? [], search);

  const unassigned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ${assrOpenStageSql()} THEN 1 ELSE 0 END) AS open
       FROM assr_cases
      WHERE archived_at IS NULL AND (creditor_code IS NULL OR creditor_code = '')${assrCompanySql(c)}${visBare.sql}`
  )
    .bind(...visBare.binds)
    .first<{ total: number; open: number }>();

  return c.json({
    rows,
    unassigned: {
      total: unassigned?.total ?? 0,
      open: unassigned?.open ?? 0,
    },
  });
});


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
        `SELECT assr_no, customer_name FROM assr_cases WHERE id = ?${coSql}`,
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
  for (const r of rows as any[]) {
    if (csvVisibleIds !== undefined) stripCreditorFields(r);
    r.delivery_order = r.delivery_order || r.do_numbers || null;
  }
  const csv = buildAssrCasesCsv(rows as Array<Record<string, unknown>>, assrExportShowsCost(c.get("user") ?? null));
  const date = todayMyt();
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="service-cases-${date}.csv"`,
    },
  });
});


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

  const coFilter = assrCompanySql(c, "so.company_id");
  // linked_ac_docno holds the migrated AutoCount number; customer_so_no holds the customer's own reference and is
  // what the app shows as "Ref No." when ref is empty. Search both, else those SOs answer "No match" (787 live, #5101).
  const scmRows = await c.env.DB.prepare(
    `SELECT so.doc_no, so.ref, so.debtor_name, so.phone,
            so.so_date AS doc_date, so.agent AS sales_agent, co.code AS company_code
       FROM scm."mfg_sales_orders" so
       LEFT JOIN companies co ON co.id = so.company_id
      WHERE (LOWER(so.doc_no) LIKE ?
          OR LOWER(COALESCE(so.ref, '')) LIKE ?
          OR LOWER(COALESCE(so.customer_so_no, '')) LIKE ?
          OR LOWER(COALESCE(so.debtor_name, '')) LIKE ?
          OR LOWER(COALESCE(so.linked_ac_docno, '')) LIKE ?)
        AND so.status <> 'DRAFT' AND so.status <> 'CANCELLED'${coFilter}
      ORDER BY so.so_date DESC
      LIMIT 20`
  )
    .bind(pattern, pattern, pattern, pattern, pattern)
    .all();

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

app.get("/my-cases", requireServiceCaseAccess(), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  if (!userId) return c.json({ cases: [] });
  return c.json(await listMyCases(c.env, Number(userId), assrCompanySql(c)));
});

app.post("/:id{[0-9]+}/sales-comment", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
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

app.post("/:id{[0-9]+}/sales-nudge", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
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


app.get("/:id{[0-9]+}", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.json({ error: "Not found" }, 404);
  Object.assign((detail as { case: Record<string, unknown> }).case, await getVerificationNotes(c.env, id), await getQcNotes(c.env, id), await getCaseAddress(c.env, id));
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
  const visibleIds = await assrVisibleUserIds(c);
  {
    const row = (detail as { case?: Record<string, any> }).case ?? (detail as Record<string, any>);
    if (!(await assrCaseRowInScope(c as any, row))) return c.json({ error: "Not found" }, 404);
  }
  if (visibleIds !== undefined) {
    stripCreditorFields((detail as { case?: Record<string, any> }).case);
  }
  return c.json(detail);
});

app.post("/:id{[0-9]+}/access", requirePermission("service_cases.write"), (c) => grantCaseAccess(c, caseInCallerScope));
app.delete("/:id{[0-9]+}/access/:userId{[0-9]+}", requirePermission("service_cases.write"), (c) => revokeCaseAccess(c, caseInCallerScope));



app.get("/:id/customer-history", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const cur = await c.env.DB.prepare(
    `SELECT customer_name, phone FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ customer_name: string | null; phone: string | null }>();
  if (!cur) return c.json({ error: "Not found" }, 404);
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


app.post(
  "/",
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
  const fromIssue = await officeCreateFromDeliveryIssue(c, (body as Record<string, unknown>).delivery_issue_id, Number((c as any).get?.("userId")) || null);
  if (fromIssue) return c.json(fromIssue.body, fromIssue.status);

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
    // company-scope: reads back the row THIS request just created (result.id), stamped with assrCreateCompanyId above.
    const row = await c.env.DB.prepare(
      `SELECT assigned_to, assigned_to_2, sales_agent, customer_name, phone, doc_no, created_by,
              ref_no, company_id, delivery_order
         FROM assr_cases WHERE id = ?`,
    )
      .bind(result.id)
      .first<{
        assigned_to: number | null;
        assigned_to_2: number | null;
        sales_agent: string | null;
        customer_name: string | null;
        phone: string | null;
        doc_no: string | null;
        created_by: number | null;
        ref_no: string | null;
        company_id: number | null;
        delivery_order: string | null;
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
      // Customer WhatsApp ack via Houzs Connect (best-effort, create-only; ref_1 =
      // the SO/order ref). Owner 2026-11-11 re-opened the create ack that HC-0222
      // had turned off, GATED: a case whose order has NO DO sends nothing — the gate
      // (sendServiceCaseReceivedAck, assrConnectAck.ts) resolves the DO the same way
      // the board/detail do, so it needs ref_no + company_code + any delivery_order.
      await sendServiceCaseReceivedAck(c.env, {
        assrNo: result.assr_no,
        soNo: row.doc_no,
        customerName: row.customer_name,
        phone: row.phone,
        refNo: row.ref_no,
        companyCode: row.company_id != null ? (companyCodeMap(c).get(row.company_id) ?? null) : null,
        deliveryOrder: row.delivery_order,
      });
    }
  } catch (e) {
    console.error("[assr.create] notify failed:", (e as Error).message);
  }

  return c.json(result, 201);
});


app.patch("/:id{[0-9]+}", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<Record<string, any>>();
  if (
    body.sub_status !== undefined &&
    body.sub_status !== null &&
    // The one list the screens offer (docs/bugs/0890): a hand-kept copy here
    // once lacked Pending Customer Pickup and refused the screens' own choice.
    !ASSR_SUB_STATUS_KEYS.has(String(body.sub_status))
  ) {
    return c.json({ error: "Unknown sub-status" }, 400);
  }
  const trackingError = pickupTrackingError(body) ?? verificationFieldsError(body) ?? qcInspectionFieldsError(body) ?? caseAddressError(body);
  if (trackingError) return c.json({ error: trackingError }, 400);
  // Snapshot the responsible fields BEFORE the patch so we notify only on an
  // ACTUAL change (owner 2026-07-15). A doc_no re-match inside patchAssrCase can
  // also rewrite sales_agent, so we compare committed before/after values
  // rather than trusting which keys the caller sent. Raw env.DB read is
  // snake_case (D1-compat shim).
  // Company scope: another company's case is "not found" before anything is written.
  const patchCoSql = assrCompanySql(c);
  const before = await c.env.DB.prepare(`SELECT assigned_to, assigned_to_2, sales_agent FROM assr_cases WHERE id = ?${patchCoSql}`)
    .bind(id)
    .first<{ assigned_to: number | null; assigned_to_2: number | null; sales_agent: string | null }>();
  if (!before) return c.json({ error: "Not found or no changes" }, 404);

  const notes = takeVerificationNotes(body);
  const qcNotes = takeQcNotes(body);
  const ok = await patchAssrCase(c.env, id, body, userId);
  const notesOk = notes ? await saveVerificationNotes(c.env, id, notes, userId) : false;
  const qcNotesOk = qcNotes ? await saveQcNotes(c.env, id, qcNotes, userId) : false;
  const addr = takeCaseAddress(body), addrOk = addr ? await saveCaseAddress(c.env, id, addr, userId, true) : false;
  if (!ok && !notesOk && !qcNotesOk && !addrOk) return c.json({ error: "Not found or no changes" }, 404);

  try {
    const after = await c.env.DB.prepare(
      `SELECT assigned_to, assigned_to_2, sales_agent, customer_name, assr_no
         FROM assr_cases WHERE id = ?${patchCoSql}`,
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

app.post("/:id{[0-9]+}/mark-opened", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const advanced = await markCaseOpened(c.env, id, userId);
  return c.json({ advanced });
});

app.post("/:id/track-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueStaffToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

app.post("/:id/sales-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueSalesToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

app.delete("/:id/track-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const revokeCoSql = assrCompanySql(c);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?${revokeCoSql}`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  await revokeCaseTokens(c.env, id);
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


app.post("/:id/supplier-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, creditor_code FROM assr_cases WHERE id = ?${assrCompanySql(c)}`
  )
    .bind(id)
    .first<{ id: number; creditor_code: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const { issueSupplierToken } = await import("../services/supplierPortal");
  const token = await issueSupplierToken(c.env, id, row.creditor_code);
  return c.json({ token, path: `/portal/supplier/${token}` }, 201);
});

app.delete("/:id/supplier-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
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


app.post("/:id/survey-token", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const token = await issueSurveyToken(c.env, id);
  return c.json({ token });
});


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

app.post("/attachments/:attId/archive", requireAnyPermission(["service_cases.write", "service_cases.manage"]), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
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


app.post("/run-escalation", requirePermission("service_cases.manage"), async (c) => {
  const result = await runSlaEscalation(c.env);
  return c.json(result);
});


app.get("/metrics", requirePermission("service_cases.read"), async (c) => {
  const win = assrWindow({ from: c.req.query("from"), to: c.req.query("to"), since_days: c.req.query("since_days") });
  const sinceDays = win.days;
  const sinceFor = (prefix = "") =>
    `AND ${win.sql(`COALESCE(${prefix}complained_date, ${prefix}created_at)`)}`;
  const sinceClause = sinceFor();
  const coBare = assrCompanySql(c);
  const coC = assrCompanySql(c, "c.company_id");
  const coA = assrCompanySql(c, "a.company_id");
  const vis = withOverviewFilter(await assrVisibilityScope(c), overviewFilter(c));
  const visBare = vis("assr_cases.");
  const visC = vis("c.");
  const visA = vis("a.");

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

  const ncr = await c.env.DB.prepare(
    `SELECT COALESCE(ncr_category, 'unclassified') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}
      GROUP BY ncr_category
      ORDER BY count DESC`
  )
    .bind(...visBare.binds)
    .all();

  const issueCategories = await c.env.DB.prepare(
    `SELECT COALESCE(issue_category, 'Other') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}
      GROUP BY issue_category
      ORDER BY count DESC`
  )
    .bind(...visBare.binds)
    .all();

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

  const resolutions = await c.env.DB.prepare(
    `SELECT COALESCE(resolution_method, 'unset') as method, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}${visBare.sql}
      GROUP BY resolution_method
      ORDER BY count DESC`
  )
    .bind(...visBare.binds)
    .all();

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

  const coColA = caseCompanySql(c.env, "a.");
  const creditorPerf = await c.env.DB.prepare(
    `SELECT a.creditor_code as creditor_code,
            ${coColA} as company_id,
            cr.company_name as creditor_name,
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
      GROUP BY a.creditor_code, ${coColA}, cr.company_name
      ORDER BY total_cases DESC
      LIMIT 15`
  )
    .bind(...visA.binds)
    .all<Record<string, unknown>>();
  const perfRows = await showErpSupplierNames(c.env, creditorPerf.results ?? [], null);

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
    from: win.from,
    to: win.to,
    headline,
    ncr: ncr.results ?? [],
    issue_categories: issueCategories.results ?? [],
    resolutions: resolutions.results ?? [],
    repeat_items: repeatItems.results ?? [],
    repeat_customers: repeatCustomers.results ?? [],
    creditor_performance: perfRows.map(({ creditor_name, creditor_email: _e, creditor_phone: _p, creditor_mobile: _m, creditor_attention: _a, ...r }) => ({ ...r, name: creditor_name ?? null })),
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
  "category_cases",
  "resolution_cases",
] as const);

app.get("/metrics/drill", requirePermission("service_cases.read"), async (c) => {
  const metric = (c.req.query("metric") || "").trim();
  if (!DRILL_METRICS.has(metric as any)) {
    return c.json({ error: `Unknown metric: ${metric}` }, 400);
  }
  const win = assrWindow({ from: c.req.query("from"), to: c.req.query("to"), since_days: c.req.query("since_days") });
  const sinceDays = win.days;
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);

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
      conds.push(`${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
      break;
    case "closed_period":
      conds.push(`c.stage = 'completed' AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
      break;
    case "breach_period":
      conds.push(`${assrOpenStageSql("c")}
        AND c.deadline_at IS NOT NULL
        AND datetime('now') > c.deadline_at
        AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
      break;
    case "qa_passed":
      conds.push(`c.quality_review_passed = 1 AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
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
      const name = (c.req.query("customer_name") || "").trim();
      const phone = (c.req.query("phone") || "").trim();
      if (!name) {
        return c.json({ error: "We couldn't load that customer's cases. Please try again." }, 400);
      }
      conds.push(`c.customer_name = ? AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
      binds.push(name);
      if (phone) {
        conds.push("c.phone = ?");
        binds.push(phone);
      } else {
        conds.push("c.phone IS NULL");
      }
      break;
    }
    case "item_cases": {
      const code = (c.req.query("item_code") || "").trim();
      if (!code) {
        return c.json({ error: "We couldn't load that item's cases. Please try again." }, 400);
      }
      joinItems = true;
      conds.push(`i.item_code = ? AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
      binds.push(code);
      break;
    }
  }

  /* The cases behind one slice of the Issue Categories / Resolution Method
     donuts (owner 2026-10-20: click a category, the cases show below). Same
     window and grouping as the donut queries: a blank category reads "Other"
     (matched case-insensitively, as the page merges labels), a blank method
     is "unset". */
  if (metric === "category_cases") {
    const cat = (c.req.query("category") || "").trim();
    if (!cat) return c.json({ error: "Please choose a category." }, 400);
    conds.push(`LOWER(TRIM(COALESCE(c.issue_category, 'Other'))) = LOWER(?) AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
    binds.push(cat);
  }
  if (metric === "resolution_cases") {
    const method = (c.req.query("method") || "").trim();
    if (!method) return c.json({ error: "Please choose a resolution method." }, 400);
    conds.push(`COALESCE(c.resolution_method, 'unset') = ? AND ${win.sql("COALESCE(c.complained_date, c.created_at)")}`);
    binds.push(method);
  }

  const fromClause = joinItems
    ? "FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code JOIN assr_items i ON i.assr_id = c.id"
    : "FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code";
  const distinct = joinItems ? "DISTINCT" : "";
  const visDrill = withOverviewFilter(await assrVisibilityScope(c), overviewFilter(c))("c.");
  const where =
    conds.join(" AND ") + assrCompanySql(c, "c.company_id") + visDrill.sql;
  binds.push(...visDrill.binds);

  const rows = await c.env.DB.prepare(
    `SELECT ${distinct} c.id, c.assr_no, c.customer_name, c.stage, c.priority,
            c.complained_date, c.deadline_at, c.issue_category, c.complaint_issue, c.resolution_method,
            c.creditor_code, ${caseCompanySql(c.env, "c.")} AS company_id,
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
    .all<Record<string, unknown>>();
  await showErpSupplierNames(c.env, rows.results ?? [], null);

  return c.json({
    metric,
    cases: rows.results ?? [],
    total: rows.results?.length ?? 0,
    limited: (rows.results?.length ?? 0) >= limit,
  });
});


app.post("/:id/generate-po", requirePermission("service_cases.manage"), async (c) => {
  // company-scope: the READ at :2683 carries assrCompanySql and :2691 returns 404 when it misses, so the unscoped UPDATE at :2699 can only ever reach an id this company owns. Verified 2026-08-19.
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const poCoSql = assrCompanySql(c, "c.company_id");
  const existing = await c.env.DB.prepare(
    `SELECT c.po_no, c.creditor_code, ${caseCompanySql(c.env, "c.")} AS company_id, cr.company_name AS creditor_name
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

  const claim = await assignServicePoNumber(c.env, id);
  if (!claim.ok) return c.json({ error: `PO already exists: ${claim.poNo ?? ""}`, po_no: claim.poNo }, 409);
  const poNo = claim.poNo;

  await showErpSupplierNames(c.env, [existing], null);
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


app.post("/:id/transition", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ stage: string; note?: string }>();
  if (!body.stage) return c.json({ error: "stage is required" }, 400);

  try {
    const ok = await transitionStage(c.env, id, body.stage as any, userId, body.note);
    if (!ok) return c.json({ error: "Not found" }, 404);

    if (body.stage === "completed") await sendCompletionSurvey(c.env, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.post("/:id/supplier-returns", requirePermission("service_cases.write"), openSupplierReturnRoute);
app.patch("/:id/supplier-returns/:roundId{[0-9]+}", requirePermission("service_cases.write"), patchSupplierReturnRoute);
app.delete("/:id/supplier-returns/:roundId{[0-9]+}", requirePermission("service_cases.write"), archiveSupplierReturnRoute);
app.post("/:id/return-dos", requirePermission("service_cases.write"), addReturnDoRoute);
app.patch("/:id/return-dos/:doId{[0-9]+}", requirePermission("service_cases.write"), patchReturnDoRoute);
app.delete("/:id/return-dos/:doId{[0-9]+}", requirePermission("service_cases.write"), archiveReturnDoRoute);
app.post("/:id/reopen", requirePermission("service_cases.write"), reopenCaseRoute);

app.post("/:id/notes", requireAnyPermission(["service_cases.write", "service_cases.create", "service_cases.manage"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    note: string;
    category?: string;
  }>();
  if (!body.note?.trim()) return c.json({ error: "note is required" }, 400);
  const category = assrNoteCategory(body.category);
  await logActivity(c.env, id, "note", null, null, body.note, userId, {
    category,
    source_channel: "app",
  });
  return c.json({ ok: true });
});


app.post("/:id/notes/:noteId/correct", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const noteId = parseInt(c.req.param("noteId"), 10);
  if (isNaN(id) || isNaN(noteId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ note: string; category?: string }>();
  if (!body.note?.trim()) return c.json({ error: "correction note is required" }, 400);

  const prior = await c.env.DB.prepare(
    `SELECT id FROM assr_activity WHERE id = ? AND assr_id = ?`
  )
    .bind(noteId, id)
    .first<{ id: number }>();
  if (!prior) return c.json({ error: "Referenced entry not found on this case" }, 404);

  await logActivity(c.env, id, "note", null, null, body.note, userId, {
    category: assrNoteCategory(body.category),
    source_channel: "app",
    references_entry_id: noteId,
    is_correction: true,
  });
  return c.json({ ok: true });
});


app.get("/:id/timeline.csv", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

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


const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "mov", "webm", "pdf"]);
const MAX_SIZE = 25 * 1024 * 1024;

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

app.put("/:id/attachments/thumb", requireAnyPermission(["service_cases.write", "service_cases.create", "service_cases.manage"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const key = c.req.query("key") || "";
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
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400",
    },
  });
});


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
  const visLog = (await assrVisibilityScope(c))("ca.");
  const whereSql =
    `WHERE ${where.join(" AND ")}` +
    assrCompanySql(c, "ca.company_id") +
    visLog.sql;
  binds.push(...visLog.binds);

  // company-scope: whereSql above carries assrCompanySql(c, "ca.company_id") for both statements.
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as n
       FROM assr_logistics l
       JOIN assr_cases ca ON ca.id = l.assr_id
      ${whereSql}`
  ).bind(...binds).first<{ n: number }>();

  const offset = (page - 1) * perPage;
  // company-scope: same whereSql (assrCompanySql on ca.company_id).
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
