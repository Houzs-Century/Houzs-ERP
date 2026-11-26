import { describe, it, expect } from "vitest";
import {
  isDirectorUser,
  isSalesDirectorUser,
  canOperateDeliveryOrders,
  canOperateSalesInvoices,
  canSeeSoloOrganizer,
} from "./salesAccess";
import type { AuthUser } from "../types";


const u = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 1,
    email: "t@example.test",
    name: "T",
    role_id: 1,
    role_name: "user",
    status: "active",
    permissions: [],
    position_name: null,
    department_name: null,
    ...over,
  }) as AuthUser;

const LOCKSTEP_SALES_DIRECTOR: ReadonlyArray<[string, boolean]> = [
  ["Sales Director", true],
  ["  sales director ", true],
  ["Assistant to Sales Director", false],
  ["Sales Executive", false],
  ["Sales Manager", false],
];

describe("salesAccess — director/sales-director classification", () => {
  it("isDirectorUser reads the org.director capability and fails CLOSED", () => {
    expect(isDirectorUser(u({ capabilities: { "org.director": true } }))).toBe(true);
    expect(isDirectorUser(u({ capabilities: { "org.director": false } }))).toBe(false);
    expect(isDirectorUser(u({ position_name: "Super Admin" }))).toBe(false);
    expect(isDirectorUser(u({ permissions: ["*"], project_finance_viewer: true }))).toBe(false);
    expect(isDirectorUser(null)).toBe(false);
  });

  it("isSalesDirectorUser matches ONLY the exact 'Sales Director'", () => {
    for (const [name, expected] of LOCKSTEP_SALES_DIRECTOR) {
      expect(isSalesDirectorUser(u({ position_name: name }))).toBe(expected);
    }
  });
});


const gate = (
  user: AuthUser,
  access: Record<string, string> = {},
  wildcard = false,
) => ({
  user,
  can: (p: string) => (wildcard ? true : p === "__never__"),
  pageAccess: ((page: string) =>
    (wildcard ? "full" : (access[page] ?? "none"))) as (p: string) => never,
});

describe("canOperateDeliveryOrders / canOperateSalesInvoices", () => {
  it("the Sales cohort may NOT operate a DO or an SI — owner: they only look", () => {
    for (const who of [
      u({ position_name: "Sales Executive", department_name: "Sales Department" }),
      u({ position_name: "Sales Manager", department_name: "Sales Department" }),
      // "sales director 算sales" + "DO SI 只能看 salesdirector".
      u({ position_name: "Sales Director", department_name: "Sales Department" }),
      u({ position_name: null, department_name: "Sales Department" }),
    ]) {
      const g = gate(who, {
        "scm.sales.delivery": "view",
        "scm.sales.invoices": "view",
      });
      expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(false);
      expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(false);
    }
  });

  it("a Sales user is denied even if the matrix says edit — the JD is the rule", () => {
    const g = gate(
      u({ position_name: "Sales Executive", department_name: "Sales Department" }),
      { "scm.sales.delivery": "full", "scm.sales.invoices": "full" },
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(false);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(false);
  });

  it("OFFICE operates both — nothing is taken from the people whose job it is", () => {
    const g = gate(
      u({ position_name: "Operation Executive", department_name: "Operation Department" }),
      { "scm.sales.delivery": "edit", "scm.sales.invoices": "full" },
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(true);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(true);
  });

  it("`view` is not enough for a non-Sales user either — writes need edit", () => {
    const g = gate(
      u({ position_name: "Operation Executive", department_name: "Operation Department" }),
      { "scm.sales.delivery": "view", "scm.sales.invoices": "view" },
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(false);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(false);
  });

  it("the `*` wildcard always passes — the owner is never narrowed", () => {
    const g = gate(
      u({ permissions: ["*"], position_name: "Sales Director", department_name: "Sales Department" }),
      {},
      true,
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(true);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(true);
  });
});

/**
 * Owner 2026-09-18: a SOLO roadshow's organizer (the mall management) is for
 * "BD, owner, weisiang only ... others only show solo". These are the three live
 * accounts that pass on that day, and the cohorts the owner named as NOT passing.
 */
describe("canSeeSoloOrganizer", () => {
  it("passes BD staff, the Owner position and weisiang", () => {
    expect(canSeeSoloOrganizer(u({ role_name: "BD Exec", position_name: "Operation Executive" }))).toBe(true);
    expect(canSeeSoloOrganizer(u({ role_name: "Owner", position_name: "Owner", permissions: ["*"] }))).toBe(true);
    expect(canSeeSoloOrganizer(u({ email: "WeiSiang329@gmail.com", role_name: "Super Admin", position_name: "Managing Director" }))).toBe(true);
  });

  it("refuses salesmen, sales directors and the OTHER super admins - a wildcard is not the tier", () => {
    expect(canSeeSoloOrganizer(u({ role_name: "Sales Person", position_name: "Sales Executive", department_name: "Sales Department" }))).toBe(false);
    expect(canSeeSoloOrganizer(u({ role_name: "Sales Director", position_name: "Sales Director" }))).toBe(false);
    expect(canSeeSoloOrganizer(u({ role_name: "Super Admin", position_name: "Super Admin", permissions: ["*"] }))).toBe(false);
    expect(canSeeSoloOrganizer(null)).toBe(false);
  });
});
