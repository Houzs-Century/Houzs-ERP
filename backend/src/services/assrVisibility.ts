import type { Env } from "../types";
import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";
import { isDirectorUser } from "./pmsAccess";
import { subtreeUserIds, agentNamesForUserIds } from "./orgScope";

/**
 * WHO may see WHICH service case, and what gets stripped from it.
 *
 * This lived inline in `routes/assr.ts`, which meant `GET /api/assr/:id` had the
 * rule and `GET /api/assr-print/:id` — which emits the same case content as a
 * letterheaded document — did not. A visibility-scoped salesperson could render
 * any case in their own company by walking the id, and see the supplier identity
 * the JSON route withholds from them. A rule enforced on one of two routes that
 * emit the same content is not enforced, so it lives here now and both call it.
 *
 * `services/` cannot import from `routes/`, which is the other reason: this is
 * the only direction that composes.
 */
// ── Row-level visibility (owner spec 2026-07, amended 2026-08-20) ─────────────
// Full view = `*` wildcard (Owner / IT Admin) or `service_cases.manage`
// (the existing admin-tier ASSR key — no new permission invented), OR a
// director by STABLE ORG FIELD (Owner/IT `*`, Super Admin, Sales Director,
// Finance Manager) — owner rule "Director sees ALL".
//
// This tier MUST NOT be narrowed. The owner's reason, verbatim, 2026-08-20:
// "要不然 office 的帮不到 sales 处理东西了" — office staff work a case on a
// salesperson's behalf, so seeing everything is the point of the tier, not an
// accident of history. A later reader tempted to "tighten permissions" here
// would be removing the thing the tier exists for.
export function assrUnrestricted(user: AuthUser | undefined): boolean {
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  return (
    hasPermission(granted, "*") ||
    hasPermission(granted, "service_cases.manage") ||
    isDirectorUser(user)
  );
}

export async function assrVisibleUserIds(c: {
  get(key: "user"): unknown;
  env: Env;
}): Promise<number[] | undefined> {
  const user = c.get("user") as AuthUser | undefined;
  if (assrUnrestricted(user)) return undefined; // unrestricted
  if (user?.id == null) return []; // fail closed, never open
  return subtreeUserIds(c.env, Number(user.id));
}

/**
 * THE row-visibility rule, as ONE SQL boolean expression. Every reader — the
 * paginated list, the CSV export, the five aggregate endpoints, the detail GET
 * and the printable — resolves visibility through this string, so there is
 * exactly one place the rule is written down.
 *
 * ── WHAT IT SAYS (owner decision 2026-08-20, docs/SERVICE-CASE-VISIBILITY-DECISION.md)
 *
 * | source of the case's SO | who may see it |
 * |---|---|
 * | ERP-native (`scm."mfg_sales_orders"`) | self + DOWNLINE, resolved BY ID |
 * | AutoCount mirror, or no resolvable SO | anyone the COMPANY predicate admits |
 *
 * The asymmetry is about DATA QUALITY, not trust. In the owner's words:
 * "AutoCount 那一边，它的 SysAgent 可能也不准吧，所以也麻烦，所以 AutoCount 就去
 * 开放给每一个人吧" — the agent data in AutoCount is itself unreliable, so an
 * agent filter on that side is not a weak control, it is a control driven by
 * wrong input. It silently removed access from a batch of Sales Agents and
 * nothing said why. ERP orders carry a real `salesperson_id`, so a per-person
 * scope is meaningful there and stays.
 *
 * ── WHAT THIS REPLACED, AND WHY IT MUST NOT COME BACK
 *
 * The previous rule OR-ed in `LOWER(sales_agent) LIKE '%<subtree member name>%'`
 * — a SUBSTRING match over text mirrored from AutoCount. A rename, a stray
 * space or a different spelling silently dropped a rep out of their own cases.
 * That string comparison WAS the "binding", and it is what broke. ERP-sourced
 * rows now resolve the salesperson through `scm.staff.user_id` (mig 0066), which
 * is an id, so nothing depends on how a name is typed.
 *
 * ── THE THREE STATES, deliberately the same shape as `allowedCompaniesSql`
 *
 *   `undefined` -> `null`     unrestricted tier. NO predicate at all, so an
 *                             office / director query stays byte-identical.
 *   `[]`        -> `"1=0"`    a scoped caller with no resolvable identity. Fail
 *                             closed. `1=0` (not `false`) stays valid on the
 *                             D1/SQLite test mirror.
 *   non-empty   -> the rule   self + downline by id, plus every case whose SO is
 *                             not ERP-native.
 *
 * `prefix` is REQUIRED and is the outer table's alias with its dot — `"c."`,
 * `"ca."`, `"a."`, or `"assr_cases."` for an unaliased `FROM assr_cases`. It is
 * not optional on purpose: a wrong or missing alias silently changes WHICH rows
 * the rule is asked about, and this repo's standing rule is that a parameter
 * which decides something is required so the compiler enumerates the call sites.
 *
 * NOTE the subqueries are UNCORRELATED — the case's `doc_no` sits on the LEFT of
 * the `IN`, never inside the subquery. That is not a style choice: with a bare
 * `EXISTS (... WHERE LOWER(eo.doc_no) = LOWER(doc_no))` and an unaliased outer
 * table, the inner `doc_no` binds to `eo.doc_no` and the condition degenerates
 * to `true` for every row. Postgres also evaluates an uncorrelated subquery once
 * and hashes it, rather than once per case row.
 *
 * `eo.doc_no IS NOT NULL` is load-bearing for the `NOT IN`: a single NULL in the
 * subquery makes `NOT IN` yield NULL — never true — which would hide every
 * AutoCount case from every scoped caller. `<> ''` keeps a case with no doc_no
 * (which COALESCEs to `''`) from matching a blank order number.
 *
 * Ids are INLINED, and there are no binds at all. Same justification
 * `allowedCompaniesSql` states: they come from OUR users master
 * (`subtreeUserIds`) and are re-validated as positive integers right here.
 */
export function assrVisibilityPredicateSql(
  ids: number[] | undefined,
  prefix: string,
): string | null {
  if (ids === undefined) return null; // unrestricted — emit nothing
  const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length === 0) return "1=0"; // fail closed
  const idList = clean.join(",");
  const doc = `LOWER(COALESCE(${prefix}doc_no, ''))`;
  // `status <> 'DRAFT' AND status <> 'CANCELLED'` is the SAME definition of
  // "the ERP order for this doc_no" that `fetchScmSoContext` (services/assr.ts)
  // uses when a case is created. Two different definitions of the ERP order
  // inside one module is the drift this repo keeps paying for, so they match.
  const liveErpOrder =
    `FROM scm."mfg_sales_orders" eo` +
    ` WHERE eo.doc_no IS NOT NULL AND eo.doc_no <> ''` +
    ` AND eo.status <> 'DRAFT' AND eo.status <> 'CANCELLED'`;
  const erpDocs = `SELECT LOWER(eo.doc_no) ${liveErpOrder}`;
  const myErpDocs =
    `SELECT LOWER(eo.doc_no) FROM scm."mfg_sales_orders" eo` +
    ` JOIN scm.staff es ON es.id = eo.salesperson_id` +
    ` WHERE eo.doc_no IS NOT NULL AND eo.doc_no <> ''` +
    ` AND eo.status <> 'DRAFT' AND eo.status <> 'CANCELLED'` +
    ` AND es.user_id IN (${idList})`;
  return (
    `${prefix}created_by IN (${idList})` +
    ` OR ${prefix}assigned_to IN (${idList})` +
    ` OR ${prefix}assigned_to_2 IN (${idList})` +
    ` OR ${doc} NOT IN (${erpDocs})` +
    ` OR ${doc} IN (${myErpDocs})`
  );
}

/**
 * WHICH cases land in a caller's "My Cases" — as ONE SQL boolean expression.
 *
 * ── THE RULE (owner ruling 2026-08-21)
 *
 * 「如果是他开的 就算不是他as agent它也可以看啊 … 那就是他submit就代表他认领这个
 * case了啊」 — a case a person RAISED is theirs, whether or not the order names
 * them as the sales agent. The reasoning is the load-bearing half: AutoCount's
 * agent data is unreliable, which is exactly why AutoCount-sourced orders were
 * opened to every Houzs staff member to raise a case on (see
 * `assrVisibilityPredicateSql` above and docs/SERVICE-CASE-VISIBILITY-DECISION.md).
 * Once anyone may raise the case, SUBMITTING IS CLAIMING.
 *
 * ── THE TWO ARMS, AND WHY BOTH
 *
 *   `created_by IN (subtree ids)`  the ruling. Self + downline BY ID (the
 *                                  pyramid rule stands — a manager sees their
 *                                  reps' cases), so nothing depends on spelling.
 *   `LOWER(sales_agent) LIKE …`    the LEGACY reach, kept.
 *
 * The name arm is UNIONED, never replaced, and that is a measurement, not a
 * preference. Census run 32463589829 against production, 2026-08-21:
 * 862 non-archived cases, 856 with a `created_by`, but **1,113 user→case pairs
 * across 28 users are reachable ONLY by the free-text name** — overwhelmingly a
 * case OFFICE staff raised on a rep's behalf (`created_by` = the office user,
 * `sales_agent` = the rep). Dropping the name arm would have taken those cases
 * out of the reps' lists. The creator arm ADDS 2,359 pairs across 20 users.
 *
 * The name match remains as brittle as it ever was — a rename or a stray space
 * still breaks it. That is the point of the creator arm: every case raised in
 * the ERP from here on is keyed by id and cannot be lost that way. The name arm
 * only has to keep reaching what is already there.
 *
 * ── SHAPE
 *
 * Ids are INLINED after being re-validated as positive integers, the same
 * justification `assrVisibilityPredicateSql` states (they come from OUR users
 * master via `subtreeUserIds`). Names are BOUND — they are user-controlled text.
 * `null` means "no arm can match anything": the caller must return an empty
 * list, never an unfiltered query.
 */
export function myCasesPredicateSql(
  ids: number[],
  agentNames: string[],
  prefix = "",
): { sql: string; binds: string[] } | null {
  const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const names = [
    ...new Set(agentNames.map((n) => (n ?? "").trim().toLowerCase()).filter(Boolean)),
  ];
  const arms: string[] = [];
  const binds: string[] = [];
  if (cleanIds.length > 0) arms.push(`${prefix}created_by IN (${cleanIds.join(",")})`);
  for (const n of names) {
    arms.push(`LOWER(COALESCE(${prefix}sales_agent, '')) LIKE ?`);
    binds.push(`%${n}%`);
  }
  if (arms.length === 0) return null; // fail closed — never an unfiltered list
  return { sql: arms.join(" OR "), binds };
}

/**
 * The sales-side "My Cases" list.
 *
 * Lives here, not inline in `routes/assr.ts`, because it IS a visibility rule
 * and this file is where the module's visibility rules are written down — and
 * because a rule inlined in a route handler cannot be tested without standing up
 * the whole Hono stack. `companySql` is the caller's already-rendered company
 * predicate (`assrCompanySql(c)`, a leading `" AND …"` or `""`); the route
 * resolves it because a company grant is per-REQUEST.
 */
export async function listMyCases(
  env: Env,
  userId: number,
  companySql: string,
): Promise<{ cases: unknown[]; user_name: string }> {
  const userRow = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ name: string | null }>();
  const ownName = (userRow?.name || "").trim();
  // ONE subtree expansion, both halves off it — ids for the creator arm, display
  // names for the legacy agent-text arm.
  const ids = await subtreeUserIds(env, Number(userId));
  const names = await agentNamesForUserIds(env, ids);
  const pred = myCasesPredicateSql(ids, names);
  if (!pred) return { cases: [], user_name: ownName };
  const rows = await env.DB.prepare(
    `SELECT id, assr_no, stage, status, priority, doc_no, ref_no,
            customer_name, phone, complained_date, deadline_at,
            complaint_issue, item_code, sales_agent
       FROM assr_cases
      WHERE (${pred.sql})
        AND archived_at IS NULL${companySql}
      ORDER BY complained_date DESC, id DESC
      LIMIT 200`,
  )
    .bind(...pred.binds)
    .all();
  return { cases: rows.results ?? [], user_name: ownName };
}

// Supplier identity (creditor fields) is office + supplier-portal only
// (Nick 2026-07-15: 这个我要 office, supplier 看到而已) — sales-scoped
// callers get case payloads without it. assrVisibleUserIds() returning
// undefined marks an unrestricted (office) caller; an id list marks a
// sales-scoped one. Dual-named keys because the PG driver camelCases
// result columns.
const CREDITOR_KEYS = [
  "creditor_code", "creditorCode",
  "creditor_name", "creditorName",
  "creditor_email", "creditorEmail",
  "creditor_phone", "creditorPhone",
  "creditor_mobile", "creditorMobile",
  "creditor_attention", "creditorAttention",
  "creditor_source", "creditorSource",
] as const;
export function stripCreditorFields(row: Record<string, any> | null | undefined): void {
  if (!row) return;
  for (const k of CREDITOR_KEYS) {
    if (k in row) delete row[k];
  }
}

/**
 * Row-level visibility for ONE case — "may this caller see this case at all?".
 *
 * Exported because the PRINT route needs the identical answer and did not have
 * it. `GET /api/assr/:id` applied this rule; `GET /api/assr-print/:id` applied
 * only the company check, so a visibility-scoped salesperson could render any
 * case in their own company as a letterheaded document — customer name, phone,
 * address, the inlined attachments, and the supplier identity that
 * stripCreditorFields withholds from them on the JSON route. A rule enforced on
 * one of two routes that emit the same content is not enforced.
 *
 * It answers through `assrVisibilityPredicateSql` — the SAME string the list
 * builds its WHERE from — rather than re-stating the rule in TypeScript. The
 * previous version WAS a second copy, and a second copy of a visibility rule is
 * the drift this file exists to stop. The id terms are still checked in memory
 * first, so the common case (your own case, or your downline's) costs no query.
 *
 * Returns `true` for an unrestricted (office) caller — `assrVisibleUserIds`
 * answers `undefined` for them, which is the same three-state sentinel the list
 * uses. Dual-read camelCase ?? snake_case: the PG driver camelCases columns.
 *
 * FAILS CLOSED on a query error. The `scm` schema is absent on the D1 test
 * mirror and could be transiently unreadable in production; either way "I could
 * not establish that you may see this" is a 404, never a grant.
 */
export async function assrCaseRowInScope(
  c: Parameters<typeof assrVisibleUserIds>[0] & { req: any },
  row: Record<string, any> | null | undefined,
): Promise<boolean> {
  const visibleIds = await assrVisibleUserIds(c);
  if (visibleIds === undefined) return true;
  if (!row) return false;
  const createdBy = Number(row.createdBy ?? row.created_by ?? NaN);
  const assignedTo = Number(row.assignedTo ?? row.assigned_to ?? NaN);
  // Co-assignee (assigned_to_2) — the LIST scopes on it too (services/assr.ts),
  // so a co-assignee who sees the case in their list must be able to open it.
  const assignedTo2 = Number(row.assignedTo2 ?? row.assigned_to_2 ?? NaN);
  if (
    (Number.isFinite(createdBy) && visibleIds.includes(createdBy)) ||
    (Number.isFinite(assignedTo) && visibleIds.includes(assignedTo)) ||
    (Number.isFinite(assignedTo2) && visibleIds.includes(assignedTo2))
  ) return true;
  const pred = assrVisibilityPredicateSql(visibleIds, "assr_cases.");
  if (pred === null) return true;
  const id = Number(row.id ?? NaN);
  if (!Number.isFinite(id)) return false;
  try {
    const hit = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM assr_cases WHERE assr_cases.id = ? AND (${pred}) LIMIT 1`,
    )
      .bind(id)
      .first<{ ok: number }>();
    return !!hit;
  } catch {
    return false; // scm schema unreachable — fail closed, never open
  }
}

/** Is this caller visibility-RESTRICTED (i.e. must not see supplier identity)? */
export async function assrCallerIsScoped(
  c: Parameters<typeof assrVisibleUserIds>[0],
): Promise<boolean> {
  return (await assrVisibleUserIds(c)) !== undefined;
}
