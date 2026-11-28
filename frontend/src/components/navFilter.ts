import type { NavTab } from "./Sidebar";
import type { AccessLevel, AuthUser } from "../types";
import {
  isSalesStaff,
  isSalesDirectorUser,
  isSalesNonDirector,
  isDirectorUser,
  canViewFairReport,
} from "../auth/salesAccess";
import { capability } from "../auth/capabilities";

/**
 * Single source of truth for "which nav entries can this user see".
 *
 * The desktop `Sidebar` and the mobile `MenuModal` (MobileTabBar) both build
 * their menus from the same `NAV_TABS` registry, so they MUST filter it with
 * identical logic — otherwise a gated entry leaks into one surface but not the
 * other. The mobile copy silently drifted: it checked only `perm` / `anyPerm`
 * / `hidePerm` and ignored `pageAccess`, `pageAccessFull`, `requireFinanceViewer`
 * and every sales gate. So `pageAccess`-only items (Projects, System Health)
 * and `hideForSales` items (Delivery Returns) rendered for denied users at
 * `<lg` widths and bounced them to <Forbidden> — the exact "render-then-deny"
 * the "off, not hide" rule forbids at the nav layer. Extracting the filter here
 * makes that drift impossible: both surfaces call the same function.
 *
 * Returns a `filterTab` that recursively drops entries the user can't reach; a
 * group with no surviving child is itself dropped. Denied entries are absent,
 * never rendered-then-blocked.
 */
export interface NavFilterCtx {
  user: AuthUser | null;
  can: (perm: string) => boolean;
  pageAccess: (page: string) => AccessLevel;
}

/**
 * Per-NODE visibility predicate — the SINGLE source of "can this user see this
 * one nav entry", checking EVERY gate (sales hide/show, perm, anyPerm/anyAccess,
 * pageAccess, pageAccessFull, hidePerm, requireFinanceViewer) in the correct
 * order. It does NOT recurse into children and does NOT apply the salesRepTo
 * click-target remap — those belong to the tree filter below.
 *
 * `makeNavFilter` (the recursive tree filter used by the desktop Sidebar and the
 * MobileTabBar MenuModal) is built ON TOP of this predicate, and the mobile
 * `MobileApp` shell uses the predicate DIRECTLY to gate its hand-laid-out menu +
 * bottom tabs. Sharing this one function is what stops the mobile shell drifting
 * (it used to hand-copy a SUBSET that omitted pageAccessFull / hidePerm /
 * requireFinanceViewer and short-circuited the sales bypass before them).
 */
export function makeNavVisible({ user, can, pageAccess }: NavFilterCtx) {
  return function navVisible(t: NavTab): boolean {
    if (t.hideForSales && isSalesStaff(user)) return false;
    if (t.hideForSalesRep && isSalesNonDirector(user)) return false;
    if (t.requireCapability && !capability(user, t.requireCapability)) return false;
    if (t.salesRepOnly && !isSalesNonDirector(user)) return false;
    const salesBypass =
      (!!t.showForSales && isSalesStaff(user)) ||
      (!!t.showForSalesDirector && isSalesDirectorUser(user)) ||
      (!!t.showForDirector && isDirectorUser(user)) ||
      (!!t.showForSalesRep && isSalesNonDirector(user)) ||
      (!!t.salesRepOnly && isSalesNonDirector(user));
    if (!salesBypass) {
      if (t.perm && !can(t.perm)) return false;
      if (t.anyPerm || t.anyAccess) {
        const navPerms =
          user?.scm_l2_configured && t.anyPerm
            ? t.anyPerm.filter((p) => p !== "scm.access")
            : t.anyPerm;
        const permOk = navPerms ? navPerms.some((p) => can(p)) : false;
        const accessOk = t.anyAccess
          ? t.anyAccess.some((k) => pageAccess(k) !== "none")
          : false;
        if (!permOk && !accessOk) return false;
      }
      if (t.pageAccess && pageAccess(t.pageAccess) === "none") return false;
      if (t.pageAccessFull && pageAccess(t.pageAccessFull) !== "full")
        return false;
    }
    if (t.hidePerm && can(t.hidePerm)) return false;
    if (t.requireFinanceViewer && !user?.project_finance_viewer) return false;
    if (t.requireFairReport && !canViewFairReport(user)) return false;
    return true;
  };
}

export function makeNavFilter(ctx: NavFilterCtx) {
  const { user } = ctx;
  const navVisible = makeNavVisible(ctx);
  return function filterTab(t: NavTab): NavTab | null {
    if (!navVisible(t)) return null;
    const to = t.salesRepTo && isSalesNonDirector(user) ? t.salesRepTo : t.to;
    if (t.children) {
      const kids = t.children
        .map(filterTab)
        .filter((x): x is NavTab => x !== null);
      if (kids.length === 0) return null;
      return { ...t, to, children: kids };
    }
    return to === t.to ? t : { ...t, to };
  };
}

/**
 * Where a collapsed entry (`NavTab.collapsed`, Finance › Reports) goes, after
 * the filter: the member opened last when the reader may still open it, else
 * the first member they may open. Both surfaces call it, so the desktop rail
 * and the phone's menu send the same reader to the same report.
 */
export function collapsedEntryTo(members: readonly NavTab[], last: string | null): string | undefined {
  return (last ? members.find((m) => m.to === last)?.to : undefined) ?? members.find((m) => m.to)?.to;
}

/** Where the reader is, as the nav compares it. */
export type NavLocation = { pathname: string; search: string };

/**
 * True when a nav entry's `to` is the current page: its path (a nested route
 * too, unless `end`) and every query parameter it names — NavLink does not
 * compare query strings, and Finance deep-links `/scm/accounting?tab=…`.
 * `notWithParam`: the entry does not light while the address carries that
 * parameter (Books' pages opened from the report list carry `in=reports`, and
 * the Reports entry lights instead).
 */
export function navToIsActive(to: string, loc: NavLocation, end?: boolean, notWithParam?: string): boolean {
  const [path, search] = to.split("?");
  if (end ? loc.pathname !== path : !loc.pathname.startsWith(path)) {
    if (loc.pathname !== path) return false;
  }
  const have = new URLSearchParams(loc.search);
  if (notWithParam && have.has(notWithParam)) return false;
  if (!search) return true;
  const wanted = new URLSearchParams(search);
  for (const [k, v] of wanted.entries()) {
    if (have.get(k) !== v) return false;
  }
  return true;
}

/** A collapsed entry (Finance › Reports) is lit on any of its members, or on
 *  its `alsoActive` address. */
export function collapsedEntryIsLit(tab: NavTab, loc: NavLocation): boolean {
  return (tab.children ?? []).some((m) => (m.to ? navToIsActive(m.to, loc, m.end, m.notWithParam) : false))
    || (tab.alsoActive ? navToIsActive(tab.alsoActive, loc) : false);
}
