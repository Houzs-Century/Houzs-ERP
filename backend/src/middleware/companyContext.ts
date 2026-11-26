import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

/**
 * Company-context middleware — Phase 0b of the multi-company merge.
 * Design: docs/2026-07-多公司合并设计.md (locked).
 *
 * Resolves the ACTIVE company for the request and the set of companies the
 * caller is allowed to act in, and stashes them on the Hono context:
 *   c.get('companyId')          — active company (companies.id)
 *   c.get('companyCode')        — active company code ('HOUZS' | '2990')
 *   c.get('allowedCompanyIds')  — companies the caller may see/act in
 *   c.get('companies')          — all active companies (id/code/name)
 *
 * Resolution order for the ACTIVE company:
 *   (a) explicit switcher pick — `X-Company-Id` header (the top-bar company
 *       switcher sends it on every API call), or `?companyId=` query as a
 *       link fallback. Validated against `allowedCompanyIds`; an invalid or
 *       not-allowed pick is IGNORED (falls through to the default), never 403'd.
 *   (b) login hostname default — erp.2990shome.com -> '2990';
 *       erp.houzscentury.com / staging / localhost / anything else -> 'HOUZS'.
 *       ALSO validated against `allowedCompanyIds`: the host's company is used
 *       only when the caller is granted it, else their FIRST allowed company —
 *       never a company they don't hold. A header-less request from a restricted
 *       user must not resolve the host's company just because it asked quietly.
 * The code is then resolved to companies.id.
 *
 * INVARIANT: the active company is ALWAYS one of `allowedCompanyIds` whenever
 * both are set — via (a) or (b), header or no header. Every route that reads
 * `companyId` / `scopeToCompany` / `activeCompanyId` leans on this; the DB
 * client is service-role, so nothing downstream re-checks it.
 *
 * The pick may be a company id (preferred) OR a company code — both are matched
 * so the frontend can send whichever it holds.
 *
 * DEGRADES SAFELY, WITHOUT LEAKING: the companies master is cached
 * last-known-good, so a transient read failure keeps serving the real master
 * rather than collapsing into an unresolved fail-open. If we truly have no
 * master yet (a brand-new isolate whose first read failed), the active company
 * is resolved from the caller's OWN user_companies grants — a single grant
 * resolves even with no header; a multi-grant caller with no header is left with
 * an allow-list but NO active company, which the per-company scoping helpers now
 * treat as FAIL CLOSED (empty), never as "all companies". Only a genuinely
 * single-company / pre-migration state (no master, no grants) keeps the legacy
 * no-op, so single-company Houzs still serves unchanged.
 *
 * MOUNTING: mounted once on the whole authenticated /api/* surface (after auth,
 * before idempotency and every route — see index.ts). This covers both the SCM
 * sub-app and the native raw-SQL modules (sales / finance). Routes without any
 * company table simply never read c.get('companyId'). Pre-auth public routes
 * (/api/auth, /api/track, /api/portal, /api/supplier-portal, /api/survey,
 * /api/mail-center/inbound) are registered before this middleware and are
 * untouched. ASSR raw-SQL scoping is a separate follow-up.
 */

export interface CompanyRow {
  id: number;
  code: string;
  name: string;
}

declare module "hono" {
  interface ContextVariableMap {
    companyId?: number;
    companyCode?: string;
    allowedCompanyIds?: number[];
    companies?: CompanyRow[];
  }
}

export function defaultCompanyCodeForHost(host: string): string {
  const h = host.toLowerCase();
  if (h.includes("2990")) return "2990";
  return "HOUZS";
}

let cache: { at: number; rows: CompanyRow[]; degraded: boolean } | null = null;
let lastGood: CompanyRow[] | null = null;
const TTL_MS = 5 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 1000;

async function loadCompanies(env: Env): Promise<CompanyRow[]> {
  if (cache) {
    const ttl = cache.degraded || cache.rows.length === 0 ? EMPTY_TTL_MS : TTL_MS;
    if (Date.now() - cache.at < ttl) return cache.rows;
  }
  try {
    const res = await env.DB.prepare(
      "SELECT id, code, name FROM companies WHERE is_active = 1 ORDER BY id",
    ).all<{ id: number | string; code: string; name: string }>();
    const rows: CompanyRow[] = (res.results ?? []).map((r) => ({
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
    }));
    cache = { at: Date.now(), rows, degraded: false };
    if (rows.length > 0) lastGood = rows;
    return rows;
  } catch {
    const rows = lastGood ?? [];
    cache = { at: Date.now(), rows, degraded: true };
    return rows;
  }
}

async function queryUserGrants(env: Env, uid: number): Promise<number[]> {
  const res = await env.DB.prepare(
    "SELECT company_id FROM user_companies WHERE user_id = ?",
  )
    .bind(uid)
    .all<{ company_id: number | string }>();
  return (res.results ?? [])
    .map((r) => Number(r.company_id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** TEST-ONLY. Reset the module-level company-master cache + last-known-good so a
 *  middleware test can start from a genuinely cold isolate. Never called in
 *  production code. */
export function __resetCompanyContextCacheForTest(): void {
  cache = null;
  lastGood = null;
}

export const companyContext = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  let companies: CompanyRow[] = [];
  try {
    companies = await loadCompanies(c.env);
  } catch {
  }

  if (companies.length > 0) {
    let allowed = companies.map((co) => co.id);

    if (companies.length > 1) {
      try {
        const uid = Number(
          (c.get("user") as { id?: number | string } | undefined)?.id,
        );
        if (Number.isFinite(uid) && uid > 0) {
          const granted = await queryUserGrants(c.env, uid);
          if (granted.length > 0) {
            const grantSet = new Set(granted);
            allowed = companies
              .filter((co) => grantSet.has(co.id))
              .map((co) => co.id);
          } else {
            allowed = [];
          }
        }
      } catch {
      }
    }

    const rawPick = (c.req.header("X-Company-Id") ?? c.req.query("companyId") ?? "").trim();
    let active: CompanyRow | undefined;
    if (rawPick) {
      const pickId = Number(rawPick);
      active = companies.find(
        (co) =>
          allowed.includes(co.id) &&
          (co.id === pickId || co.code.toLowerCase() === rawPick.toLowerCase()),
      );
    }
    if (!active) {
      const code = defaultCompanyCodeForHost(c.req.header("host") ?? "");
      const pool = companies.filter((co) => allowed.includes(co.id));
      active = pool.find((co) => co.code === code) ?? pool[0];
    }

    c.set("companies", companies);
    c.set("allowedCompanyIds", allowed);
    if (active) {
      c.set("companyId", active.id);
      c.set("companyCode", active.code);
    }
  } else {
    const uid = Number(
      (c.get("user") as { id?: number | string } | undefined)?.id,
    );
    if (Number.isFinite(uid) && uid > 0) {
      try {
        const granted = await queryUserGrants(c.env, uid);
        if (granted.length > 0) {
          c.set("allowedCompanyIds", granted);
          const rawPick = (
            c.req.header("X-Company-Id") ?? c.req.query("companyId") ?? ""
          ).trim();
          const pickId = Number(rawPick);
          let active: number | undefined;
          if (Number.isFinite(pickId) && granted.includes(pickId)) active = pickId;
          else if (granted.length === 1) active = granted[0];
          if (active != null) c.set("companyId", active);
        }
      } catch {
      }
    }
  }

  await next();
});
