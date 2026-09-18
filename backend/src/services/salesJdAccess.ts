// ----------------------------------------------------------------------------
// salesJdAccess — the Sales cohort's SCM access, keyed off the ORG CHART in
// code, not the RBAC config matrix.
//
// WHY THIS EXISTS. Owner, 2026-07-17: "我説的是用coding 去改backend 而不是整個 …
// 或者你把整個sales department的這個移除掉 根據我們的指令來做 … 那些none的
// 直接不給看 用backend來做." He has said it before, and salesAccess.ts's own
// header already records it: "the owner explicitly wants the Sales cohort's
// visibility driven from the org chart in code (the RBAC-config matrix has
// unresolved issues)". The matrix cannot express what he needs -- 41 nav
// entries already carry hardcoded cohort flags because of it -- so the Sales
// cohort's SCM levels are a RULE, not a setting somebody can mis-click.
//
// THE RULE IS THE JD (owner, same day):
//   "销售部门原本就是卖东西、开 SO 的。如果他们没有开 SO，后面的人怎么去操作呢？"
//   "后面的人是来操作 DO 和 SI 的。销售人员不可能去操作 DO 和 SI，所以他们通常
//    只是来看而已。"
// So: Sales OWNS the Sales Order (edit -- it is the SOURCE document the whole
// chain hangs off; a rep stuck at `view` kills the chain at step one), and only
// LOOKS at what Office operates.
//
// PROVENANCE -- which of these four lines are HIS WORDS, and which are not.
// He is meant to read this file and recognise his own decisions, so the two are
// marked apart rather than blended (`feat/jd-rules-from-record`, 2026-07-17,
// which mined BUG-HISTORY + every merged PR body + the full git log for them):
//   - orders / delivery / invoices  -- QUOTED AND DATED above (owner 2026-07-17).
//   - returns                       -- QUOTED AND DATED as of 2026-07-17. It was
//     carried as UNQUOTED for three days: `feat/jd-rules-from-record` traced it
//     to `hideForSalesNonDirector` -> `hideForSales` in f2ca099 (2026-07-14,
//     PR #417), whose body asserts "deny ALL Sales staff (director too)" and
//     cites no instruction, and flagged it rather than acting on it. Asked
//     directly, the owner confirmed it was his all along:
//       "该关（我确实讲过 / 就是要关）"                    -- owner, 2026-07-17
//     and settled the cohort question the same day:
//       "sales director 算sales"                          -- owner, 2026-07-17
//     So the rule is his, it covers the Director, and it is now ENFORCED rather
//     than merely written (see below). The three-day gap is the lesson: the
//     record could not show the rule, and flagging beat guessing.
//
// WHAT IS ACTUALLY IN FORCE -- measured, because writing a level here is not the
// same as enforcing it (`feat/z1-jd-consolidate`, 2026-07-17, proved this the
// expensive way and its entry is the reason this block exists):
//   - The backend area-guard SKIPS this map unless the caller already holds an
//     explicit `scm*` row (`area-guard.ts` -- the documented NO-LOCKOUT
//     fallthrough). So for a Sales user with NO such row, `"edit"` here grants
//     nothing the coarse `scm.access` umbrella did not already allow, and
//     `"view"` caps nothing.
//   - THE ONE EXCEPTION, and it is deliberate: `salesJdDenial()` below is
//     consulted by the area-guard BEFORE that fallthrough, so a `"none"` in this
//     map is enforced for the cohort whether or not they are L2-configured. That
//     is what makes `scm.sales.returns` a real 403 instead of a hidden nav entry
//     (`feat/dead-cells-and-returns`, 2026-07-17). ONLY the deny half works this
//     way: the `"view"` caps on delivery/invoices are still inert for a non-L2
//     rep, because enforcing THEM would need `scm_l2_configured` forced true,
//     which backfills EVERY unlisted SCM key to "none" and starts enforcing it
//     -- a mass-lockout risk that needs a staging pass, not a merge.
//   - `"none"` still does not hide a nav entry: every SCM entry ORs
//     `anyPerm: ["*","scm.access"]` against `anyAccess`, and `navFilter.ts:81-84`
//     only drops the `scm.access` term when `scm_l2_configured` is true. What
//     hides Delivery Returns in the UI is `hideForSales` on the nav entry plus
//     `DeliveryReturnsGuard` on the route -- both untouched, and both now
//     BACKED by a real gate rather than standing in for one.
//   - Where this map IS load-bearing: the FRONTEND reads it from /auth/me
//     (`quickActionAccess` compares `scm.sales.orders` through ACCESS_RANK
//     against `edit`), and the backend area-guard enforces it for any cohort
//     member who IS L2-configured -- which per z1's measurement includes the
//     Sales Director.
//
// WHY HERE AND NOT IN THE ROUTES. `page_access` is read by BOTH sides -- the
// backend's scm/middleware/area-guard (`user.page_access[area]`, GET/HEAD needs
// `view`, writes need `edit`, "else 403 ENFORCED") and the frontend, which gets
// this same map from /auth/me. Applying the rule once, where the map is built,
// is what stops the two drifting: a rep was being offered a "Create Sales Order"
// button the backend then 403'd, because the FE gate and the BE gate disagreed
// by exactly one level and nothing made them agree.
// ----------------------------------------------------------------------------

import type { AccessLevel } from "./pageAccess";

/** Position names that ARE the Sales cohort. Mirrors pmsAccess.isSalesUser and
 *  the frontend's salesAccess.isSalesStaff -- department first, position-name
 *  prefix as the fallback for anyone filed outside a Sales department. */
const SALES_POSITION = /^sales/i;

/** The Sales-cohort detection, exported so positionPolicy classifies the cohort
 *  with the SAME rule rather than a second copy. ONE detection rule is what stops
 *  a Sales position from resolving to full-access by accident (positionPolicy's
 *  header states this); sharing the predicate makes it literal, not aspirational. */
export function isSalesCohort(u: {
  position_name?: string | null;
  department_name?: string | null;
  /** The Title's stored policy row, when the caller carries one: it decides
   *  the cohort (Roles & Permissions › Titles); the org-field rule below is the
   *  fallback for a Title with no row. */
  position_policy?: { cohort: string } | null;
}): boolean {
  if (u.position_policy) return u.position_policy.cohort === "sales";
  const dept = (u.department_name ?? "").toLowerCase();
  if (dept.includes("sales")) return true;
  return SALES_POSITION.test((u.position_name ?? "").trim());
}

/** The JD, as data. Anything not listed is left to the matrix -- this override
 *  answers the SCM sales chain ONLY, and deliberately does not touch Projects,
 *  Service Cases, or anything else a rep's position legitimately configures.
 *
 *  THE DIRECTOR IS IN THIS COHORT, and as of 2026-07-17 that is a RULING, not an
 *  open question: "sales director 算sales" (owner). `isSalesCohort` matches on
 *  department, so "Sales Director" matches, and these four levels are SET on him
 *  too, overriding whatever his matrix row says.
 *
 *  WHAT HIS RULINGS SETTLED. He ruled on the COHORT ("算sales"), on RETURNS
 *  ("就是要关"), and on 2026-07-18 on the DO/SI cap itself: "DO SI 只能看
 *  salesdirector" -- the Director is view-only on delivery + invoices. What was
 *  #671's inference is now his stated rule. So:
 *    - returns `none` DENIES him -- enforced, his words, `salesJdDenial()`.
 *    - delivery/invoices `view` CAPS him at read -- and for the Director this is
 *      ENFORCED, not inert: his matrix row `scm.sales = full` (prod snapshot)
 *      makes him scm_l2_configured, so the area-guard requires `edit` for a DO/SI
 *      write and `view` fails it (a real 403). The "inert for a non-L2 rep" note
 *      above is about a hypothetical rep with NO scm* row; every real Sales
 *      position carries one. Pinned by the RULED test.
 *  His own export (2026-07-17) shows scm.procurement / warehouse / transportation
 *  / consignment / finance ALL `none` on his row, so the returns deny costs him
 *  nothing elsewhere -- measured, not assumed.
 */
export const SALES_JD: Readonly<Record<string, AccessLevel>> = {
  // Owner 2026-07-17: "销售部门原本就是卖东西、开 SO 的。如果他们没有开 SO，
  // 后面的人怎么去操作呢？" -- they sell; the SO is theirs to raise + confirm.
  "scm.sales.orders": "edit",
  // Owner 2026-07-17: "后面的人是来操作 DO 和 SI 的。销售人员不可能去操作 DO 和
  // SI，所以他们通常只是来看而已。" -- Office operates it; Sales only looks.
  "scm.sales.delivery": "view",
  "scm.sales.invoices": "view",
  // Owner 2026-07-17: "该关（我确实讲过 / 就是要关）" -- his rule, confirmed his
  // when asked, and "sales director 算sales" puts the Director inside it. This is
  // the ONE line here that is enforced for the whole cohort regardless of
  // `scm_l2_configured` -- see salesJdDenial() and the header.
  "scm.sales.returns": "none",
};

/** Plain-language reason per denied area, for the 403 body. Keyed off the SAME
 *  map above rather than standing as a second list of denied areas -- a second
 *  list is how the rule and its enforcement drift apart. A denied area with no
 *  sentence here still denies (the fallback below); it just says less. */
const DENY_REASON: Readonly<Record<string, string>> = {
  "scm.sales.returns":
    "Delivery Returns is handled by the Office team, not Sales. Ask Office to raise the return for you.",
};

/** Plain-language reason per WRITE-capped area, for the 403 body of
 *  `salesJdWriteDenial`. Same construction as DENY_REASON: keyed off SALES_JD,
 *  never a second list of areas. It has to name the READ that survives, because
 *  the salesperson CAN still open the document and print it -- a bare "forbidden"
 *  would read as "the page is broken" for someone looking straight at it. */
const WRITE_DENY_REASON: Readonly<Record<string, string>> = {
  "scm.sales.delivery":
    "Delivery Orders are raised by the Office team, not Sales. You can view and print this one; ask Office to create or change a DO.",
  "scm.sales.invoices":
    "Sales Invoices are raised by the Office team, not Sales. You can view and print this one; ask Office to create or change an invoice.",
};

/** The tolerant caller shape. The area-guard holds a Houzs `AuthUser`; SCM route
 *  handlers hold `houzsUser` (scm/env.ts), whose fields are all optional because
 *  the bridge mirrors them. One predicate has to answer for both, so it reads
 *  only what both actually carry. */
export interface SalesJdCaller {
  permissions?: ReadonlyArray<string> | ReadonlySet<string>;
  permissions_set?: ReadonlySet<string>;
  position_name?: string | null;
  department_name?: string | null;
  position_policy?: { cohort: string } | null;
}

function hasWildcard(u: SalesJdCaller): boolean {
  if (u.permissions_set?.has("*")) return true;
  const p = u.permissions;
  if (!p) return false;
  return Array.isArray(p) ? p.includes("*") : (p as ReadonlySet<string>).has("*");
}

/**
 * Is this caller denied `area` by the Sales JD? Returns the plain-language
 * reason to put in the 403 body, or null when the JD has nothing to say.
 *
 * THIS IS THE DENY HALF, AND ONLY THE DENY HALF. It answers exactly one
 * question -- "does SALES_JD say `none` for this cohort member?" -- and is
 * derived from SALES_JD, so it cannot list an area the rule does not deny.
 *
 * WHY IT EXISTS SEPARATELY FROM applySalesJdOverride. That function writes the
 * level into `page_access`; the area-guard then SKIPS `page_access` entirely for
 * any caller without an explicit `scm*` row (the NO-LOCKOUT fallthrough). So for
 * a Sales rep the written `"none"` was theatre: `hideForSales` hid the nav entry
 * and the URL still returned real data. This predicate is consulted BEFORE that
 * fallthrough, which closes the door without touching `scm_l2_configured` --
 * forcing that flag true would backfill every unlisted SCM key to "none" and
 * lock the cohort out of Procurement, Warehouse and the rest (z1 measured it).
 *
 * `*` IS EXEMPT, first and unconditionally -- narrowing the owner/IT wildcard
 * would lock him out of his own system.
 *
 * A CALLER THIS CANNOT IDENTIFY IS NOT DENIED (undefined caller, or no
 * department + no position -> isSalesCohort false -> null). That is fail-OPEN,
 * stated plainly rather than hidden: this predicate only ever ADDS a denial on
 * top of gates that already ran (the coarse `scm.access` umbrella upstream, and
 * supabaseAuth), so an unidentifiable caller lands exactly where it lands today
 * instead of being newly locked out on missing data.
 */
export function salesJdDenial(
  user: SalesJdCaller | null | undefined,
  area: string,
): string | null {
  if (!user) return null;
  if (hasWildcard(user)) return null;
  if (!isSalesCohort(user)) return null;
  if (SALES_JD[area] !== "none") return null;
  return DENY_REASON[area] ?? "This page is not part of the Sales role.";
}

const isWriteMethod = (method: string): boolean =>
  method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";

/**
 * Is this caller denied a WRITE on `area` by the Sales JD's `view` cap? Returns
 * the plain-language reason for the 403 body, or null when the JD has nothing to
 * say.
 *
 * THIS IS THE OTHER HALF THE HEADER SAID WAS INERT, AND IT IS NOW REAL.
 * The header above states it plainly: the `"view"` caps on delivery/invoices
 * "are still inert for a non-L2 rep", because the area-guard SKIPS `page_access`
 * entirely for any caller without an explicit `scm*` row (the NO-LOCKOUT
 * fallthrough). Only the `"none"` half was enforced. That left a real hole:
 *
 *   - A POSITIONED sales rep resolves through positionPolicy, whose scm.sales row
 *     sets scm_l2_configured TRUE, so the `view` cap DID 403 their DO/SI writes.
 *   - A user in a Sales DEPARTMENT with NO position_id hydrates from the legacy
 *     ROLE matrix (auth.ts positionless branch). That branch backfills the scm*
 *     keys owner-only, so they are NOT scm_l2_configured -- and the guard handed
 *     them straight through to POST /delivery-orders-mfg and POST /sales-invoices.
 *     `applySalesJdOverride` wrote `"view"` into their map and nothing read it.
 *
 * So the SAME rule was enforced for one Sales user and theatre for another, which
 * is precisely the failure mode salesJdDenial was written to end. This predicate
 * closes it the same way: consulted BEFORE the no-lockout fallthrough, so the cap
 * holds for every cohort member without forcing `scm_l2_configured` true (which
 * would backfill every unlisted SCM key to "none" and risk the z1 mass lockout).
 *
 * DERIVED FROM SALES_JD, never a second list. An area is write-capped iff the JD
 * puts it at exactly `"view"` -- so `scm.sales.orders` ("edit") is untouched (Sales
 * OWNS the SO and must keep writing it) and `scm.sales.returns` ("none") is already
 * answered whole-method by salesJdDenial above. Adding a `"view"` line to SALES_JD
 * is all it takes to cap a new area; there is nothing here to keep in sync.
 *
 * READS ARE NEVER DENIED -- the method check is first and total. Sales keeps view
 * + Print PDF on DO and SI (both are GETs; the PDFs are rendered client-side from
 * the GET payload), and the `readInheritsFrom: "scm.sales.orders"` hatch in
 * scm/index.ts is untouched, so a rep still reads the DOs and SIs raised off their
 * own Sales Orders. This rule can only ever remove a WRITE.
 *
 * `*` IS EXEMPT, first and unconditionally, and NOBODY OUTSIDE THE SALES COHORT IS
 * TOUCHED -- Office keeps exactly what its position grants. A caller this cannot
 * identify is not denied (fail-OPEN), matching salesJdDenial and moneyWriteDenial:
 * this predicate only ever ADDS a denial on top of gates that already ran.
 */
export function salesJdWriteDenial(
  user: SalesJdCaller | null | undefined,
  area: string,
  method: string,
): string | null {
  if (!user) return null;
  // Reads are always allowed — Sales views + prints DO/SI. Method check first.
  if (!isWriteMethod(method)) return null;
  // Only a `view` cap denies here. "edit" grants, "none" belongs to salesJdDenial.
  if (SALES_JD[area] !== "view") return null;
  if (hasWildcard(user)) return null;
  if (!isSalesCohort(user)) return null;
  return (
    WRITE_DENY_REASON[area] ??
    "Creating or changing this document is not part of the Sales role. You can view and print it."
  );
}

/**
 * Apply the Sales JD over a hydrated page-access map.
 *
 * SINCE THE FOLD (positionPolicy now owns positioned sales): SALES_JD is the ONE
 * definition of the sales SCM leaf levels, and positionPolicy.ts imports it to
 * build the sales cohort's page-access rows. So for a POSITIONED sales user this
 * override is now IDEMPOTENT -- the policy already produced orders=edit /
 * delivery=view / invoices=view / returns=none, and re-spreading the same values
 * changes nothing (pinned in positionPolicy.test.ts). It is retained on the auth
 * chain for exactly ONE case the position policy structurally cannot reach: a
 * user in a Sales DEPARTMENT with NO position_id, who hydrates from the legacy
 * role matrix (auth.ts positionless branch) and so never runs resolvePositionPolicy.
 * That fallback is the reason this is not deleted -- removing it would drop the JD
 * levels (and the FE quick-action they drive) for a positionless Sales-department
 * user. The DENY half (salesJdDenial) is department-keyed and independent of this,
 * so a positionless user's returns denial is preserved either way.
 *
 * The `*` wildcard (Owner / IT) is exempt and returns UNTOUCHED: it arrives
 * here as fullAccessMap(), and narrowing it would lock the owner out of his own
 * system. Everyone outside the Sales cohort is untouched too -- Office keeps
 * whatever its position grants, which is the whole point of the split.
 *
 * A USER WITH NO POSITION STILL GETS THIS. The cohort test keys off
 * `department_name`, which is populated independently of `position_id`, while
 * `auth.ts:297` hydrates a positionless user from the LEGACY ROLE matrix
 * (`role_page_access`, still live). So a Sales-department user with no position
 * lands here with a role-derived map and has the JD applied on top of it. That
 * is the intended direction (the JD is about the department, not the position
 * row), and it is safe: the role matrix's SCM keys backfill owner-only, so such
 * a user is almost never L2-configured and the deny half stays inert for them --
 * but it means this override must never be written to assume a position exists.
 */
export function applySalesJdOverride(
  pageAccess: Record<string, AccessLevel>,
  user: {
    permissions: ReadonlySet<string> | string[];
    position_name: string | null;
    department_name: string | null;
    position_policy?: { cohort: string } | null;
  },
): Record<string, AccessLevel> {
  const perms = Array.isArray(user.permissions)
    ? new Set(user.permissions)
    : user.permissions;
  if (perms.has("*")) return pageAccess;
  if (!isSalesCohort(user)) return pageAccess;
  return { ...pageAccess, ...SALES_JD };
}
