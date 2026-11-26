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
import { canViewItPages } from "./itAccess";
import {
  isDirectorUser,
  isFinanceViewer,
  isPosMarketingAccount,
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

function asAuthUser(u: CapabilityCaller): AuthUser {
  return {
    position_name: u.position_name ?? null,
    department_name: u.department_name ?? null,
    position_policy: u.position_policy ?? null,
    permissions_set: u.permissions_set ?? new Set(u.permissions ?? []),
  } as unknown as AuthUser;
}

function asMoneyCaller(u: CapabilityCaller): MoneyWriteCaller {
  return {
    permissions: u.permissions,
    permissions_set: u.permissions_set,
    position_name: u.position_name ?? null,
    position_policy: u.position_policy ?? null,
  };
}

function granted(u: CapabilityCaller): ReadonlyArray<string> | ReadonlySet<string> {
  return u.permissions_set ?? u.permissions ?? [];
}


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

function isDirectorFor(u: CapabilityCaller): boolean {
  return isDirectorUser(asAuthUser(u));
}

const PREDICATES = {
  "scm.config.write": canWriteScmConfigFor,

  "scm.finance.view": (u: CapabilityCaller): boolean => isFinanceViewer(asAuthUser(u)),

  "scm.productCost.view": (u: CapabilityCaller): boolean => isProductCostViewer(asAuthUser(u)),

  "scm.sales.viewAll": (u: CapabilityCaller): boolean =>
    hasPermission(granted(u), "scm.so.view_all") || isDirectorUser(asAuthUser(u)),

  "scm.money.move": (u: CapabilityCaller): boolean =>
    moneyWriteDenial(asMoneyCaller(u), "scm.finance.accounting", "POST") === null,

  "fair.so.view": (u: CapabilityCaller): boolean => fairReportAccess("so", asAuthUser(u)).allowed,
  "fair.do.view": (u: CapabilityCaller): boolean => fairReportAccess("do", asAuthUser(u)).allowed,
  "fair.invoice.view": (u: CapabilityCaller): boolean =>
    fairReportAccess("invoice", asAuthUser(u)).allowed,

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

  "org.sales.staff": (u: CapabilityCaller): boolean => isSalesUser(asAuthUser(u)),

  "org.director": isDirectorFor,

  "org.salesDirector": (u: CapabilityCaller): boolean => isSalesDirectorUser(asAuthUser(u)),

  "org.defect.reviewer": (u: CapabilityCaller): boolean => isDefectReviewerPosition(asAuthUser(u)),

  "org.crew.scoped": (u: CapabilityCaller): boolean => isCrewScopedUser(asAuthUser(u)),

  "pos.marketing": (u: CapabilityCaller): boolean => isPosMarketingAccount(asAuthUser(u)),

  "org.assistant.use": (u: CapabilityCaller): boolean => canUseAssistant(asAuthUser(u)),

  "it.pages.view": (u: CapabilityCaller): boolean => canViewItPages(granted(u)),
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
