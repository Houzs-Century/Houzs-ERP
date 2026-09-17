// ----------------------------------------------------------------------------
// capabilities — THE resolved answer set for "what may this user do".
//
// Owner's architectural ruling, 2026-07-19:
//   "我们的权限全部要用 backend 来做，这样子它连渲染都不需要渲染，
//    frontend 那边就不会那么忙。"
//
// The frontend must not COMPUTE a permission. It must be TOLD one. This module
// is where the telling is assembled: one pass, server-side, per /auth/me, that
// turns the raw grants (roles.permissions flat keys + the position policy + the
// stable org fields) into a flat map of BOOLEAN ANSWERS the client consumes
// verbatim.
//
// ── THE ONE RULE OF THIS FILE ────────────────────────────────────────────────
//
// IT INVENTS NO POLICY. Every predicate below is a COMPOSITION of a function
// that already gates the API — imported, never restated. That is deliberate and
// it is the entire anti-drift mechanism: a capability cannot disagree with the
// gate it describes, because it IS the gate, called with the same caller.
//
// The alternative — restating "isFinanceViewer OR the flat key" here — is what
// this file exists to abolish. It is precisely how the frontend came to have a
// second, staler copy of every rule:
//
//   * SO Maintenance asked `can('scm.config.write')`, the FLAT half only, while
//     the API gate had accepted `flat OR positionPolicy.canWriteConfig` since
//     2026-07-18. Two answers to one question, one on each side of the wire, and
//     the position-granted config writers were shown "Read-only view" over a page
//     whose edits the API would have taken.
//   * `product_cost_viewer` had to be split OUT of `project_finance_viewer` after
//     an owner ruling sat dead for a month because two questions shared one flag.
//
// So: to add a capability, IMPORT the gate and name it. If no backend gate
// exists for the action yet, WRITE THE GATE FIRST and then name it here. A
// capability with no enforcing gate behind it is a UI hint, not a permission,
// and it does not belong in this map.
//
// ── FAILING CLOSED IS MANDATORY ──────────────────────────────────────────────
//
// There is no `?? true`, no `?? []`, no empty-object default anywhere in this
// path, and there must never be one. `resolveCapabilities(null)` returns every
// capability FALSE — not an empty map, which a client could read as "no rules,
// therefore allowed". An unresolvable capability set is an ERROR to surface, not
// a blank to fill.
// ----------------------------------------------------------------------------

import { isCrewScopedUser, isDefectReviewerPosition } from "./projectGates";
import { canUseAssistant } from "./assistant-scope";
import type { PositionPolicyRow } from "./positionPolicyRows";
import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";
import {
  isDirectorUser,
  isFinanceViewer,
  isProductCostViewer,
  isSalesDirectorUser,
  isSalesUser,
} from "./pmsAccess";
import { moneyWriteDenial, resolvePositionPolicy, type MoneyWriteCaller } from "./positionPolicy";
import { fairReportAccess, FAIR_STAGES } from "../scm/lib/fair-report";

/**
 * The caller shape a capability predicate may read. Structurally satisfied by
 * the full Houzs `AuthUser`, by the SCM bridge's stashed `houzsUser` (which
 * mirrors position_name + department_name for exactly these checks — see
 * scm/middleware/auth.ts), and by a hand-built test literal.
 *
 * Everything is optional EXCEPT that an absent field must resolve to a DENIAL,
 * never to a grant — every predicate below inherits that from the imported gate,
 * each of which already fails closed on a null/positionless caller.
 */
export interface CapabilityCaller {
  permissions?: ReadonlyArray<string>;
  permissions_set?: ReadonlySet<string>;
  position_name?: string | null;
  department_name?: string | null;
  position_policy?: PositionPolicyRow | null;
}

/** Adapt a `CapabilityCaller` to the `AuthUser`-shaped argument the pmsAccess /
 *  fair-report gates take. Those gates read ONLY position_name, department_name
 *  and permissions_set — asserted by capabilities.test.ts, which calls each gate
 *  through both this adapter and a full AuthUser and pins the answers equal. */
function asAuthUser(u: CapabilityCaller): AuthUser {
  return {
    position_name: u.position_name ?? null,
    department_name: u.department_name ?? null,
    position_policy: u.position_policy ?? null,
    permissions_set: u.permissions_set ?? new Set(u.permissions ?? []),
  } as unknown as AuthUser;
}

/** Adapt to the tolerant caller shape `moneyWriteDenial` takes. It reads the
 *  wildcard out of EITHER `permissions` or `permissions_set` and the position
 *  name; nothing else. */
function asMoneyCaller(u: CapabilityCaller): MoneyWriteCaller {
  return {
    permissions: u.permissions,
    permissions_set: u.permissions_set,
    position_name: u.position_name ?? null,
    position_policy: u.position_policy ?? null,
  };
}

/** The caller's granted flat keys, in whichever shape they arrived. Empty when
 *  the caller carries none — `hasPermission([], k)` is false, so this fails
 *  closed rather than throwing. */
function granted(u: CapabilityCaller): ReadonlyArray<string> | ReadonlySet<string> {
  return u.permissions_set ?? u.permissions ?? [];
}

/* Two predicates are named ahead of the registry because a third entry composes
   them. Referencing `PREDICATES[k]` from inside the object literal that defines
   `PREDICATES` would make its inferred type circular, so the shared terms live
   here and BOTH the registry entry and the composition call the same function —
   which is the point: one definition, two readers. */

/** `scm.config.write` — see the registry entry for the gate this mirrors. */
function canWriteScmConfigFor(u: CapabilityCaller): boolean {
  return (
    hasPermission(granted(u), "scm.config.write") ||
    resolvePositionPolicy(
      {
        position_name: u.position_name ?? null,
        department_name: u.department_name ?? null,
      },
      u.position_policy ?? null,
    ).flags.canWriteConfig
  );
}

/** `org.director` — pmsAccess.isDirectorUser, verbatim. */
function isDirectorFor(u: CapabilityCaller): boolean {
  return isDirectorUser(asAuthUser(u));
}

/**
 * THE REGISTRY. Key → the predicate that answers it.
 *
 * Each entry names the backend gate it composes, so a reviewer can check the
 * pairing without leaving this file, and capabilities.test.ts pins every pairing
 * over a matrix of synthetic callers.
 */
const PREDICATES = {
  /** May WRITE SCM master data / config.
   *  GATE: scm/lib/houzs-perms.canWriteScmConfig — `flat key OR positionPolicy
   *  .canWriteConfig`. Restated here as the same two terms over the same inputs
   *  because that gate takes a Hono context, not a user; capabilities.test.ts
   *  pins the two equal over every position in the snapshot. */
  "scm.config.write": canWriteScmConfigFor,

  /** May see COST / MARGIN / per-category subtotals on SCM documents.
   *  GATE: scm/lib/houzs-perms.canViewScmFinance → pmsAccess.isFinanceViewer.
   *  This is the same function /auth/me's `project_finance_viewer` is computed
   *  from; the capability is the newer name for that answer. */
  "scm.finance.view": (u: CapabilityCaller): boolean => isFinanceViewer(asAuthUser(u)),

  /** May see a product / SKU COST price (`cost_price_sen`), and ONLY that.
   *  GATE: scm/lib/houzs-perms.canViewScmProductCost → pmsAccess.isProductCostViewer.
   *  Deliberately WIDER than scm.finance.view by exactly one function —
   *  Procurement/Purchasing. Keep the two questions apart: merging them is how an
   *  owner ruling sat dead for a month. */
  "scm.productCost.view": (u: CapabilityCaller): boolean => isProductCostViewer(asAuthUser(u)),

  /** May see ALL sales-side documents rather than own+downline.
   *  GATE: scm/lib/houzs-perms.canViewAllSales — `flat scm.so.view_all OR
   *  pmsAccess.isDirectorUser`. */
  "scm.sales.viewAll": (u: CapabilityCaller): boolean =>
    hasPermission(granted(u), "scm.so.view_all") || isDirectorUser(asAuthUser(u)),

  /** May MOVE MONEY — post a journal entry, or raise/post/cancel a payment
   *  voucher. Seeing is not doing: the default-full cohort reads every money
   *  surface and still may not post.
   *
   *  GATE: positionPolicy.moneyWriteDenial, CALLED DIRECTLY (a denial reason of
   *  `null` is the grant) rather than reading `flags.canMoveMoney`. That flag is
   *  NOT the gate and the two do not agree: the live rule also passes the `*`
   *  wildcard, and it fails OPEN for a caller with no position_name, neither of
   *  which the flag knows about. Reading the flag here would have shipped a
   *  capability that told the Owner he may not post a voucher the API would have
   *  accepted — the exact SO-Maintenance bug, rebuilt inside the machine meant to
   *  prevent it. `scm.finance.accounting` + POST is the canonical money-write
   *  probe; the guard applies the same rule to `scm.finance.outstanding`.
   *
   *  ONE DELIBERATE ASYMMETRY: `moneyWriteDenial(null, …)` returns null, i.e. the
   *  GATE fails open on a null caller, while `resolveCapabilities(null)` denies.
   *  The capability is therefore never WIDER than the gate, only narrower, and
   *  only in a case that cannot reach a client — /auth/me 401s before it has a
   *  user to resolve. Narrower-than-the-gate is the safe direction and the one
   *  the fail-closed rule requires. */
  "scm.money.move": (u: CapabilityCaller): boolean =>
    moneyWriteDenial(asMoneyCaller(u), "scm.finance.accounting", "POST") === null,

  /** Fair Report, PER STAGE. GATE: scm/lib/fair-report.fairReportAccess — called
   *  directly, so the nav/tab visibility and the 403 are literally one function.
   *  The FE previously re-derived these three tiers in auth/salesAccess.ts
   *  (fairAllowedStages), a second copy of an owner ruling. */
  "fair.so.view": (u: CapabilityCaller): boolean => fairReportAccess("so", asAuthUser(u)).allowed,
  "fair.do.view": (u: CapabilityCaller): boolean => fairReportAccess("do", asAuthUser(u)).allowed,
  "fair.invoice.view": (u: CapabilityCaller): boolean =>
    fairReportAccess("invoice", asAuthUser(u)).allowed,

  /** May this caller OPEN the Fair / Sales Report at all — the nav row, the route
   *  mount, the mobile overlay — as opposed to any one document stage. GATE:
   *  scm/lib/fair-report.fairReportAccess ORed over every stage, so it is the SAME
   *  gate the per-stage 403 enforces; a caller allowed on no stage is refused here
   *  too. The FE previously re-derived this as auth/salesAccess.canViewFairReport
   *  (fairAllowedStages(...).length > 0), a second copy of the owner ruling. */
  "fair.report.view": (u: CapabilityCaller): boolean =>
    FAIR_STAGES.some((stage) => fairReportAccess(stage, asAuthUser(u)).allowed),

  /**
   * May this caller OPEN the SO Maintenance screen at all — nav row, route
   * mount, toolbar button, mobile overlay.
   *
   * THE UNION OF THE TWO TIERS THE PAGE ACTUALLY SERVES, and the only entry here
   * that composes rather than names a single gate — stated openly because the
   * page's authority is genuinely split across two backend gates:
   *   • a CONFIG WRITER edits it   (every write → houzs-perms.canWriteScmConfig)
   *   • a DIRECTOR reads it        (admitted for the read-only view, the tier the
   *                                 owner named on 2026-07-15)
   *
   * WHY THIS EXISTS. Four frontend sites — App.tsx SoMaintenanceGuard,
   * MfgSalesOrdersListV2 `canMaintain`, MobileApp's `directorOnly` menu row and
   * its overlay — all gated the page on `isDirectorUser` ALONE. That cohort is
   * {`*`, Super Admin, Sales Director, Finance Manager}. The cohort the API lets
   * WRITE is {`*`, flat-key holders, Procurement/Purchasing, Operation Manager,
   * Operation Executive, Logistic Admin, Super Admin}. The two overlap on Super
   * Admin and `*` and disagree about everyone else, in BOTH directions:
   *
   *   • Sales Director / Finance Manager get IN and cannot write (harmless — they
   *     are the read-only tier, and correct).
   *   • Procurement/Purchasing, Operation Manager/Executive and Logistic Admin —
   *     the very positions the owner ruled on 2026-07-18 must be able to DO the
   *     master-data writes they can see — were bounced to <Forbidden> at the
   *     door. The API would have accepted every one of their edits.
   *
   * Fixing the page's read-only BANNER (fix/so-maintenance-403) does not reach
   * this: the banner is inside a route those positions never get to mount.
   *
   * ADDITIVE BY CONSTRUCTION — a union with the old predicate as one of its two
   * terms, so no user who can open the page today loses it. Non-director SALES
   * stays out, which is the 2026-07-15 ruling: the sales cohort's canWriteConfig
   * is false, so neither term admits them.
   */
  "scm.maintenance.open": (u: CapabilityCaller): boolean =>
    canWriteScmConfigFor(u) || isDirectorFor(u),

  /** Is this caller Sales staff by STABLE ORG FIELDS. GATE: pmsAccess.isSalesUser
   *  — the classifier the SO row-scope and the Service-Case admittance both use.
   *  The FE mirrored it as auth/salesAccess.isSalesStaff with the dept/position
   *  terms in the OPPOSITE order and its own regex copy. */
  "org.sales.staff": (u: CapabilityCaller): boolean => isSalesUser(asAuthUser(u)),

  /** Is this caller the DIRECTOR tier that sees all data. GATE:
   *  pmsAccess.isDirectorUser (`*` wildcard OR an exact director position name). */
  "org.director": isDirectorFor,

  /** Is this caller EXACTLY the "Sales Director" position — the signal for the
   *  DEPARTMENT-SCOPED Team grant. GATE: pmsAccess.isSalesDirectorUser. Exact
   *  normalised name on both sides: a free-text rename must never slide into a
   *  tier. */
  "org.salesDirector": (u: CapabilityCaller): boolean => isSalesDirectorUser(asAuthUser(u)),

  /** Is this caller the defect REVIEWER position (Storekeeper Supervisor's job:
   *  triage fresh defects outside the region states). GATE:
   *  projectGates.isDefectReviewerPosition — the Title's row, then its name. */
  "org.defect.reviewer": (u: CapabilityCaller): boolean => isDefectReviewerPosition(asAuthUser(u)),

  /** Is this caller CREW-SCOPED on projects (sees only the events they are
   *  crewed on: helpers, storekeepers, the warehouse crew). GATE:
   *  projectGates.isCrewScopedUser — the Title's row, then its name. */
  "org.crew.scoped": (u: CapabilityCaller): boolean => isCrewScopedUser(asAuthUser(u)),

  /** May this caller open the Assistant at all. GATE: assistant-scope.canUseAssistant
   *  — wildcard yes, field crew + Sales denied, an unrecognised position fails
   *  CLOSED. The FE mirrored this deny list twice (auth/assistantAccess.ts route
   *  guard + Sidebar hideForPositions); both now read this answer instead. */
  "org.assistant.use": (u: CapabilityCaller): boolean => canUseAssistant(asAuthUser(u)),
} as const satisfies Record<string, (u: CapabilityCaller) => boolean>;

/** Every capability key, frozen in declaration order. The frontend pins its own
 *  union against this list (frontend/src/auth/capabilities.test.ts reads this
 *  file), so a key added here without a client counterpart fails CI rather than
 *  silently resolving to "denied" on a screen nobody rechecked. */
export const CAPABILITY_KEYS = Object.keys(PREDICATES).sort() as ReadonlyArray<CapabilityKey>;

export type CapabilityKey = keyof typeof PREDICATES;

/** The wire shape — every key present, every value a real boolean. Never
 *  partial: a missing key is indistinguishable from a false one at the call
 *  site, and "indistinguishable" is how a fail-open starts. */
export type CapabilitySet = Readonly<Record<CapabilityKey, boolean>>;

/** The all-false set — the answer for an unresolvable caller. Built fresh per
 *  call rather than shared, so no consumer can mutate the denial into a grant. */
function denyAll(): CapabilitySet {
  const out = {} as Record<CapabilityKey, boolean>;
  for (const key of Object.keys(PREDICATES) as CapabilityKey[]) out[key] = false;
  return out;
}

/**
 * Resolve the FULL capability set for a caller. ONE pass, server-side, per
 * request — not per component, which is the work the owner objected to the
 * frontend doing.
 *
 * Fails CLOSED on every axis: a null/undefined caller yields all-false, and each
 * individual predicate inherits the fail-closed behaviour of the gate it
 * composes (an unpositioned caller resolves to the restricted policy, not the
 * full one). A predicate that THROWS is also a denial — a capability we cannot
 * compute is not one we may grant, and the throw is re-surfaced by the caller
 * (routes/auth.ts) rather than swallowed into a blank.
 */
export function resolveCapabilities(
  u: CapabilityCaller | null | undefined,
  opts?: { costingDisplayEnabled?: boolean },
): CapabilitySet {
  if (!u) return denyAll();
  const out = {} as Record<CapabilityKey, boolean>;
  for (const key of Object.keys(PREDICATES) as CapabilityKey[]) {
    out[key] = PREDICATES[key](u) === true;
  }
  // GLOBAL cost/margin DISPLAY switch (env COSTING_DISPLAY_ENABLED, resolved by
  // scm/lib/costing-enabled and passed in by routes/auth.ts). It is ONE env flag,
  // not a per-user predicate, so it cannot live in the (u) => boolean registry
  // above; it is applied here as the single global multiplier on the one
  // capability it governs. OFF forces scm.finance.view false for EVERYONE, so the
  // FE's canViewScmCosting (which reads this capability) hides the cost/margin
  // columns + nav, in lock-step with canViewScmFinance stripping the SAME fields
  // from the wire — ONE switch, both sides, the two-rule split closed. Absent opts
  // (or true) = ON, the no-regression default; only an explicit false hides. This
  // touches ONLY scm.finance.view: the finance-viewer COHORT (isFinanceViewer) is
  // unchanged, and product cost (scm.productCost.view) deliberately does NOT ride
  // the display switch — cost ENTRY must not depend on a cost-DISPLAY toggle.
  if (opts?.costingDisplayEnabled === false) {
    out["scm.finance.view"] = false;
  }
  return out;
}

/** Single-key read, for a backend caller that wants one answer without building
 *  the whole set. Same predicate, same fail-closed contract. */
export function hasCapability(u: CapabilityCaller | null | undefined, key: CapabilityKey): boolean {
  if (!u) return false;
  return PREDICATES[key](u) === true;
}
