// ----------------------------------------------------------------------------
// positionPolicy — THE single authoritative position-access policy, in code.
//
// WHY THIS EXISTS. Owner-directed architecture change (Lim Wei Siang, 2026-07-18):
// stop deriving a position's page access from the `position_page_access` matrix
// TABLE and define it by ONE code policy he directs line by line ("这个有那个没有").
// The end state is a SINGLE rule — not the old matrix AND a separate sales
// mechanism coexisting. This module is that one rule. The matrix stays in the DB
// (its editor + export are untouched) but is no longer READ to resolve access for
// the positions this policy covers; auth.ts asks THIS module.
//
// THE MODEL — default-FULL, restrict only the named cohorts. Owner's interim
// intent: "暂时都可以看到系统里的所有内容". EXCEPT Driver, Helper, Storekeeper,
// Storekeeper Supervisor (an explicit whitelist below) and the Sales tiers, a
// position resolves to fullAccessMap(). A position this module cannot classify
// falls to FULL, never to none — fail OPEN. That is the anti-lockout guarantee:
// "unknown" and "unrestricted" both land on full, so no covered position can
// resolve to an empty map by accident.
//
// SALES IS ONE COHORT IN THIS SAME POLICY — AND NOW RESOLVED HERE. The earlier
// step marked sales a KNOWN cohort but DEFERRED its page-access resolution to the
// legacy matrix (`resolutionDeferred: true`). THIS step folds it in: the four
// sales positions get an explicit page-access whitelist below — their prod rows
// (positionAccessSnapshot) PLUS the imported SALES_JD leaf levels — resolved
// through the SAME resolver the restricted cohort uses, so positionPolicy is now
// the single page-access SOURCE for ALL 17 positions. `resolutionDeferred` is
// gone. What is NOT ripped out, deliberately: the enforcement MECHANISMS that
// derive the non-page dimensions from the same org fields — salesJdDenial (the
// enforced returns 403, still consulted by area-guard + reports.ts), salesScope
// (own+downline row scope), and the pmsAccess/houzs-perms margin+director gates.
// The policy's FLAGS record those decisions (orderScope / canSeeMargin /
// canSeeCommission / announcementScope) and a test pins that the flags AGREE with
// those live helpers for the sales cohort — the policy is the authority, the
// mechanisms are its hands. Proven byte-identical to the pre-fold resolution for
// every sales position (positionPolicy.test.ts, before/after over the snapshot).
//
// scm_l2_configured IS DERIVED HERE, NOT FORCED. A restricted whitelist is fed
// through the SAME resolver the DB path uses (resolvePositionAccessFromRows), so
// its explicit `scm*` rows set `explicitScm` by the identical mechanism the live
// table would have — the restricted cohort is honestly SCM-configured because we
// deliberately configured its SCM areas, and the area-guard therefore ENFORCES
// its `none` denials (without that, step 3 of area-guard.ts falls open to the
// coarse scm.access umbrella and a Storekeeper could write a stock transfer). The
// FULL and fail-open branches leave `explicitScm` FALSE — the same value `*`
// gets — so nothing is force-narrowed: a full position has full on every key and
// the guard has nothing to enforce. This honours "do not force scm_l2_configured"
// where it matters (the full/gap positions, the z1 mass-lockout risk) while still
// enforcing a hand-authored, complete whitelist.
// ----------------------------------------------------------------------------

import {
  fullAccessMap,
  resolvePositionAccessFromRows,
  type AccessLevel,
  type PageAccessMeta,
} from "./pageAccess";
import { SALES_JD, isSalesCohort } from "./salesJdAccess";
import type { PositionPolicyRow, RestrictedProfile } from "./positionPolicyRows";

interface PolicyRow {
  page_key: string;
  level: AccessLevel;
}

function normalisePosition(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface PositionAccessFlags {
  orderScope: "own_downline" | "all";
  canSeeMargin: boolean;
  canSeeCommission: boolean;
  announcementScope: "dept" | "all";
  /** May MOVE MONEY — post a journal entry to the GL, or raise/post/cancel a
   *  payment voucher (cash-out). Owner 2026-07-18: his "暂时都可以看到系统里的
   *  所有内容" is about SEEING, and seeing is not doing — so default-full grants
   *  every READ but NOT the money-moving writes. True for Finance Manager (it is
   *  his job) and Super Admin; false for everyone else. Drives BOTH halves of the
   *  carve-out: the money keys are lowered to `view` in the map (so the FE agrees)
   *  and `moneyWriteDenial` enforces it at the door. */
  canMoveMoney: boolean;
  /** May WRITE SCM MASTER DATA / config — the flat `scm.config.write` capability,
   *  keyed off POSITION rather than the role matrix. Owner-directed 2026-07-18
   *  ("ONE RULE — permissions position-driven, no roles.permissions migration"):
   *  a full-page-access OPERATION position that manages products/SKUs/prices must
   *  be able to DO the master-data writes it can SEE, without a role grant. True
   *  for the CONFIG_WRITE_POSITIONS cohort (the operation/purchasing positions);
   *  false for everyone else. Consumed by scm/lib/houzs-perms.canWriteScmConfig,
   *  which gates the 29 `scm.config.write` route sites as `flat perm OR this flag`
   *  — never `position only`, so any role that already holds the flat perm still
   *  passes. Additive: it only ever GRANTS the write, never removes one. */
  canWriteConfig: boolean;
}

const FLAGS_FULL: PositionAccessFlags = {
  orderScope: "all",
  canSeeMargin: true,
  canSeeCommission: true,
  announcementScope: "all",
  canMoveMoney: false,
  canWriteConfig: false,
};

const FLAGS_FULL_MONEY: PositionAccessFlags = {
  ...FLAGS_FULL,
  canMoveMoney: true,
};

const FLAGS_RESTRICTED: PositionAccessFlags = {
  orderScope: "all",
  canSeeMargin: false,
  canSeeCommission: false,
  announcementScope: "dept",
  canMoveMoney: false,
  canWriteConfig: false,
};

const FLAGS_SALES: PositionAccessFlags = {
  orderScope: "own_downline",
  canSeeMargin: false,
  canSeeCommission: false,
  announcementScope: "dept",
  canMoveMoney: false,
  canWriteConfig: false,
};

const FLAGS_SALES_DIRECTOR: PositionAccessFlags = {
  orderScope: "all",
  canSeeMargin: true,
  canSeeCommission: false,
  announcementScope: "dept",
  canMoveMoney: false,
  // SCM MASTER-DATA WRITE (owner 2026-09-01, asked of Kris's account: "想让他能改"
  // — retail price, sofa combos, and Model activation / Modular toggles). Paired
  // with the scm.procurement.products row below: the area guard admits the write
  // and this flag satisfies the per-route canWriteScmConfig check that
  // /mfg-products, /sofa-combos and /maintenance-config additionally impose.
  // Granting only one half leaves every price + combo save 403'ing, which is the
  // exact state this replaces (the POS showed him the full editor because its
  // role is position-derived, and every save failed server-side).
  //
  // BREADTH, measured rather than assumed — canWriteScmConfig is `flat perm OR
  // this flag`, so it reaches all 18 route files that call it. Every one of them
  // is ALSO area-gated on scm.procurement.products except four, which is the
  // whole of what this widens beyond the Products area:
  //   · sales-analysis PUT /targets      — edits the sales target profile. A Sales
  //                                        Director owning his own targets is the
  //                                        intent, not a side effect.
  //   · so-amendments GET /command-diag  — read-only 2990-connection diagnostic.
  //   · localities, state-warehouse-mappings — ungated read-mostly master data.
  // Money is untouched (canMoveMoney stays false) and no read is widened.
  canWriteConfig: true,
};


const DRIVER_HELPER_ROWS: readonly PolicyRow[] = [
  { page_key: "scm.transportation", level: "view" },
  // Projects / PMS — view (owner 2026-07-21: drivers & helpers "open all
  // events", editing stays limited to their own role-badged checklist tasks,
  // which the projects.checklist.tick permission + the role-label gates on
  // the status/attachment routes already enforce). This restores what the
  // old position_page_access matrix gave positions 16/17 (projects,
  // projects.list, projects.calendar = view) and what the mobile PMS driver
  // portal has been using since 2026-07-09 — the 07-18 fold dropped it and
  // locked drivers out of every event ("Couldn't load this project").
  // finances / maintenance carry an explicit none so the L1 view does not
  // cascade onto them (same pattern as the Storekeeper warehouse denials).
  { page_key: "projects", level: "view" },
  { page_key: "projects.finances", level: "none" },
  { page_key: "projects.maintenance", level: "none" },
];

const STOREKEEPER_ROWS: readonly PolicyRow[] = [
  { page_key: "scm.transportation", level: "view" },
  // Projects / PMS — view, same rows as Driver/Helper (owner 2026-07-21:
  // storekeepers work events alongside the crew; the projects endpoints
  // additionally row-scope helpers/storekeepers to events they're crewed on
  // — isCrewScopedUser in routes/projects.ts).
  { page_key: "projects", level: "view" },
  { page_key: "projects.finances", level: "none" },
  { page_key: "projects.maintenance", level: "none" },
  { page_key: "scm.warehouse", level: "view" },
  { page_key: "scm.warehouse.inventory", level: "view" },
  { page_key: "scm.warehouse.transfers", level: "none" },
  { page_key: "scm.warehouse.stock_take", level: "none" },
  { page_key: "scm.warehouse.adjustments", level: "none" },
  // Goods Receipt — edit, so the storekeeper RECEIVES: drafts the GRN (scan the
  // supplier's delivery order) and scans each line's rack. Posting it is the
  // purchaser's, on the separate scm.grn.post capability (owner 2026-10-01).
  // Same no-cascade reasoning as the supervisor's row below.
  { page_key: "scm.procurement.grn", level: "edit" },
];

const STOREKEEPER_SUPERVISOR_ROWS: readonly PolicyRow[] = [
  { page_key: "scm.transportation", level: "view" },
  { page_key: "projects", level: "view" },
  { page_key: "projects.finances", level: "none" },
  { page_key: "projects.maintenance", level: "none" },
  { page_key: "scm.warehouse", level: "view" },
  { page_key: "scm.warehouse.inventory", level: "view" },
  { page_key: "scm.warehouse.transfers", level: "none" },
  { page_key: "scm.warehouse.stock_take", level: "none" },
  { page_key: "scm.warehouse.adjustments", level: "none" },
  { page_key: "scm.procurement.grn", level: "edit" },
];

// Calendar Viewer — the narrowest office role: the CALENDAR and nothing else
// (owner 2026-08-26, 「Calendar Viewer = 只有日历」). It exists to give someone
// the shared events board without any operational surface, so a fail-open FULL
// map (which it had until this row) was the whole point defeated.
//
// The Projects group renders for its ONE Calendar sub-tab; the List / Finances /
// Maintenance sub-tabs carry explicit `none` rows so the L1 `projects` = view
// does not cascade onto them (same override mechanism as the Storekeeper
// warehouse denials).
//
// The `scm` = none row is deliberate and load-bearing. Calendar Viewer has NO
// SCM access, and stating it EXPLICITLY (rather than leaving SCM absent) flips
// this position scm_l2_configured — so the area-guard ENFORCES the denial on
// every /api/scm/* route instead of falling through to the coarse `scm.access`
// umbrella, which a stray role grant could otherwise satisfy. Every scm.* child
// inherits this none. (The three other office positions the owner reviewed —
// HR Manager / Service Admin / Procurement-Purchasing — stay FULL for now: owner
// 2026-08-26 kept them on the default-full interim, so they are NOT listed here.)
const CALENDAR_VIEWER_ROWS: readonly PolicyRow[] = [
  { page_key: "projects", level: "view" },
  { page_key: "projects.calendar", level: "view" },
  { page_key: "projects.list", level: "none" },
  { page_key: "projects.finances", level: "none" },
  { page_key: "projects.maintenance", level: "none" },
  { page_key: "scm", level: "none" },
];

const RESTRICTED_ROWS: ReadonlyMap<string, readonly PolicyRow[]> = new Map(
  [
    ["Driver", DRIVER_HELPER_ROWS],
    ["Helper", DRIVER_HELPER_ROWS],
    ["Storekeeper", STOREKEEPER_ROWS],
    ["Storekeeper Supervisor", STOREKEEPER_SUPERVISOR_ROWS],
    // Owner 2026-08-28: the warehouse crew position(s) the owner created in the
    // admin UI ("Warehouse Crew KL", mixing Helper + Storekeeper roles). Same
    // whitelist as Storekeeper — projects view + warehouse view. Without this
    // entry the whole crew fell into the default-FULL cohort (finance pages
    // included) AND lost every position-keyed crew behaviour. The PREFIX
    // fallback in resolvePositionPolicy covers future regional variants
    // ("Warehouse Crew JB", …) so a new region can't reopen the hole.
    ["Warehouse Crew KL", STOREKEEPER_ROWS],
    // Owner 2026-09-16 (Roles & Permissions review, part A): the outsourced
    // delivery contractors. Accounts on the Driver ROLE, but the position name
    // was unclassified, so they fell into the default-FULL cohort and saw every
    // page a manager sees (the role's keys stopped the API, not the menus). Same
    // whitelist as Driver / Helper. Now ALSO a fleet position (see
    // FLEET_POSITIONS, owner 2026-11-28): the sync_user_to_tms trigger links an
    // Outsource Transporter account to an scm.drivers row (in_house=false) by
    // user_id, so a linked one is scoped to its own run sheet and can upload POD;
    // an UNLINKED one fails CLOSED to an empty board rather than seeing the whole
    // fleet (deliveryScope.ts).
    ["Outsource Transporter", DRIVER_HELPER_ROWS],
    ["Calendar Viewer", CALENDAR_VIEWER_ROWS],
  ].map(([name, rows]) => [normalisePosition(name as string), rows as readonly PolicyRow[]]),
);

/** Prefix rule for the owner's regional warehouse-crew positions — see the
 *  RESTRICTED_ROWS note. Normalised-name prefix, not \b substring: the name
 *  must START with "warehouse crew", so an office position that merely
 *  mentions warehouse cannot be pulled into the restricted cohort. */
export function isWarehouseCrewPosition(positionName: string | null | undefined): boolean {
  return normalisePosition(positionName ?? "").startsWith("warehouse crew");
}

const PROFILE_ROWS: Readonly<Record<RestrictedProfile, readonly PolicyRow[]>> = {
  driver_helper: DRIVER_HELPER_ROWS,
  storekeeper: STOREKEEPER_ROWS,
  storekeeper_supervisor: STOREKEEPER_SUPERVISOR_ROWS,
  calendar_viewer: CALENDAR_VIEWER_ROWS,
};

const SALES_JD_ROWS: readonly PolicyRow[] = Object.entries(SALES_JD).map(
  ([page_key, level]) => ({ page_key, level }),
);

const SALES_DIRECTOR_ROWS: readonly PolicyRow[] = [
  { page_key: "projects", level: "view" },
  { page_key: "projects.calendar", level: "view" },
  { page_key: "sales", level: "none" },
  { page_key: "scm.sales", level: "full" },
  { page_key: "scm.procurement.products", level: "edit" },
  { page_key: "service_cases", level: "edit" },
  ...SALES_JD_ROWS,
];

const SALES_ORDINARY_ROWS: readonly PolicyRow[] = [
  { page_key: "projects", level: "view" },
  { page_key: "sales", level: "none" },
  { page_key: "scm.sales", level: "view" },
  { page_key: "service_cases", level: "edit" },
  ...SALES_JD_ROWS,
];

const SALES_DIRECTOR_NAME = /\bSales Director\b/i;

// ── The MONEY-MOVING WRITE carve-out ─────────────────────────────────────────
//
// Owner 2026-07-18, ruling on the default-full exposure: his instruction was
// "暂时都可以看到系统里的所有内容" — SEE everything. Seeing is not doing. So a
// FULL position keeps every READ (nothing below lowers a read) but does NOT get
// the money-moving WRITES; those stay with Finance Manager (and Super Admin).
//
// WHICH AREAS, measured against the routes rather than assumed (this repo's key
// lists have repeatedly been incomplete, so each was opened and read):
//   scm.finance.accounting — the real one. Gates /accounting/* (POST
//     /journal-entries, POST /journal-entries/:id/post, POST /post/si/:no, POST
//     /post/pi/:no — all post to the GL), /payment-vouchers/* (POST create,
//     PATCH, POST /:id/post, POST /:id/cancel — cash-out), and /payment-audit-log/*
//     (read-only). accounting.ts carries NO flat-permission gate of its own
//     (grep-verified: zero hasHouzsPerm / requirePermission), so the area guard is
//     its ONLY protection — which is exactly why the denial below has to exist.
//     payment-vouchers additionally checks flat scm.payment_voucher.* perms, so it
//     was already double-gated; accounting was not gated at all.
//   scm.finance.outstanding — /outstanding/* + /unbilled-deliveries/*, which have
//     ZERO write endpoints today (grep-verified). Included so the rule is
//     future-proof: a money write added under Outstanding tomorrow is denied by
//     default rather than silently open. Reducing it changes NOTHING today.
//
// DELIBERATELY OUT OF SCOPE, and this is a judgement the owner should see:
// issuing a Sales Invoice posts its own revenue JE (lib/post-si-revenue, called
// from routes/sales-invoices.ts on POST) and it rides `scm.sales.invoices`, not a
// finance key. That write is NOT carved out, because raising DO + SI is OFFICE's
// documented job — denying it would lock Office out of its core duty, which the
// "must not lock anyone out of anything else" bar forbids. Same for Purchase
// Invoice creation (scm.procurement.pi, Purchasing's job); the GL posting for a PI
// is a separate call that DOES ride scm.finance.accounting and IS carved out. So
// the line drawn here is: DOCUMENT ISSUANCE that books its own revenue stays with
// the department that owns the document; the DEDICATED finance surfaces (manual
// journal entries + payment vouchers) are Finance-only.
const MONEY_WRITE_AREAS: ReadonlySet<string> = new Set([
  "scm.finance.accounting",
  "scm.finance.outstanding",
]);

const MONEY_WRITE_POSITIONS: ReadonlySet<string> = new Set(
  ["Finance Manager", "Super Admin"].map(normalisePosition),
);

function canMoveMoney(positionName: string | null): boolean {
  const name = normalisePosition(positionName ?? "");
  return name ? MONEY_WRITE_POSITIONS.has(name) : false;
}

// ── The SCM MASTER-DATA WRITE cohort (scm.config.write, position-driven) ──────
//
// Owner-directed 2026-07-18, "ONE RULE — permissions position-driven": Purchasing
// had FULL page access to Products but was denied SKU import / product / price
// writes because the flat key `scm.config.write` lived on the ROLE, not the
// position. Rather than a roles.permissions data migration (brittle role-ids +
// staging-first + auto-applies to prod), the capability is defined HERE, off the
// stable position, exactly like canMoveMoney above and the isProductCostViewer
// precedent (which already keyed Purchasing's product COST visibility off
// position, owner-approved 2026-07-17).
//
// THE OWNER-EDITABLE LIST. These are the operation/purchasing positions that
// legitimately manage SCM master data (products / SKUs / prices / sofa combos /
// fabric / delivery fees / maintenance config). The owner tunes THIS one set.
// Exact normalised names (positionAccessSnapshot.ts) — same anti-injection rule
// as everywhere else in this module (no substring/word-boundary matching, so a
// free-text rename can never inject the write). Super Admin is included for the
// same reason MONEY_WRITE_POSITIONS includes it: a Super Admin whose ROLE somehow
// lacks `*` would otherwise reach this policy and lose a capability it has today
// (the `*` wildcard itself never reaches this module — auth.ts short-circuits).
//
// DELIBERATELY ABSENT (must stay 403 on config writes unless they hold the flat
// perm): Storekeeper / Storekeeper Supervisor / Driver / Helper (restricted,
// view-only), the whole Sales cohort, HR Manager, Service Admin, Calendar Viewer,
// and Finance Manager (config is not finance work — Finance keeps money writes,
// not master-data writes).
const CONFIG_WRITE_POSITIONS: ReadonlySet<string> = new Set(
  [
    "Procurement/Purchasing",
    "Operation Manager",
    "Operation Executive",
    "Logistic Admin",
    "Super Admin",
  ].map(normalisePosition),
);

function positionCanWriteConfig(positionName: string | null): boolean {
  const name = normalisePosition(positionName ?? "");
  return name ? CONFIG_WRITE_POSITIONS.has(name) : false;
}

// ── The GOD positions — position ⇒ '*' wildcard (owner 2026-07-20) ────────────
//
// Owner-directed: merge role + position onto ONE position-driven controller. A
// person in a god-tier POSITION is a full super admin — no roles.permissions
// grant needed. auth.ts injects '*' into permissions_set for these positions, so
// they flow through the SAME '*' machinery the Owner role already uses: the page
// short-circuit to fullAccessMap, every requirePermission site, and the money /
// config carve-outs (all of which already exempt '*'). Exact normalised-name
// membership, NEVER substring — so "Logistic Admin" / "Service Admin" are NOT
// caught, and a free-text rename can't inject god-mode (same anti-injection rule
// as MONEY_WRITE_POSITIONS / CONFIG_WRITE_POSITIONS above). "Owner" is listed
// ahead of the position existing so the owner + Test Admin (position=NULL today,
// '*' role-only) can be migrated onto it and roles.permissions can eventually
// retire. Additive only: it can only ever ADD '*', never remove a permission.
// "Managing Director" joined 2026-09-07 (owner: "managing director 和 super
// admin 同等级，通权限") — the MD position (prod positions id 25, Management,
// level 10 like Super Admin) is a full super admin by position, so the money /
// config carve-outs and every requirePermission door open for it exactly as
// they do for Super Admin.
const GOD_POSITIONS: ReadonlySet<string> = new Set(
  ["Super Admin", "Owner", "Managing Director"].map(normalisePosition),
);

/** True when this POSITION alone confers the '*' wildcard (full super admin).
 *  Exact normalised-name membership; unknown/empty → false. Consumed by
 *  services/auth.ts (hydrateAuthUser), which adds '*' to the caller's
 *  permission set so position drives god-mode without a role grant. */
export function positionGrantsWildcard(
  positionName: string | null,
  row?: PositionPolicyRow | null,
): boolean {
  if (row) return row.cohort === "god";
  const name = normalisePosition(positionName ?? "");
  return name ? GOD_POSITIONS.has(name) : false;
}

// Outsource Transporter joined 2026-11-28 (owner): a 3PL driver who uploads POD
// gets an Outsource Transporter account, which the sync_user_to_tms trigger links
// to an scm.drivers row (in_house=false). As a fleet position a linked one is
// scoped to its own stops, and an UNLINKED one fails CLOSED to an empty board
// rather than seeing the whole fleet's jobs.
const FLEET_POSITIONS: ReadonlySet<string> = new Set(
  ["Driver", "Helper", "Outsource Transporter"].map(normalisePosition),
);

/** True for a fleet position (Driver / Helper / Outsource Transporter) — the
 *  population resolveDeliveryScope narrows to their OWN assignments and, when
 *  unlinked, fails CLOSED to an empty board rather than exposing the whole fleet.
 *  Unknown/empty → false. */
export function isFleetPosition(
  positionName: string | null | undefined,
  row?: PositionPolicyRow | null,
): boolean {
  if (row) return row.is_fleet;
  const name = normalisePosition(positionName ?? "");
  return name ? FLEET_POSITIONS.has(name) : false;
}

const MONEY_DENY_REASON =
  "Posting journal entries and payment vouchers is handled by Finance. You can view this page, but ask Finance to post it.";

const isWriteMethod = (method: string): boolean =>
  method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";

/** The tolerant caller shape — mirrors SalesJdCaller so the area-guard's Houzs
 *  AuthUser and the SCM bridge's houzsUser both satisfy it. */
export interface MoneyWriteCaller {
  permissions?: ReadonlyArray<string> | ReadonlySet<string>;
  permissions_set?: ReadonlySet<string>;
  position_name?: string | null;
  position_policy?: PositionPolicyRow | null;
}

function hasWildcard(u: MoneyWriteCaller): boolean {
  if (u.permissions_set?.has("*")) return true;
  const p = u.permissions;
  if (!p) return false;
  return Array.isArray(p) ? p.includes("*") : (p as ReadonlySet<string>).has("*");
}

/**
 * Is this caller denied a money-moving WRITE on `area`? Returns the plain-language
 * reason for the 403 body, or null when the rule has nothing to say.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE MAP. Lowering the money keys to `view` in
 * page_access is NOT self-enforcing: scmAreaGuard skips the per-area check
 * entirely for any caller without an explicit `scm*` row, and a FULL position is
 * deliberately NOT scm_l2_configured (a full map needs no per-area enforcement).
 * So the `view` alone would be theatre — the exact trap salesJdAccess documents,
 * where a written "none" sat inert for three days while the URL kept returning
 * real data. This predicate is consulted BEFORE that no-lockout fallthrough, so
 * the money write is genuinely shut without forcing scm_l2_configured true (which
 * would start enforcing every other area and risks the z1 mass lockout).
 *
 * READS ARE NEVER DENIED — the method check is first and total. This rule can only
 * ever remove a WRITE on the two finance areas; it cannot narrow a read, and it
 * touches no other area.
 *
 * A CALLER THIS CANNOT IDENTIFY IS NOT DENIED (no position_name → null). That is
 * fail-OPEN, stated plainly and matching the salesJdDenial precedent: a
 * positionless user resolves from the legacy ROLE matrix and never reaches this
 * policy, so denying them here would be a new lockout on missing data.
 */
export function moneyWriteDenial(
  user: MoneyWriteCaller | null | undefined,
  area: string,
  method: string,
): string | null {
  if (!user) return null;
  if (!isWriteMethod(method)) return null;
  if (!MONEY_WRITE_AREAS.has(area)) return null;
  if (hasWildcard(user)) return null;
  if (user.position_policy) {
    return user.position_policy.cohort === "god" || user.position_policy.can_move_money
      ? null
      : MONEY_DENY_REASON;
  }
  const pos = user.position_name;
  if (!pos) return null;
  if (canMoveMoney(pos)) return null;
  return MONEY_DENY_REASON;
}

function withMoneyWriteRemoved(
  map: Record<string, AccessLevel>,
): Record<string, AccessLevel> {
  const out = { ...map };
  for (const key of MONEY_WRITE_AREAS) out[key] = "view";
  return out;
}

export interface PositionPolicyInput {
  position_name: string | null;
  department_name: string | null;
}

/**
 * The resolution outcome for a positioned, non-`*` user — ONE shape for all three
 * cohorts, every one of them now RESOLVED here (no deferral).
 *
 * - cohort "full"       — `pageAccess` = fullAccessMap() (unrestricted, owner-
 *                         approved interim), MINUS the money-moving writes unless
 *                         the position may move money (`flags.canMoveMoney`):
 *                         the finance areas drop to `view` so it SEES everything
 *                         and the write 403s. `scmConfigured` FALSE (same as `*`).
 * - cohort "restricted" — `pageAccess` = the owner's whitelist; `scmConfigured`
 *                         is the honest explicit-scm signal so the area-guard
 *                         enforces the whitelist's `none` denials.
 * - cohort "sales"      — `pageAccess` = the sales whitelist (prod rows + the
 *                         SALES_JD leaves), `scmConfigured` TRUE (the scm.sales
 *                         row — the same L2-configured signal sales carries today,
 *                         which is what keeps the delivery/invoices `view` caps
 *                         enforced at the area-guard). `flags` carries the scope /
 *                         margin / commission / announcement decisions the live
 *                         mechanisms (salesScope / canViewScmFinance / pmsAccess)
 *                         apply; a test pins the flags AGREE with those helpers.
 *
 * `flags` and `pageAccess` are present on EVERY result — `pageAccess` is a concrete
 * map for all three cohorts now (never null).
 */
export interface PositionPolicy {
  cohort: "full" | "restricted" | "sales";
  pageAccess: Record<string, AccessLevel>;
  scmConfigured: boolean;
  flags: PositionAccessFlags;
}

/**
 * Classify a position and, for the resolved cohorts, produce its page access.
 *
 * FAIL OPEN: a position that matches neither the restricted set nor the Sales
 * rule returns cohort "full". There is no path to an empty/near-empty map —
 * unknown and unrestricted both land on full. This is the anti-lockout
 * invariant, proven by positionPolicy.test.ts over every snapshot position plus
 * a hypothetical unclassified name.
 */
export function resolvePositionPolicy(
  input: PositionPolicyInput,
  row?: PositionPolicyRow | null,
): PositionPolicy {
  if (row) {
    const fromRow = policyFromRow(row);
    if (fromRow) return fromRow;
  }
  const name = normalisePosition(input.position_name ?? "");

  const rows = name
    ? RESTRICTED_ROWS.get(name) ??
      (isWarehouseCrewPosition(name) ? RESTRICTED_ROWS.get(normalisePosition("Warehouse Crew KL")) : undefined)
    : undefined;
  if (rows) {
    const meta: PageAccessMeta = { explicitScm: false };
    const pageAccess = resolvePositionAccessFromRows(rows, meta);
    return {
      cohort: "restricted",
      pageAccess,
      scmConfigured: meta.explicitScm,
      flags: FLAGS_RESTRICTED,
    };
  }

  if (isSalesCohort(input)) {
    const isDirector = SALES_DIRECTOR_NAME.test((input.position_name ?? "").trim());
    const meta: PageAccessMeta = { explicitScm: false };
    const pageAccess = resolvePositionAccessFromRows(
      isDirector ? SALES_DIRECTOR_ROWS : SALES_ORDINARY_ROWS,
      meta,
    );
    return {
      cohort: "sales",
      pageAccess,
      scmConfigured: meta.explicitScm,
      flags: isDirector ? FLAGS_SALES_DIRECTOR : FLAGS_SALES,
    };
  }

  const money = canMoveMoney(input.position_name);
  const config = positionCanWriteConfig(input.position_name);
  const baseFlags = money ? FLAGS_FULL_MONEY : FLAGS_FULL;
  const full = fullAccessMap();
  return {
    cohort: "full",
    pageAccess: money ? full : withMoneyWriteRemoved(full),
    scmConfigured: false,
    flags: config ? { ...baseFlags, canWriteConfig: true } : baseFlags,
  };
}

/**
 * Resolve a stored `position_policy` row to the same PositionPolicy shape the
 * name rule produces, through the SAME whitelists and flag constants, so a Title
 * on a row and a Title on its name cannot disagree (positionPolicyRows.test.ts
 * pins every seeded row byte-identical to its name). Returns null only for a
 * row whose profile the code does not know — the caller then falls back to the
 * name rule rather than locking anyone out on bad data.
 */
export function policyFromRow(row: PositionPolicyRow): PositionPolicy | null {
  switch (row.cohort) {
    case "restricted": {
      const rows = row.profile ? PROFILE_ROWS[row.profile as RestrictedProfile] : undefined;
      if (!rows) return null;
      const meta: PageAccessMeta = { explicitScm: false };
      const pageAccess = resolvePositionAccessFromRows(rows, meta);
      return { cohort: "restricted", pageAccess, scmConfigured: meta.explicitScm, flags: FLAGS_RESTRICTED };
    }
    case "sales": {
      if (row.profile !== "director" && row.profile !== "rep") return null;
      const isDirector = row.profile === "director";
      const meta: PageAccessMeta = { explicitScm: false };
      const pageAccess = resolvePositionAccessFromRows(
        isDirector ? SALES_DIRECTOR_ROWS : SALES_ORDINARY_ROWS,
        meta,
      );
      return {
        cohort: "sales",
        pageAccess,
        scmConfigured: meta.explicitScm,
        flags: isDirector ? FLAGS_SALES_DIRECTOR : FLAGS_SALES,
      };
    }
    case "god": {
      return {
        cohort: "full",
        pageAccess: fullAccessMap(),
        scmConfigured: false,
        flags: { ...FLAGS_FULL_MONEY, canWriteConfig: true },
      };
    }
    default: {
      const full = fullAccessMap();
      const baseFlags = row.can_move_money ? FLAGS_FULL_MONEY : FLAGS_FULL;
      return {
        cohort: "full",
        pageAccess: row.can_move_money ? full : withMoneyWriteRemoved(full),
        scmConfigured: false,
        flags: row.can_write_config ? { ...baseFlags, canWriteConfig: true } : baseFlags,
      };
    }
  }
}

/** The tolerant caller shape for the SCM master-data write rule — satisfied by
 *  the Houzs `AuthUser`, by the SCM bridge's `houzsUser`, and by the /auth/me
 *  serialiser. */
export interface ScmConfigWriteCaller extends MoneyWriteCaller {
  department_name?: string | null;
}

/**
 * May this caller WRITE SCM master data / config? THE one definition of the
 * `scm.config.write` question, so the backend gate and the screen cannot
 * disagree about it.
 *
 * WHY IT IS EXTRACTED (fix/so-maintenance-403, 2026-07-19). The rule already had
 * two halves — the flat permission key OR the position policy's `canWriteConfig`
 * (scm/lib/houzs-perms.canWriteScmConfig) — but only the BACKEND evaluated both.
 * SalesOrderMaintenance.tsx asked `can('scm.config.write')`, the flat half alone,
 * so every CONFIG_WRITE_POSITIONS holder (Procurement/Purchasing, Operation
 * Manager / Executive, Logistic Admin, Super Admin) whose ROLE lacks the flat key
 * was shown "Read-only view. Maintenance changes are admin/coordinator-only." on a
 * page whose writes the API would have accepted. That is the exact FE/BE
 * one-level drift salesJdAccess.ts's header warns about, and the fix is the same:
 * decide once, where the rule lives, and let both sides read the answer.
 *
 * Surfaced to the frontend as `scm_config_writer` on GET /api/auth/me, beside
 * project_finance_viewer / product_cost_viewer, which exist for this same reason.
 *
 * ORDER MATTERS ONLY FOR COST: the wildcard and the flat key are cheap set reads;
 * resolvePositionPolicy is last. Fails CLOSED on an unidentifiable caller.
 */
export function userCanWriteScmConfig(u: ScmConfigWriteCaller | null | undefined): boolean {
  if (!u) return false;
  if (hasWildcard(u)) return true;
  const perms = u.permissions_set ?? u.permissions;
  if (perms) {
    const held = Array.isArray(perms)
      ? perms.includes("scm.config.write")
      : (perms as ReadonlySet<string>).has("scm.config.write");
    if (held) return true;
  }
  return resolvePositionPolicy(
    {
      position_name: u.position_name ?? null,
      department_name: u.department_name ?? null,
    },
    u.position_policy ?? null,
  ).flags.canWriteConfig;
}
