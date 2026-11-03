import { describe, expect, it } from "vitest";
import { NAV_TABS, type NavTab } from "./Sidebar";
import { collapsedEntryIsLit, collapsedEntryTo, makeNavFilter, navToIsActive, type NavFilterCtx } from "./navFilter";
import { REPORT_CATALOG, REPORT_NAV_MEMBERS } from "../pages/scm-v2/reports-catalog";
import type { AccessLevel, AuthUser } from "../types";

/**
 * FINANCE › REPORTS IS ONE ENTRY (the owner's Claude Design, batch 6 §1.1:
 * "Reports keeps its own report list"). The old Reports group's fourteen
 * entries and the Forecasting group's two are its members — read from the
 * report catalog, each with the gate its own entry had — hidden from the rail:
 *   · the entry shows when any member passes the filter, and not otherwise;
 *   · it opens the report opened last when the reader may still open it, else
 *     the first member they may open;
 *   · it is lit on any member, and on a Books page opened from the report list
 *     (`in=reports`) — which then does NOT light its Books entry.
 */

const reader = (access: Record<string, AccessLevel>, over: Partial<AuthUser> = {}): NavFilterCtx => {
  const user = {
    id: 7, email: "fin@example.test", name: "Fin", role_id: 2, role_name: "user", status: "active",
    permissions: [], position_name: "Accounts Executive", department_name: "Finance Department", ...over,
  } as AuthUser;
  const perms: readonly string[] = user.permissions;
  return {
    user,
    can: (p) => perms.includes(p),
    pageAccess: (page): AccessLevel => (page in access ? access[page] : "none"),
  };
};

const finance = (ctx: NavFilterCtx): NavTab | undefined =>
  NAV_TABS.map(makeNavFilter(ctx)).find((t) => t?.groupId === "scm-finance") ?? undefined;
const reportsOf = (ctx: NavFilterCtx): NavTab | undefined =>
  finance(ctx)?.children?.find((g) => g.groupId === "scm-finance-reports");
const at = (href: string) => {
  const [pathname, q] = href.split("?");
  return { pathname, search: q ? `?${q}` : "" };
};

describe("the sidebar's one Reports entry", () => {
  it("is a collapsed group whose members are the catalog's reports, each with its old entry's gate", () => {
    const raw = NAV_TABS.find((t) => t.groupId === "scm-finance")?.children?.find((g) => g.groupId === "scm-finance-reports");
    expect(raw).toMatchObject({ label: "Reports", collapsed: true, alsoActive: "/scm/accounting?in=reports" });
    expect(raw?.to, "a collapsed entry has no address of its own").toBeUndefined();
    expect(raw?.children).toBe(REPORT_NAV_MEMBERS);
    /* Every report but the three Books pages, the Forecast P&L and the Dashboard among them. */
    expect(REPORT_NAV_MEMBERS.map((m) => m.to).sort()).toEqual(
      REPORT_CATALOG.filter((r) => !r.inReports).map((r) => r.navTo).sort(),
    );
    const byTo = (to: string) => REPORT_NAV_MEMBERS.find((m) => m.to === to);
    expect(byTo("/scm/accounting?tab=pnl")).toMatchObject({ anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.reports"] });
    expect(byTo("/scm/accounting?tab=corrections")).toMatchObject({ anyAccess: ["scm.finance.reports"] });
    expect(byTo("/reports/fair-report")).toMatchObject({
      requireFairReport: true, anyPerm: ["*", "scm.access"],
      anyAccess: ["scm.finance", "scm.finance.reports", "scm.finance.outstanding", "projects.finances"],
    });
    for (const to of ["/scm/forecast", "/scm/finance-dashboard"]) {
      expect(byTo(to)).toMatchObject({ anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.forecast"] });
    }
  });

  it("shows for a reader who may open any member, with only those members; not for a reader who may open none", () => {
    const planner = reportsOf(reader({ "scm.finance": "view", "scm.finance.forecast": "view" }));
    expect(planner?.children?.map((m) => m.to)).toEqual(["/scm/forecast", "/scm/finance-dashboard"]);
    const reports = reportsOf(reader({ "scm.finance": "view", "scm.finance.reports": "view" }));
    expect(reports?.children?.map((m) => m.to)).toContain("/scm/accounting?tab=pnl");
    expect(reports?.children?.map((m) => m.to)).not.toContain("/scm/forecast");
    /* The Sales report keeps its cohort gate. */
    expect(reports?.children?.map((m) => m.to)).not.toContain("/reports/fair-report");
    const booksOnly = reader({ "scm.finance": "view", "scm.finance.books": "view" });
    expect(finance(booksOnly)?.children?.some((g) => g.label === "Books")).toBe(true);
    expect(reportsOf(booksOnly), "no member passes, no entry").toBeUndefined();
  });

  it("opens the report opened last while the reader may open it, else the first they may open", () => {
    const members = reportsOf(reader({ "scm.finance": "view", "scm.finance.reports": "view" }))?.children ?? [];
    expect(collapsedEntryTo(members, null)).toBe("/scm/accounting?tab=pnl");
    expect(collapsedEntryTo(members, "/scm/accounting?tab=ar")).toBe("/scm/accounting?tab=ar");
    expect(collapsedEntryTo(members, "/scm/forecast"), "not one this reader may open").toBe("/scm/accounting?tab=pnl");
    expect(collapsedEntryTo([], "/scm/accounting?tab=ar")).toBeUndefined();
  });

  it("is lit on any member and on a Books page opened from the list, which then does not light Books", () => {
    const entry = NAV_TABS.find((t) => t.groupId === "scm-finance")?.children?.find((g) => g.groupId === "scm-finance-reports");
    if (!entry) throw new Error("no Reports entry");
    expect(collapsedEntryIsLit(entry, at("/scm/accounting?tab=bs&from=2026-10-01&to=2026-10-31"))).toBe(true);
    expect(collapsedEntryIsLit(entry, at("/scm/finance-dashboard"))).toBe(true);
    expect(collapsedEntryIsLit(entry, at("/reports/fair-report"))).toBe(true);
    expect(collapsedEntryIsLit(entry, at("/scm/accounting?tab=tb&in=reports"))).toBe(true);
    expect(collapsedEntryIsLit(entry, at("/scm/accounting?tab=tb"))).toBe(false);
    expect(collapsedEntryIsLit(entry, at("/scm/receipts"))).toBe(false);
    const books = NAV_TABS.find((t) => t.groupId === "scm-finance")?.children?.find((g) => g.label === "Books")?.children ?? [];
    const tb = books.find((t) => t.to === "/scm/accounting?tab=tb");
    expect(tb?.notWithParam).toBe("in");
    expect(navToIsActive(tb?.to ?? "", at("/scm/accounting?tab=tb"), tb?.end, tb?.notWithParam)).toBe(true);
    expect(navToIsActive(tb?.to ?? "", at("/scm/accounting?tab=tb&in=reports"), tb?.end, tb?.notWithParam)).toBe(false);
  });
});
