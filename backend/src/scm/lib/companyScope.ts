import type { CompanyRow } from "../../middleware/companyContext";

/**
 * Query-scoping helpers for the multi-company merge (Phase 0b).
 * Design: docs/2026-07-多公司合并设计.md. Depends on the company_id column
 * added to 118 tables by migration 0061 + the companyContext middleware.
 *
 * Two patterns, one company_id column:
 *
 *  • PER-COMPANY modules (SO / PO / GRN / PI / DO / SI / inventory / accounting
 *    / catalog / suppliers): the top-bar switcher ISOLATES the two companies'
 *    books. Their list + detail queries call `scopeToCompany(query, c)` to add
 *    `.eq('company_id', <active>)`, and stamp `company_id = <active>` on INSERT
 *    via `activeCompanyId(c)`.
 *
 *  • CROSS-COMPANY VIEW modules (TMS: trips / delivery-planning / fleet): ONE
 *    shared queue across both companies, each row tagged with its company. They
 *    call `scopeToAllowedCompanies(query, c)` to add `.in('company_id',
 *    <allowed>)` (WIDEN, don't isolate) and enrich rows with a company label via
 *    `companyCodeMap(c)` / `withCompanyCode(...)` so the UI can render a company
 *    column. On INSERT they still stamp the ACTIVE company (a trip is created
 *    from whichever company you're currently in; it can still reference the
 *    other company's DOs).
 *
 *  • Service Cases / ASSR was a THIRD pattern — a HOUZS-ONLY pin — until
 *    2026-07-20. It is not one any more: the owner put 2990's service cases on
 *    the merged platform, and ASSR now follows the caller's GRANTED companies
 *    like every other module (`assrCompanySql` in routes/assr.ts is
 *    `allowedCompaniesSql`; the dated decision trail is at routes/assr.ts:113).
 *    This paragraph used to describe the pin as current, and that is not a
 *    harmless staleness: routes/search.ts kept its own copy of the removed pin
 *    and answered the same rep differently from /api/assr until it was found.
 *    `houzsCompanySql` / `houzsCompanyIds` below served that pin and now have NO
 *    caller anywhere in backend/src, frontend/src or the tests.
 *
 * All helpers NO-OP when the active/allowed company is unresolved (companies
 * master absent pre-migration, or a DB cold-start) — so single-company Houzs
 * keeps working unchanged.
 *
 * supabase-js ONLY. Raw `env.DB` SQL paths (e.g. the native ASSR list) can't use
 * these — they must add the company predicate / column by hand. See the raw-SQL
 * checklist in the Phase 0b commit message.
 */

/**
 * What these helpers ACTUALLY need from a context: a `get`. Nothing more.
 *
 * They used to demand a whole `Context<any>`, which quietly made them
 * request-only: a headless job (background scan, agent) has no Hono context, so
 * it could not call them and had to re-implement the three-state sentinel
 * locally instead — see createSalesOrderCore's local `stampCo`. That is a
 * cross-company LEAK waiting to happen, because the local copy is a copy: the
 * sentinel above can be corrected here and the copy keeps the old behaviour,
 * and nothing fails loudly when it does.
 *
 * Widening to the shape actually used lets BOTH a real request and a synthetic
 * headless context scope through this one implementation. Hono's Context
 * satisfies it structurally, so every existing caller is unchanged.
 */
export type CompanyScopeCtx = { get(key: any): any };

export function activeCompanyId(c: CompanyScopeCtx): number | undefined {
  return c.get("companyId") as number | undefined;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRICT flavour — for WRITES that must never act across companies.
   ═══════════════════════════════════════════════════════════════════════════

   The helpers above DEGRADE when the active company is unresolved: no
   predicate, so single-company Houzs kept serving through a pre-migration or
   cold-start window. That is the right trade for a READ. It is the wrong trade
   for a WRITE, where "I don't know which company" degrades to "act on ALL
   companies' rows" — which is how setting your default warehouse came to demote
   the other company's default.

   So writes resolve through requireActiveCompanyId and REFUSE when it is
   unknown. There is deliberately no default and no `?? `: an unresolvable
   company is a condition to surface, never one to guess past. And the company
   id is a REQUIRED positional argument to scopeToCompanyId — not an optional
   field on an options bag — so a caller cannot omit it and silently get
   "every company" (this codebase has pooled Houzs and 2990 data twice for
   exactly that reason). */

export type CompanyScopeRefusal = { error: string; message: string };

/** Plain-language refusal when the active company can't be resolved. Kept SHORT
 *  on purpose: the SCM client discards any server message of 200 characters or
 *  more and falls back to a generic clash line, so a long explanation reaches
 *  the operator as a blank wall. `error` is curated to the same sentence in the
 *  client's ERROR_CODE_MESSAGES, which is read before `message`. */
export const COMPANY_UNRESOLVED: CompanyScopeRefusal = {
  error: "company_unresolved",
  message: "We couldn't tell which company this belongs to. Please refresh and try again.",
};

/** Plain-language refusal when the target document is not this company's. Says
 *  the same thing as "no such document" ON PURPOSE — confirming that someone
 *  else's id exists is itself a leak. */
export const NOT_THIS_COMPANY: CompanyScopeRefusal = {
  error: "not_found_in_company",
  message: "That record isn't available in the company you're working in.",
};

export type RequiredCompany =
  | { ok: true; companyId: number }
  | { ok: false; refusal: CompanyScopeRefusal };

/**
 * Resolve the active company for a WRITE, or refuse. Never degrades, never
 * defaults. Callers: `const co = requireActiveCompanyId(c); if (!co.ok) return
 * c.json(co.refusal, 409);`
 */
export function requireActiveCompanyId(c: CompanyScopeCtx): RequiredCompany {
  const id = Number(activeCompanyId(c));
  if (Number.isInteger(id) && id > 0) return { ok: true, companyId: id };
  return { ok: false, refusal: COMPANY_UNRESOLVED };
}

/**
 * PER-COMPANY, STRICT: filter a supabase-js query to one company. The id is a
 * required argument, so there is no "unresolved" branch to fall through — get
 * it from requireActiveCompanyId first.
 */
export function scopeToCompanyId<Q>(query: Q, companyId: number): Q {
  return (query as unknown as { eq(col: string, val: unknown): Q }).eq("company_id", companyId);
}

/**
 * THE ALLOW-LIST SENTINEL — three states, never two. Read this before touching
 * any consumer; collapsing the first two together is a cross-company LEAK, and
 * collapsing the last two together is an app-wide EMPTY-LIST outage.
 *
 *  • `undefined` = UNRESOLVED. companyContext never set the var because the
 *    companies master isn't readable (pre-migration / D1 test mirror /
 *    Hyperdrive cold-start). Consumers MUST degrade: no company predicate at
 *    all, so single-company Houzs serves unchanged. Load-bearing — do NOT
 *    "simplify" this to [].
 *
 *  • `[]` = RESOLVED, and the caller is granted NO active company: they hold
 *    `user_companies` grants, but every one of them points at a company that is
 *    no longer `is_active = 1`. Consumers MUST filter to NOTHING (empty lists).
 *    Never fail open here — the DB client is service-role (RLS bypassed), so
 *    these predicates ARE the isolation boundary.
 *
 *  • non-empty = the caller's granted companies. Note this is ALSO the state for
 *    a user with NO grants at all: companyContext FAILS OPEN to every active
 *    company, so an unrestricted user is always non-empty and never touches the
 *    `[]` branch. "Has no grants" and "has grants, none usable" are different.
 *
 * Returns a validated copy (positive integers only), so consumers can inline the
 * ids into raw SQL without re-checking — they come from OUR companies master.
 */
export function allowedCompanyIds(c: CompanyScopeCtx): number[] | undefined {
  const raw = c.get("allowedCompanyIds") as number[] | undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** True ONLY in the middle state above: the company context resolved, and the
 *  caller is granted no active company. Lets the PER-COMPANY helpers tell a
 *  missing active company that means "degrade" (unresolved) from one that means
 *  "this caller may see nothing". */
export function isRestrictedToNoCompany(c: CompanyScopeCtx): boolean {
  const ids = allowedCompanyIds(c);
  return ids !== undefined && ids.length === 0;
}

/**
 * CROSS-COMPANY, raw env.DB SQL flavour of scopeToAllowedCompanies. Returns a
 * ready-to-interpolate ` AND <col> IN (1,2)` fragment limited to the caller's
 * allowed companies, or "" when the allow-list is unresolved (companies master
 * absent pre-migration / D1 test mirror / cold-start) so legacy single-company
 * SQL runs unchanged. The ids come from OUR companies master via the
 * middleware and are re-validated as positive integers here, so inlining them
 * (no binds) is safe — which keeps the many stat queries that already
 * interpolate computed fragments readable.
 */
export function allowedCompaniesSql(c: CompanyScopeCtx, col = "company_id"): string {
  const ids = allowedCompanyIds(c);
  // UNRESOLVED → no predicate (legacy single-company SQL runs unchanged).
  if (ids === undefined) return "";
  // RESTRICTED TO NOTHING → a predicate that matches nothing. `1=0` (not
  // `false`) so the fragment stays valid on the D1/SQLite test mirror too.
  if (ids.length === 0) return ` AND 1=0`;
  return ` AND ${col} IN (${ids.join(",")})`;
}

/**
 * PER-COMPANY, raw env.DB SQL flavour of scopeToCompany. Returns a
 * ready-to-interpolate ` AND <col> = <active>` fragment, or "" when the active
 * company is unresolved (pre-migration / D1 test mirror / cold-start) so
 * legacy single-company SQL runs unchanged. Same inline-not-bind rationale as
 * allowedCompaniesSql above: the id comes from OUR companies master and is
 * re-validated as a positive integer here.
 */
export function activeCompanySql(c: CompanyScopeCtx, col = "company_id"): string {
  const id = Number(activeCompanyId(c));
  if (Number.isInteger(id) && id > 0) return ` AND ${col} = ${id}`;
  // No active company. FAIL CLOSED whenever the context is RESOLVED
  // (allowedCompanyIds is set) but no single active company could be picked —
  // the RESTRICTED-TO-NOTHING `[]` state AND a multi-company caller with no
  // usable switcher header during a companies-master blip (allowedCompanyIds
  // set, companyId unset). Kept in lock-step with scopeToCompany; if the two
  // ever disagree that is the same bug class again. Only the genuinely
  // UNRESOLVED / legacy state (allowedCompanyIds === undefined) degrades to no
  // predicate, so a single-company install is never blanked.
  if (allowedCompanyIds(c) !== undefined) return ` AND 1=0`;
  return "";
}

/** A parameterised company predicate for a table keyed by company CODE. */
export interface CompanyCodePredicate {
  /** ` AND (...)` fragment to append to a WHERE, or "" to degrade. */
  sql: string;
  /** The values for the `?` placeholders in `sql`, in order. */
  binds: string[];
}

/**
 * PER-COMPANY for a table whose company column is the company CODE (text), not
 * the numeric company_id — today that is `email_outbox.company_code` (mig 0094)
 * and nothing else.
 *
 * BINDS, NOT INLINE. Every other raw-SQL helper here interpolates because it is
 * interpolating VALIDATED INTEGERS. A company CODE is a string, and a string
 * that reaches SQL by interpolation is a habit this file should not teach even
 * once, so this one returns its values to be bound.
 *
 * THREE THINGS THE COLUMN ACTUALLY HOLDS, all of which had to be handled for
 * the predicate to be a filter rather than a blanker. Read before simplifying:
 *
 *  1. The CODE ('HOUZS' / '2990'). What sendEmail is documented to store, and
 *     what the security-critical rows carry: routes/auth.ts:374 (member_invite)
 *     and :448 (password_reset) both pass defaultCompanyCodeForHost(...).
 *  2. NULL. Most senders never pass companyCode at all (services/assrAlerts.ts,
 *     services/projectReminders.ts, services/clientErrors.ts,
 *     services/assrEscalation.ts, routes/settings.ts), so the column falls to
 *     NULL. Migration 0094 defines that state: "NULL = legacy row -> HOUZS
 *     identity", and the cron drain (services/email.ts:458) resolves it exactly
 *     that way. So the BASE company owns the NULL rows — attributing them
 *     anywhere else would be inventing a fact the drain contradicts.
 *  3. The company_id AS TEXT. scm/lib/do-email.ts:180 and
 *     scm/routes/mfg-purchase-orders.ts:4288 both pass
 *     `String(row.company_id)`, i.e. "1" / "2", into a column that wants a
 *     code. That is a real defect in its own right (it makes those emails'
 *     From display name the bare number — see the BUG-HISTORY entry) and it is
 *     NOT this helper's job to fix, but a predicate that ignored it would hide
 *     every DO and PO email from BOTH companies' outbox rather than scope it.
 *     So the ACTIVE company's own id-as-text is accepted alongside its code.
 *
 * The id-as-text alternative is dropped if any OTHER company's CODE is that
 * same literal — a company literally coded "2" must not be reachable from the
 * company whose id is 2. Impossible today ('HOUZS'/'2990'); cheap to hold.
 */
export function activeCompanyCodePred(
  c: CompanyScopeCtx,
  col = "company_code",
): CompanyCodePredicate {
  // UNRESOLVED (pre-migration / D1 test mirror / cold-start) → no predicate, so
  // single-company Houzs serves unchanged. Same first branch as activeCompanySql.
  if (allowedCompanyIds(c) === undefined) return { sql: "", binds: [] };

  const id = Number(activeCompanyId(c));
  const hasId = Number.isInteger(id) && id > 0;
  const code = c.get("companyCode") as string | undefined;

  const values: string[] = [];
  if (typeof code === "string" && code.trim()) values.push(code.trim());
  if (hasId) {
    const others = ((c.get("companies") as CompanyRow[] | undefined) ?? []).filter(
      (r) => Number(r.id) !== id,
    );
    if (!others.some((r) => String(r.code) === String(id))) values.push(String(id));
  }

  // RESOLVED but nothing to match on — the RESTRICTED-TO-NOTHING `[]` state, or
  // a multi-company caller with no usable switcher header during a master blip.
  // FAIL CLOSED, exactly as activeCompanySql does.
  if (values.length === 0) return { sql: " AND 1=0", binds: [] };

  const base = houzsCompanyId(c);
  const ownsNull = base != null && hasId && base === id;
  const inList = values.map(() => "?").join(", ");
  return {
    sql: ownsNull
      ? ` AND (${col} IN (${inList}) OR ${col} IS NULL)`
      : ` AND ${col} IN (${inList})`,
    binds: values,
  };
}

/**
 * THE BASE COMPANY, resolved from `companies.code === 'HOUZS'` on context — no
 * hardcoded id (the bigint differs across staging/prod).
 *
 * This used to be documented as the "HOUZS-ONLY PIN (Service Cases / ASSR)".
 * THAT PIN NO LONGER EXISTS — the owner moved 2990's service cases onto the
 * merged platform on 2026-07-20 and ASSR now scopes to the caller's granted
 * companies (routes/assr.ts:113 carries the dated trail). Do not reintroduce it
 * from this comment; that is exactly how routes/search.ts came to answer a rep
 * differently from /api/assr.
 *
 * What still uses it: `assrCreateCompanyId` (routes/assr.ts:157) as the FALLBACK
 * when no active company resolves, routes/assr.ts:1300, and scm/routes/staff.ts
 * for attributing the unlinked mirror rows. All three want "the base company",
 * not a pin.
 *
 * Returns the resolved id, or undefined when the companies master is unresolved
 * (pre-migration / cold-start).
 */
export function houzsCompanyId(c: CompanyScopeCtx): number | undefined {
  const rows = (c.get("companies") as CompanyRow[] | undefined) ?? [];
  const houzs = rows.find((r) => r.code === "HOUZS");
  return houzs?.id != null ? Number(houzs.id) : undefined;
}

/**
 * MIRROR-SOURCE PIN — the company code the 2990 system mirrors from. Resolved
 * from `companies.code === '2990'` (MIRRORED_COMPANY_CODE), never hardcoded: the
 * bigint id differs across staging/prod. Used to attribute the UNLINKED (frozen
 * 2990 import / live staff-mirror) scm.staff rows to 2990 in the salesperson
 * picker — those rows carry no company_id and no user_id, so grant derivation
 * cannot reach them. undefined when the master lacks a 2990 row (single-company
 * Houzs), which makes those rows resolve to no company → hidden (fail closed).
 */
export function mirrorCompanyId(c: CompanyScopeCtx): number | undefined {
  const rows = (c.get("companies") as CompanyRow[] | undefined) ?? [];
  const m = rows.find((r) => r.code === MIRRORED_COMPANY_CODE);
  return m?.id != null ? Number(m.id) : undefined;
}

/** houzsCompanyIds — the array flavour, for a callee that takes an id list.
 *  `[houzsId]` when resolved, else `undefined` — NOT `[]` — so the callee
 *  degrades to single-company (no predicate). It feeds the SAME sinks as
 *  allowedCompanyIds, where `[]` means "restricted to nothing / match nothing".
 *
 *  NO CALLER as of 2026-08-13. Its one consumer was the ASSR list/export
 *  `allowed_company_ids` param under the HOUZS-only pin removed on 2026-07-20;
 *  routes/assr.ts now passes `allowedCompanyIds`. Kept, not deleted, because the
 *  companion `houzsCompanyId` is live and the pair reads as one idea — but do
 *  not wire this back in on the strength of its name. */
export function houzsCompanyIds(c: CompanyScopeCtx): number[] | undefined {
  const id = houzsCompanyId(c);
  return id != null ? [id] : undefined;
}

/** Raw env.DB SQL fragment pinning a query to HOUZS: ` AND <col> = <houzsId>`,
 *  or "" when HOUZS is unresolved (pre-migration / cold-start) so legacy
 *  single-company SQL runs unchanged. Same inline-not-bind safety as
 *  allowedCompaniesSql — the id comes from OUR companies master, re-validated
 *  as a positive integer here.
 *
 *  NO CALLER as of 2026-08-13, and reaching for it is almost certainly a
 *  mistake: its only consumers were the ASSR readers, and the HOUZS-only pin
 *  they implemented was REVERSED by the owner on 2026-07-20 (routes/assr.ts:113).
 *  A module that pins to one company rather than scoping to the caller's granted
 *  set shows a rep the wrong company's book — which is the bug this repo already
 *  paid for once in routes/search.ts. */
export function houzsCompanySql(c: CompanyScopeCtx, col = "company_id"): string {
  const id = Number(houzsCompanyId(c));
  if (!Number.isInteger(id) || id <= 0) return "";
  return ` AND ${col} = ${id}`;
}

/** id -> code map for tagging cross-company rows with a readable company. */
export function companyCodeMap(c: CompanyScopeCtx): Map<number, string> {
  const rows = (c.get("companies") as CompanyRow[] | undefined) ?? [];
  return new Map(rows.map((r) => [r.id, r.code]));
}

/**
 * PER-COMPANY: filter a supabase-js query to the active company. No-op when the
 * active company is unresolved. Returns the builder so the caller can keep
 * chaining (.order / .eq / .maybeSingle / ...).
 */
export function scopeToCompany<Q>(query: Q, c: CompanyScopeCtx): Q {
  const id = activeCompanyId(c);
  if (id != null) {
    return (query as unknown as { eq(col: string, val: unknown): Q }).eq("company_id", id);
  }
  // No active company resolved. FAIL CLOSED whenever the company context is
  // RESOLVED (allowedCompanyIds is set) but no single active company could be
  // picked — both the RESTRICTED-TO-NOTHING `[]` state and a multi-company
  // caller whose switcher header didn't arrive during a companies-master blip
  // (allowedCompanyIds set, companyId unset). Serving every company's rows here
  // is the cross-company READ leak this guard exists to prevent; an empty list
  // self-heals within one request. FAIL OPEN only in the genuinely UNRESOLVED /
  // legacy state (allowedCompanyIds === undefined: pre-migration, or a brand-new
  // isolate that has never read the master), so a single-company install is
  // never blanked.
  if (allowedCompanyIds(c) !== undefined) {
    return (query as unknown as { in(col: string, vals: number[]): Q }).in("company_id", []);
  }
  return query;
}

/**
 * CROSS-COMPANY: widen a supabase-js query to every company the caller may see.
 * No-op when the allow-list is empty (unresolved). Returns the builder for
 * further chaining.
 */
export function scopeToAllowedCompanies<Q>(query: Q, c: CompanyScopeCtx): Q {
  const ids = allowedCompanyIds(c);
  // UNRESOLVED → no filter. Otherwise `.in` the resolved set — which for the
  // RESTRICTED-TO-NOTHING state is an empty list, and an empty `in` matches no
  // rows. Same three-state contract as allowedCompaniesSql; if these two ever
  // disagree, that is the same bug class again.
  if (ids === undefined) return query;
  return (query as unknown as { in(col: string, vals: number[]): Q }).in("company_id", ids);
}

/* ═══════════════════════════════════════════════════════════════════════════
   CROSS-COMPANY DETAIL MISS — turn a per-company by-id miss into an HONEST answer.
   ═══════════════════════════════════════════════════════════════════════════

   A PER-COMPANY detail route (scopeToCompany + .maybeSingle) returns nothing for
   BOTH "no such row anywhere" AND "the row is in another company". Those are two
   very different facts, and conflating them is the supplier-404 the owner kept
   hitting (2026-07-24): a multi-company user reaches a detail by a bookmark, a
   second window, or a link that carries the id but not the company, and the bare
   `{ error: 'not_found' }` renders as the alarming "That item could no longer be
   found — it may have been changed or removed." The record is right there; it is
   simply in the company they are not currently switched to.

   detailMissResponse re-looks-up the id WIDENED to the caller's ALLOWED companies
   (via scopeToAllowedCompanies — never beyond, so a company-1-only user still gets
   a plain not_found for a company-2 row and NOTHING leaks). When it resolves in
   another allowed company, it returns an `in_other_company` body naming that
   company so the UI can offer to switch, instead of implying the record is gone.

   Deliberately NOT registered in the SCM client's ERROR_CODE_MESSAGES: that map is
   consulted first and REPLACES the server message (authed-fetch humanApiError),
   which would throw away the company name. Falling through to the plain-sentence
   `message` below keeps it. The message is kept < 200 chars, no leading `{`, and
   free of the internals the plain-sentence filter rejects. */
export const IN_OTHER_COMPANY = "in_other_company";

export type DetailMiss =
  | { error: "not_found" }
  | { error: "in_other_company"; companyId: number; companyCode: string | null; message: string };

/**
 * Resolve a per-company detail miss into either a plain not_found or a calm
 * cross-company hint. `probe` MUST be a FRESH supabase-js builder that selects
 * `company_id` for the SAME row the scoped lookup just missed, e.g.
 * `supabase.from('suppliers').select('company_id').eq('id', id)` — this helper
 * widens it to the allowed set and reads company_id. `noun` names the record in
 * the operator-facing sentence ('supplier', 'purchase order', ...).
 */
export async function detailMissResponse<Q>(
  c: CompanyScopeCtx,
  probe: Q,
  noun = "record",
): Promise<DetailMiss> {
  const widened = scopeToAllowedCompanies(probe, c) as unknown as {
    maybeSingle(): Promise<{ data: { company_id?: number | null } | null }>;
  };
  const { data } = await widened.maybeSingle();
  const cid = data?.company_id != null ? Number(data.company_id) : null;
  const active = activeCompanyId(c);
  if (cid != null && Number.isInteger(cid) && active != null && cid !== Number(active)) {
    const code = companyCodeMap(c).get(cid) ?? null;
    const where = code ?? "another company";
    return {
      error: IN_OTHER_COMPANY,
      companyId: cid,
      companyCode: code,
      message: `This ${noun} belongs to ${where}. Switch to ${where} using the company selector at the top to open it.`,
    };
  }
  return { error: "not_found" };
}

/**
 * Stamp the active company on rows about to be INSERTed. Every row gets
 * `company_id = <active>` unless it already carries one (explicit wins). No-op
 * when the active company is unresolved (pre-migration / cold-start) so
 * single-company Houzs keeps inserting unchanged. Use for child/line/payment
 * array inserts (`.insert(stampCompany(rows, c))`); for a single object literal
 * add `company_id: activeCompanyId(c)` inline instead.
 */
export function stampCompany<T extends Record<string, unknown>>(
  rows: T[],
  c: CompanyScopeCtx,
): Array<T & { company_id?: number }> {
  const id = activeCompanyId(c);
  if (id == null) return rows;
  return rows.map((r) => ({ company_id: id, ...r }));
}

/** Tag one row (which carries company_id) with a readable `company_code`. */
export function withCompanyCode<T extends Record<string, unknown>>(
  row: T,
  codes: Map<number, string>,
): T & { company_code: string | null } {
  const cid = row["company_id"];
  const code = cid != null ? codes.get(Number(cid)) ?? null : null;
  return { ...row, company_code: code };
}

/** The doc-number prefix each company mints under.
 *
 *  HOUZS is NOT its bare company code (owner 2026-08-07): its documents used to
 *  carry no prefix at all, which read as anonymous next to `2990-DO-2608-001`.
 *  `HC-` is the house code the owner chose. Every other company keeps `<CODE>-`.
 */
export const BASE_COMPANY_CODE = "HOUZS";
const DOC_PREFIX_BY_COMPANY: Record<string, string> = {
  [BASE_COMPANY_CODE]: "HC-",
};

/**
 * PER-COMPANY DOC-NUMBER PREFIX (Phase 0d). Every company prefixes its doc
 * numbers — HOUZS with `HC-` (e.g. `HC-SO-2608-001`), everyone else with their
 * own code (e.g. `2990-SO-2608-001`). The prefix alone keeps the companies'
 * monthly sequences from colliding on the GLOBAL unique doc_no index — no
 * per-company unique constraint (no migration) needed, because a minter's
 * `.like('HC-SO-2608-%')` fetch never matches `2990-SO-2608-...`, so each
 * company reads/advances only its own max+1.
 *
 * HOUZS minted BARE numbers until 2026-08-07 (`SO-2607-001`). Those documents
 * keep their numbers — renaming a live doc number would orphan every reference
 * to it, in this system and in the customer's. The two shapes therefore coexist
 * permanently, and the monthly counter for `HC-` starts from 1 in the month the
 * change lands, because `.like('HC-SO-2608-%')` matches none of the old ones.
 * That is a deliberate, one-off discontinuity, not a collision.
 *
 * Use at every PER-COMPANY minter: fold it into the month prefix passed to BOTH
 * the `.like(...)` fetch AND `nextMonthlyDocNo(...)` so they agree, e.g.
 * `const p = companyDocPrefix(c); ... .like(col, ${p}SO-${yymm}-%)` and
 * `nextMonthlyDocNo(${p}SO-${yymm}, existing)`. Do NOT apply to CROSS-COMPANY
 * shared docs (trips / delivery-planning) — those keep one shared sequence.
 */
export function companyDocPrefix(c: CompanyScopeCtx): string {
  const code = c.get("companyCode");
  /* A non-string (a whole company object leaking in from a reconstructed
     context — as the scan background job did, minting
     "[object Object]-SO-2607-001") degrades to the BASE company's prefix. It
     used to degrade to "", which was the base company's prefix at the time;
     now that HOUZS mints `HC-`, returning "" would invent a THIRD numbering
     shape belonging to no company. */
  if (typeof code !== "string" || !code) return docPrefixForCode(BASE_COMPANY_CODE);
  return docPrefixForCode(code);
}

/** The prefix for a company CODE, for callers that hold the code rather than a
 *  request context (the Delivery-Planning convert mints under the SOURCE SO's
 *  company, not the active one). */
export function docPrefixForCode(code: string): string {
  const upper = code.trim().toUpperCase();
  return DOC_PREFIX_BY_COMPANY[upper] ?? `${upper}-`;
}

/**
 * MIRRORED-SYSTEM OWNERSHIP — 2990 owns what 2990 originates.
 *
 * routes/so-mirror.ts is a LIVE one-way receiver: every 2990 outbox drain
 * re-applies that SO's current 2990 state — it upserts the header
 * `ON CONFLICT (doc_no) DO UPDATE` and DELETE-then-INSERTs the whole item and
 * payment set. So a Houzs-side write to a mirrored SO is reverted within
 * seconds, with no error, no conflict and no alarm: the drift sentinel counts
 * rows, and delete-then-reinsert leaves the row count unchanged. Houzs is not
 * the writer of these records and must refuse to act like one.
 *
 * The authoritative marker is the DOC-NUMBER PREFIX, not company_id:
 *
 *  • so-mirror.ts prefixDoc() stamps `2990-` on every mirrored doc number
 *    unconditionally, so no mirrored row can lack it.
 *
 *  • company_id alone is NOT sufficient, and the difference is reachable: the
 *    headless scan job (createDraftSalesOrder) reaches createSalesOrderCore
 *    through a reconstructed context that carries companyId but NOT
 *    companyCode, so it stamps the 2990 company_id while companyDocPrefix
 *    above falls back to the BASE company's `HC-` prefix. That SO is
 *    Houzs-native and Houzs MUST stay able to write it.
 *
 *    This clause used to say the fallback was "BARE numbering". That was true
 *    until 2026-08-07, when HOUZS stopped minting bare numbers and took `HC-`;
 *    companyDocPrefix now returns docPrefixForCode(BASE_COMPANY_CODE), and
 *    companyScope.test.ts asserts exactly that for an unresolved code. The
 *    CONCLUSION is unchanged — `HC-` is not `2990-`, so isMirroredDocNo stays
 *    false and the guard still lets Houzs write its own SO — but the stated
 *    mechanism was describing a shape the code no longer mints.
 *
 *  • the prefix needs no companies-master lookup, so a guard built on it works
 *    in a reconstructed context and in a library called without a Context —
 *    exactly where a company_id lookup would silently no-op.
 */
export const MIRRORED_COMPANY_CODE = "2990";

/** True for a document number minted by the mirrored system (see above). */
export function isMirroredDocNo(docNo: unknown): boolean {
  return typeof docNo === "string" && docNo.startsWith(`${MIRRORED_COMPANY_CODE}-`);
}

/**
 * THE CUTOVER FLIP SWITCH. Default (unset / not "true") = pre-flip: 2990 is the
 * WRITER of its own `2990-` namespace and Houzs holds a READ-ONLY mirror, so the
 * mirror guards below refuse Houzs-side creates/edits of `2990-` documents. When
 * Houzs TAKES OVER as the writer (2990's apps/api retired), set
 * `HOUZS_OWNS_2990="true"` in wrangler.toml [vars] — the guards stop blocking and
 * the repointed POS writes `2990-` SOs natively.
 *
 * ⚠️ MUST be flipped to "true" IN THE SAME DEPLOY as the POS
 * `VITE_BACKEND_TARGET=houzs` flip (cutover runbook, task #15). IsMirrored/create
 * guards are hardcoded on the `2990-`/company-2 identity; if this stays false
 * while the POS repoints, the tablet gets a 409 (so_owned_by_2990 /
 * so_create_blocked_2990) on its FIRST order — a day-one order-path outage, not a
 * staleness window. Before flipping, DRAIN the 2990 SO outbox fully (doc-number
 * continuity) and stop 2990's minter/crons so the two systems can't both mint.
 * Gates the block conditions only — isMirroredDocNo itself stays a pure prefix
 * test (display / dispatch code still needs to know a doc's origin).
 */
export function houzsOwns2990(env: { HOUZS_OWNS_2990?: string } | undefined | null): boolean {
  return env?.HOUZS_OWNS_2990 === "true";
}

/**
 * True when THIS request's minters would mint into the mirrored system's
 * doc-number namespace. Derived from companyDocPrefix so the guard and the
 * minters read one rule and cannot drift apart.
 *
 * Why minting there is unsafe: a minter's `.like('2990-SO-2607-%')` fetch reads
 * the MIRRORED rows — which are a copy of 2990's own set — so max+1 returns the
 * exact number 2990's own minter will hand out next. The collision is not a
 * race, it is a certainty, and the mirror's upsert then overwrites the
 * Houzs-native order in place.
 */
export function mintsIntoMirroredNamespace(c: CompanyScopeCtx): boolean {
  return companyDocPrefix(c) === `${MIRRORED_COMPANY_CODE}-`;
}

/** One wording for the read-only refusal, so every writer refuses identically.
 *  Plain language: the reader is a salesperson, not an engineer. The `error`
 *  code is curated to the same sentence in the SCM client's ERROR_CODE_MESSAGES
 *  (frontend/src/vendor/scm/lib/authed-fetch.ts), which reads `error` before
 *  `message` — a code with no entry there would surface to the operator raw. */
export const MIRRORED_SO_READONLY: { error: string; message: string } = {
  error: "so_owned_by_2990",
  message:
    "This order belongs to 2990 and can only be changed in 2990. Any change made here would be undone automatically.",
};

/** One wording for the create refusal (see mintsIntoMirroredNamespace). */
export const MIRRORED_SO_CREATE_BLOCKED: { error: string; message: string } = {
  error: "so_create_blocked_2990",
  message:
    "New orders for 2990 have to be created in 2990. An order created here would take a number 2990 is about to use, and would be overwritten.",
};

/**
 * CROSS-COMPANY CONVERSION GUARD — THE OLDER OF THE TWO MECHANISMS.
 *
 * READ THIS FIRST: since 2026-08-13 the standard way to hold "a conversion never
 * crosses a company" is to SCOPE THE SOURCE LOAD, not to compare companies after
 * loading it unscoped. A converter reads its source through `scopeToCompany` /
 * `scopeToCompanyId`, so another company's document is not visible to it and
 * there is nothing left to compare. `scripts/check-conversion-guards.mjs` asserts
 * that per route, against a registry naming which document is the source.
 *
 * The shape this function was written for: load a SOURCE document by id/doc_no
 * with NO company predicate, then INSERT a new document stamped
 * `company_id: activeCompanyId(c)`. The DB client is service-role, so nothing
 * else re-checks it. That combination silently RE-COMPANIES the document:
 * convert a 2990 sales order while the switcher says Houzs and you get a HOUZS
 * delivery order — Houzs doc number, Houzs company_id — which then posts the
 * stock movement, the invoice revenue and the commission against Houzs' books
 * for an order Houzs never sold. The source row legitimately exists in this
 * database (the one-way 2990 SO mirror puts it there); what must not happen is
 * Houzs claiming it as its own document.
 *
 * WHY SCOPING WON. Both mechanisms give the same answer. The difference is what
 * happens when someone forgets: a missing comparison leaves a handler that reads
 * perfectly well and re-companies money, while a missing predicate leaves an
 * empty result. Seven of eleven conversions had no comparison at all when this
 * was audited, and nothing in the code said which seven.
 *
 * WHERE THIS FUNCTION IS STILL RIGHT, and it is not a leftover: the BARE-CREATE
 * paths — `POST /` on delivery-returns, grns, purchase-consignment-receives,
 * purchase-consignment-returns, purchase-invoices, purchase-returns,
 * sales-invoices. There the source document is an OPTIONAL body field on a route
 * that also serves manual, source-less documents, and the ids arrive from two
 * places at once (a header field and each line's link). There is no single
 * source read to scope, so the comparison is the mechanism. Those callers are
 * the reason this stays.
 *
 * THE THIRD RULE IS REAL AND IT SURVIVED — read this before "fixing" the route
 * it names, because two people have now broken it in one day.
 *
 * INHERIT is correct where the destination stamps the SOURCE's company.
 * `POST /from-sos` in delivery-orders-mfg.ts is that path: the shared Delivery
 * Planning queue, where a 2990 SO converts into a 2990 DO under 2990's document
 * prefix. It crosses the switcher ON PURPOSE, and it keeps the books straight
 * because the destination never CLAIMS the document — it takes the source's
 * company, its prefix, and (since 2026-08-13) its warehouse and stock lines too.
 * That last part was the real defect there: the header inherited while the LINES
 * stamped the active company, so a 2990 DO deducted HOUZS stock.
 *
 * On 2026-08-13 that route was broken TWICE by people who did not read this
 * paragraph — once by adding a crossCompanySourceRefusal (which killed the
 * feature outright), once by scoping its source reads to the active company
 * (which killed it structurally, since the dispatcher can then no longer SEE the
 * 2990 SO). The owner confirmed the design; both were reverted.
 * `scripts/check-conversion-guards.mjs` now carries an INHERIT kind that fails
 * if either mistake comes back, so this is enforced and not merely asked for.
 *
 * The distinction that decides which rule applies is one question: does the
 * destination stamp the SOURCE's company, or the ACTIVE one? Inherit is safe;
 * claiming is re-parenting.
 *
 * UNRESOLVED (no active company — pre-migration / cold-start) and a source row
 * with a NULL company_id both DEGRADE to allowed, matching the three-state
 * sentinel on allowedCompanyIds: single-company Houzs must keep converting
 * unchanged. Only a source company that is RESOLVED and DIFFERENT is refused.
 */
export function isCrossCompanySource(
  sourceCompanyId: unknown,
  c: CompanyScopeCtx,
): boolean {
  const active = activeCompanyId(c);
  if (active == null) return false; // unresolved -> degrade, as everywhere else
  if (sourceCompanyId == null) return false; // pre-migration row -> degrade
  const src = Number(sourceCompanyId);
  if (!Number.isInteger(src) || src <= 0) return false;
  return src !== Number(active);
}

/**
 * The refusal payload for a blocked cross-company conversion. Names the source
 * document and both companies, because the operator's next question is always
 * "which one am I in?" — a bare "not allowed" sends them to IT.
 *
 * DELIBERATELY NOT registered in the SCM client's ERROR_CODE_MESSAGES, unlike
 * the two mirrored-SO refusals above. That map is consulted FIRST and its hit
 * REPLACES the server message (authed-fetch.ts:366) — a static entry there
 * would throw away the doc number and the two company names, which are the only
 * parts that tell the operator what to actually do. Falling through to the
 * server `message` keeps them.
 *
 * The cost of that choice is that the message must survive the plain-sentence
 * filter one step further down: under 200 characters, no leading `{`, and none
 * of `violates|constraint|null value|column|relation|syntax|PGRST|error_code`
 * or a bare 5-digit number. Exceed 200 and the operator silently gets the
 * generic "That clashes with something already in the system" 409 instead —
 * which is precisely the blank-wall outcome this refusal exists to avoid. Keep
 * it short; the structured fields below carry the detail for the UI.
 */
export function crossCompanyConversionBlocked(
  sourceDocNo: string | null | undefined,
  sourceCompanyId: unknown,
  c: CompanyScopeCtx,
): { error: string; message: string; sourceDocNo: string | null; sourceCompany: string | null; activeCompany: string | null } {
  const codes = companyCodeMap(c);
  const srcCode = sourceCompanyId != null ? codes.get(Number(sourceCompanyId)) ?? null : null;
  const activeCode = (c.get("companyCode") as string | undefined) ?? null;
  const doc = sourceDocNo ? String(sourceDocNo) : null;
  return {
    error: "cross_company_conversion_blocked",
    message:
      `${doc ?? "That document"} belongs to ${srcCode ?? "another company"}` +
      `, but you are working in ${activeCode ?? "a different company"}. ` +
      `Switch company using the selector at the top, then convert it there.`,
    sourceDocNo: doc,
    sourceCompany: srcCode,
    activeCompany: activeCode,
  };
}

/**
 * THE CONVERSION RULE, in one place. A document conversion never crosses a
 * company boundary.
 *
 * Load the source documents this conversion names, and return a refusal for the
 * FIRST one that belongs to another company. Null means every referenced source
 * is in the active company (or the company is unresolved, which degrades to
 * allowed exactly like every other helper in this file).
 *
 * WHO STILL CALLS IT. The BARE-CREATE paths, and nothing else. A declared
 * converter (`/from-x`, `/convert-from-x`) scopes its source read instead — see
 * the note on isCrossCompanySource above — so a refusal on one of those can
 * never fire and is dead code that looks like protection. If you are adding this
 * call to a `/from-x` route, scope the read instead.
 *
 *   · `POST /` on delivery-returns, grns, purchase-consignment-receives,
 *     purchase-consignment-returns, purchase-invoices, purchase-returns,
 *     sales-invoices — the source is an optional body field on a route that also
 *     serves manual, source-less documents, and the ids arrive from two places
 *     at once (a header field and each line's link), so there is no single
 *     source read to scope.
 *
 * purchase-returns.ts `/from-grns` + `/from-grn` were the last pair left on the
 * refusal, the file having been held by concurrent work during the 2026-08-13
 * sweep. Both were converted the same day; check-conversion-guards.mjs now
 * carries no legacyRefusal entry at all.
 *
 * WHY IT EXISTS AS A SHARED PRIMITIVE. Before 2026-08-13 this exact rule was
 * written THREE different ways: inline in some handlers, as a file-local
 * `firstCrossCompanyPo` in grns.ts, and as a file-local
 * `crossCompanyDoSourceBlocked` in delivery-returns.ts. Eleven conversions
 * existed; four were guarded and SEVEN WERE NOT, and nothing in the code said
 * which was which — not to a reader, and not to any scanner, because each copy
 * had its own name. The seven gaps let a 2990 delivery be folded into a Houzs
 * invoice, a 2990 SO mint a HOUZS purchase order, and stock be drawn out of one
 * company's warehouse under the other's refund.
 *
 * Collapsing three copies into one name is what made the NEXT step possible:
 * once the rule had one name it could be counted, and counting it is what showed
 * that a comparison anyone can forget was the wrong mechanism for it.
 *
 * FAILS CLOSED on a read error. If we cannot prove the source belongs here, we
 * do not convert it: unlike a read, a conversion MOVES money, so "unknown" must
 * not resolve to "allowed". This is deliberately stricter than the rest of the
 * file, which degrades open — and the difference is the point.
 *
 * ALSO GUARDS SOURCE **LINES**, not just source headers — pass `null` for
 * docNoColumn. The header-level guard turned out to be only half the rule: on
 * the purchase side the caller supplies a source LINE id per item
 * (`purchaseOrderItemId` / `grnItemId` / `pcOrderItemId` / `pcReceiveItemId`)
 * and the rollup writers address it as `.eq('id', <bodyId>)` with no predicate
 * at all, so eight handlers proved the HEADER and then wrote `received_qty` /
 * `invoiced_qty` / `returned_qty` onto whichever company owned the LINE. Every
 * one of those line tables carries a NOT NULL `company_id` (migs 0083 / 0090),
 * so the same rule applies unchanged — it simply had nothing to name, because a
 * line has no document number of its own. `null` makes the refusal say "That
 * document", which is what an operator can act on; passing the line's UUID as
 * the doc number would be worse than saying nothing.
 *
 * @param table       the source table, e.g. 'purchase_orders'
 * @param idColumn    its primary key, e.g. 'id'
 * @param docNoColumn the human document number to NAME in the refusal — an
 *                    operator cannot act on a uuid. `null` for a LINE table,
 *                    which has no such column.
 */
export async function crossCompanySourceRefusal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  c: CompanyScopeCtx,
  table: string,
  ids: Array<string | null | undefined>,
  docNoColumn: string | null,
  idColumn = "id",
): Promise<
  | { blocked: ReturnType<typeof crossCompanyConversionBlocked> }
  | { loadError: string }
  | null
> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return null;
  const { data, error } = await sb
    .from(table)
    .select(docNoColumn ? `${idColumn}, ${docNoColumn}, company_id` : `${idColumn}, company_id`)
    .in(idColumn, unique);
  if (error) return { loadError: error.message };
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (isCrossCompanySource(row.company_id, c)) {
      return {
        blocked: crossCompanyConversionBlocked(
          docNoColumn ? (row[docNoColumn] as string | null) ?? null : null,
          row.company_id,
          c,
        ),
      };
    }
  }
  return null;
}
