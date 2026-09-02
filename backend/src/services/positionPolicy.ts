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
// The Sales JD's SCM leaf levels + cohort detection live in salesJdAccess and are
// IMPORTED here rather than restated: this module folds those SAME levels into the
// sales cohort's page-access rows, so there is ONE definition of "what a Sales
// position may do on the SCM sales chain" (orders/delivery/invoices/returns) and
// ONE Sales-cohort detection rule. salesJdAccess does not import this module, so
// there is no cycle.
import { SALES_JD, isSalesCohort } from "./salesJdAccess";

/** A code-defined explicit access row — same shape resolvePositionAccessFromRows
 *  reads from the DB, so the restricted whitelists resolve through the identical
 *  inherit/cascade + isValidPageKey filter as a real position_page_access row. */
interface PolicyRow {
  page_key: string;
  level: AccessLevel;
}

/** Lower-case + collapse internal whitespace + trim. Tolerant to casing/spacing
 *  drift only — NOT to substring matching (a `\b(...)`-style match would let an
 *  unrelated rename inject a restriction; see the operationJdAccess hazard note
 *  this repo carried). */
function normalisePosition(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── Enforcement flags — the shape the CONVERGED policy carries for every
//    position, so the follow-up folds sales in without a second structure ─────
//
// These describe the non-page-access dimensions of a position's authority. They
// are DECLARATIVE — no live gate reads them yet; each cohort's behaviour is
// enforced by its page-access map plus the existing mechanisms. For SALES they
// RECORD what salesScope (own+downline) / canViewScmFinance (margin) / pmsAccess
// (director) / enforceSalesDirectorScope (dept announcements) enforce from the
// SAME org fields this policy classifies on, and positionPolicy.test.ts pins that
// the flags AGREE with those helpers caller-for-caller. So the policy is the one
// authority for "who is this position and what may they do", the mechanisms are
// its hands, and a test proves they have not drifted — rather than rewiring every
// mechanism through the flags in one risky step (canViewAllSales, for one, is
// director-narrow and would leak sales visibility to every full-cohort position if
// naively pointed at orderScope==='all').
export interface PositionAccessFlags {
  /** Row-scope for order-bearing documents (SO/DO/SI/PO...). Sales reps see
   *  their own + downline; everyone else sees all. Enforced today by
   *  lib/salesScope for the sales cohort. */
  orderScope: "own_downline" | "all";
  /** May see cost / margin columns. Hidden from the sales cohort today
   *  (canViewScmFinance / pmsAccess). */
  canSeeMargin: boolean;
  /** May see commission figures across the downline. */
  canSeeCommission: boolean;
  /** Announcement visibility. Sales is dept-scoped; management/ops see all.
   *  (Announcements are permission-gated today — announcements.read — so this is
   *  the flag the converged policy will drive, not a live gate this PR.) */
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

/** The unrestricted / management default — SEE everything, but do NOT move money. */
const FLAGS_FULL: PositionAccessFlags = {
  orderScope: "all",
  canSeeMargin: true,
  canSeeCommission: true,
  announcementScope: "all",
  canMoveMoney: false,
  // Default OFF even for the full cohort — only the named CONFIG_WRITE_POSITIONS
  // get it, layered on in resolvePositionPolicy (mirrors how canMoveMoney is set).
  canWriteConfig: false,
};

/** Finance authority — full, INCLUDING the money-moving writes. */
const FLAGS_FULL_MONEY: PositionAccessFlags = {
  ...FLAGS_FULL,
  canMoveMoney: true,
};

/** Restricted labour cohort — they do not operate order documents, and must not
 *  see money. Conservative by construction (their page-access map already denies
 *  the surfaces these would gate). */
const FLAGS_RESTRICTED: PositionAccessFlags = {
  orderScope: "all", // they reach no order-bearing page, so scope is moot
  canSeeMargin: false,
  canSeeCommission: false,
  announcementScope: "dept",
  canMoveMoney: false,
  // Storekeeper / Driver / Helper are view-only — every config/master write 403s.
  canWriteConfig: false,
};

/** Ordinary Sales (Sales Manager / Executive / Person) — RECORDS the enforcement
 *  the live mechanisms apply to a non-director rep: own+downline row scope
 *  (salesScope, because they are not isDirectorUser and hold no scm.so.view_all),
 *  margin hidden (canViewScmFinance false — they resolve to pmsAccess SALES, not
 *  DIRECTOR), commission hidden, dept-scoped announcements. A test pins that these
 *  match the live helpers caller-for-caller. */
const FLAGS_SALES: PositionAccessFlags = {
  orderScope: "own_downline",
  canSeeMargin: false,
  canSeeCommission: false,
  announcementScope: "dept",
  canMoveMoney: false,
  // Sales does not manage SCM master data.
  canWriteConfig: false,
};

/** Sales DIRECTOR — the director tier WITHIN sales. Differs from the ordinary rep
 *  on exactly the two dimensions the live helpers already treat him differently:
 *  order scope is ALL (pmsAccess.isDirectorUser("Sales Director") → canViewAllSales
 *  true) and margin is VISIBLE (isFinanceViewer → DIRECTOR → canViewScmFinance
 *  true). Announcements stay dept-scoped (his announcements are scoped to the Sales
 *  Department — isSalesDirectorUser / enforceSalesDirectorScope). Commission stays
 *  hidden here (no live reader today; declarative — see the flags interface). He
 *  still may NOT move money. */
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

// ── The restricted whitelists — the owner's manual, per position ─────────────
//
// Anything NOT listed for a restricted position resolves to "none" (via the
// resolver's pass-1 default), which is what "EVERYTHING ELSE: none" means. Only
// real PAGES[] keys appear here; the resolver's isValidPageKey filter drops any
// key that later leaves the registry.
//
// WHY THE L1 AREA KEYS APPEAR HERE. The nav is filtered by navFilter.ts: a node
// shows only if it passes its OWN visibility gate AND (for a group) has a
// surviving child. The top-level "Supply Chain" umbrella's gate is its `anyAccess`
// = the L1 area keys ONLY (`scm.warehouse`, `scm.transportation`, …), and for an
// scm_l2_configured user the `scm.access` permission is STRIPPED from the nav perm
// check — so an L2-only grant (e.g. `scm.warehouse.inventory` alone) leaves the
// umbrella's gate failing and the WHOLE SCM tree is dropped before the leaf is
// reached. So a restricted whitelist must carry the L1 parent of each area it
// grants, at `view`, and then explicitly DENY the sibling children it must not
// open (an explicit `none` overrides the parent's inherited `view`). L1 area keys
// gate NO backend route (routes gate on the L2 keys — verified in scm/index.ts),
// so granting the L1 opens nav visibility WITHOUT opening any write.
//
// Delivery Planning is gated — nav, route, AND every /delivery-planning, /trips,
// /dp-orders, /fleet, /lorry-* backend mount — on `scm.transportation.drivers`
// (verified against scm/index.ts + Sidebar.tsx + App.tsx). Granting the L1
// `scm.transportation` = view inherits `scm.transportation.drivers` = view, which
// shows the board and satisfies the GET reads (it also shows Fleet / Lorry /
// Regions — they ride the SAME key, unchanged from today's Driver/Helper). The
// driver's own POD / delivery-step SUBMIT is a WRITE on that same key and stays a
// follow-up (owner: page-level view now; the "only MY assigned jobs" row-scope +
// step submit is a separate build). Announcements is NOT a page-access key — it
// is gated on the `announcements.read` PERMISSION (routes/announcements.ts) — so
// it is unaffected by this map and stays open exactly as today; absent here.

const DRIVER_HELPER_ROWS: readonly PolicyRow[] = [
  // Delivery Planning board — view only. L1 grant; drivers inherits view.
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
  // Everything Driver/Helper get.
  { page_key: "scm.transportation", level: "view" },
  // Projects / PMS — view, same rows as Driver/Helper (owner 2026-07-21:
  // storekeepers work events alongside the crew; the projects endpoints
  // additionally row-scope helpers/storekeepers to events they're crewed on
  // — isCrewScopedUser in routes/projects.ts).
  { page_key: "projects", level: "view" },
  { page_key: "projects.finances", level: "none" },
  { page_key: "projects.maintenance", level: "none" },
  // Warehouse RACKING + rack/bin inventory VIEW. Racking/bin live under the
  // Inventory + Warehouses pages, both gated on scm.warehouse.inventory (there
  // is no finer racking key). The L1 `scm.warehouse` = view opens the Warehouse
  // nav group; inventory = view shows the stock listing / racks. Stock Transfer /
  // Stock Take / Stock Adjustment are explicitly DENIED so they do not inherit
  // the parent's view: a Storekeeper VIEWS inventory but every stock-mutating
  // write 403s (adjustments is now its own separately-guarded write).
  { page_key: "scm.warehouse", level: "view" },
  { page_key: "scm.warehouse.inventory", level: "view" },
  { page_key: "scm.warehouse.transfers", level: "none" },
  { page_key: "scm.warehouse.stock_take", level: "none" },
  { page_key: "scm.warehouse.adjustments", level: "none" },
];

const STOREKEEPER_SUPERVISOR_ROWS: readonly PolicyRow[] = [
  // Everything Storekeeper gets.
  { page_key: "scm.transportation", level: "view" },
  { page_key: "projects", level: "view" },
  { page_key: "projects.finances", level: "none" },
  { page_key: "projects.maintenance", level: "none" },
  { page_key: "scm.warehouse", level: "view" },
  { page_key: "scm.warehouse.inventory", level: "view" },
  { page_key: "scm.warehouse.transfers", level: "none" },
  { page_key: "scm.warehouse.stock_take", level: "none" },
  { page_key: "scm.warehouse.adjustments", level: "none" },
  // Goods Receipt — edit, so the supervisor can RECEIVE goods (raise/confirm a
  // GRN is a write). This grant alone keeps the Procurement nav GROUP alive (the
  // group survives on the grn child), so the L1 `scm.procurement` is deliberately
  // NOT granted — granting it would cascade `view` onto Purchase Order / Purchase
  // Invoice / Products / Suppliers / MRP / Purchase Returns, which the manual
  // denies. So `scm.procurement` stays none (po / pi / … inherit none), and only
  // Goods Receipt opens.
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

/**
 * The restricted cohort, keyed by normalised position name. Each entry is the
 * WHOLE of that position's page access (default-none for everything unlisted).
 *
 * Aliases: the map is the single place a future documented rename is added, so a
 * partial revert never silently drops a restriction — none of the renames the
 * repo has seen ("Purchasing"->"Procurement/Purchasing", "Logistic"->"Logistic
 * Admin") touch these names, so no alias is needed today.
 */
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

// ── The Sales cohort's page access — folded IN, no longer deferred ───────────
//
// Each sales position's whitelist is its PROD ROWS (positionAccessSnapshot, the
// owner's live photograph) PLUS the imported SALES_JD leaf levels. Feeding both
// through resolvePositionAccessFromRows below reproduces EXACTLY the pre-fold
// resolution — which was loadPageAccessForPosition(prod rows) THEN
// applySalesJdOverride(SALES_JD) — because SALES_JD's keys are all leaves of
// scm.sales: setting a leaf as an explicit row is identical to overriding it after
// the parent's inheritance cascaded (proven in positionPolicy.test.ts, before/after
// over the snapshot). The `scm.sales` parent row makes explicitScm true, so the
// cohort is scm_l2_configured exactly as it is today — which is what keeps the
// area-guard ENFORCING the delivery/invoices `view` caps for a real sales position.
//
// SALES_JD is the SINGLE definition of those four leaf levels; it is imported, not
// restated, so the map here and the applySalesJdOverride fallback (positionless
// Sales-department users) can never drift.
const SALES_JD_ROWS: readonly PolicyRow[] = Object.entries(SALES_JD).map(
  ([page_key, level]) => ({ page_key, level }),
);

// Sales Director (prod row scm.sales=full + the projects.calendar view his row
// carries). Director tier: scm.sales=full, view-all scope, margin visible, and
// — since 2026-09-01 — the Products & Maintenance area at `edit`.
//
// WHY THE PRODUCTS ROW IS HERE AND NOT IN Team > Positions. For the sales cohort
// this array IS the page access: resolvePositionPolicy feeds it to the resolver
// and the position_page_access rows in the DB are not read at all (the audit
// prints them under "NO LONGER READ for a positioned user"). So the owner cannot
// grant this from the Positions screen — the grant has to land here.
//
// `edit`, not `full`: every scmAreaGuard in the Products area defaults to
// writeLevel "edit" and none asks for "full", so `edit` is exactly what the
// price / combo / model writes need. The gap is deliberate — anything a later
// route marks full-only stays out until someone decides it belongs here.
const SALES_DIRECTOR_ROWS: readonly PolicyRow[] = [
  { page_key: "projects", level: "view" },
  { page_key: "projects.calendar", level: "view" },
  { page_key: "sales", level: "none" },
  { page_key: "scm.sales", level: "full" },
  { page_key: "scm.procurement.products", level: "edit" },
  { page_key: "service_cases", level: "edit" },
  ...SALES_JD_ROWS,
];

// Sales Manager / Executive / Person — the ordinary rep row (prod scm.sales=view).
const SALES_ORDINARY_ROWS: readonly PolicyRow[] = [
  { page_key: "projects", level: "view" },
  { page_key: "sales", level: "none" },
  { page_key: "scm.sales", level: "view" },
  { page_key: "service_cases", level: "edit" },
  ...SALES_JD_ROWS,
];

// The Sales-DIRECTOR split within the cohort. Matched with `\b` (word boundary),
// the SAME rule pmsAccess.isSalesDirectorUser / DIRECTOR_POSITIONS use — so the
// policy's director classification agrees with the live director helpers
// (canViewAllSales / canViewScmFinance) that actually enforce the scope + margin
// tier. A cohort member who is NOT a Sales Director gets the ordinary rep rows.
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

/**
 * Positions that MAY move money. Finance Manager because it is his job; Super
 * Admin because the owner named it alongside `*` — a Super Admin whose ROLE lacks
 * the `*` wildcard would otherwise reach this policy and be stripped of a
 * capability it has today. The `*` wildcard itself never reaches this module
 * (auth.ts short-circuits to fullAccessMap) and is exempt inside the denial too.
 */
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

/** True when this position may WRITE SCM master data / config by virtue of the
 *  position alone (the flat `scm.config.write` perm is checked separately and
 *  OR-ed in by scm/lib/houzs-perms.canWriteScmConfig — this is never the only
 *  gate). Exact normalised-name membership; unknown/empty → false. */
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
const GOD_POSITIONS: ReadonlySet<string> = new Set(
  ["Super Admin", "Owner"].map(normalisePosition),
);

/** True when this POSITION alone confers the '*' wildcard (full super admin).
 *  Exact normalised-name membership; unknown/empty → false. Consumed by
 *  services/auth.ts (hydrateAuthUser), which adds '*' to the caller's
 *  permission set so position drives god-mode without a role grant. */
export function positionGrantsWildcard(positionName: string | null): boolean {
  const name = normalisePosition(positionName ?? "");
  return name ? GOD_POSITIONS.has(name) : false;
}

// FLEET PERSONNEL — the restricted positions who drive/ride a run sheet and so
// must see ONLY their own delivery jobs. The wider restricted cohort also holds
// Storekeeper / Storekeeper Supervisor, who are NOT fleet: the delivery board
// is a coordination surface for them, not a per-person run sheet, so they are
// not fail-closed by resolveDeliveryScope. Exact normalised-name membership.
const FLEET_POSITIONS: ReadonlySet<string> = new Set(
  ["Driver", "Helper"].map(normalisePosition),
);

/** True for a fleet position (Driver / Helper) — the population resolveDelivery
 *  Scope narrows to their OWN assignments and, when unlinked, fails CLOSED to an
 *  empty board rather than exposing the whole fleet. Unknown/empty → false. */
export function isFleetPosition(positionName: string | null | undefined): boolean {
  const name = normalisePosition(positionName ?? "");
  return name ? FLEET_POSITIONS.has(name) : false;
}

/** Plain-language reason for the 403 body — a sentence a person can act on. */
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
  // Reads are always allowed — "SEE everything" is the whole point.
  if (!isWriteMethod(method)) return null;
  if (!MONEY_WRITE_AREAS.has(area)) return null;
  // The owner / IT wildcard is never narrowed.
  if (hasWildcard(user)) return null;
  // Unidentifiable caller (no position) → not denied; see docstring.
  const pos = user.position_name;
  if (!pos) return null;
  if (canMoveMoney(pos)) return null;
  return MONEY_DENY_REASON;
}

/** Lower the money-moving areas to `view` on an otherwise-full map. Reads stay
 *  (view satisfies every GET gate + every nav `!== "none"` check — verified: no
 *  finance nav entry or route uses `pageAccessFull`), writes lose `edit`. */
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
export function resolvePositionPolicy(input: PositionPolicyInput): PositionPolicy {
  const name = normalisePosition(input.position_name ?? "");

  // Restricted whitelist wins first — an exact-name cohort, so a Sales position
  // can never fall in here. Regional warehouse-crew names fall back to the
  // Warehouse Crew whitelist by prefix (see RESTRICTED_ROWS note).
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

  // Sales — now RESOLVED here (no longer deferred). The whitelist is the prod row
  // + the SALES_JD leaves, run through the SAME resolver; the scm.sales row flips
  // explicitScm true so the cohort stays scm_l2_configured exactly as today. The
  // Sales Director gets the director row (scm.sales=full) + director flags; every
  // other cohort member gets the ordinary rep row + rep flags. Matched on the org
  // fields, not the matrix.
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

  // Everyone else — and anything unclassified — is FULL (owner-approved interim,
  // fail-open). `scmConfigured` FALSE, same as `*`: a full map needs no per-area
  // enforcement.
  //
  // The MONEY-MOVING WRITE carve-out rides on top: Finance Manager / Super Admin
  // keep the finance areas at `full`; every other full position (and every
  // unclassified position that fails open to full) has them lowered to `view` —
  // it SEES all the finance data and the write 403s (moneyWriteDenial). Nothing
  // else in the map moves, and no read is lowered anywhere.
  //
  // The SCM MASTER-DATA WRITE flag rides on top too, independently: the named
  // CONFIG_WRITE_POSITIONS (operation/purchasing) get `canWriteConfig: true` so
  // scm/lib/houzs-perms.canWriteScmConfig lets them DO the master-data writes
  // they can SEE, without a role grant. Every other full/unclassified position
  // keeps it false. This only ever GRANTS a write — page access and money are
  // untouched.
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
  return resolvePositionPolicy({
    position_name: u.position_name ?? null,
    department_name: u.department_name ?? null,
  }).flags.canWriteConfig;
}
