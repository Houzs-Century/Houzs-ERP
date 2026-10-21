import { describe, expect, it } from "vitest";
import { NAV_TABS, type NavTab } from "./Sidebar";
import { makeNavFilter, type NavFilterCtx } from "./navFilter";
import type { AccessLevel, AuthUser } from "../types";

/**
 * HC-0136 (Sim): 「product request have notification alert when have new request
 * order. same like SO amendment」. The Purchaser's Product Request entry under
 * Consignment carries the red count of requests waiting for them, the way Sales
 * Order Amendment does.
 */

const person = (permissions: string[]): AuthUser =>
  ({
    id: 7, email: "p@example.test", name: "P", role_id: 1, role_name: "user", status: "active",
    permissions, position_name: "Procurement/Purchasing", department_name: "Operation Department",
  }) as AuthUser;

const ctxFor = (user: AuthUser, areas: string[]): NavFilterCtx => ({
  user,
  can: (p) => user.permissions.includes("*") || user.permissions.includes(p),
  pageAccess: (k): AccessLevel => (user.permissions.includes("*") || areas.includes(k) ? "full" : "none"),
});

function productRequestBadges(user: AuthUser, areas: string[]): Array<string | undefined> {
  const filterTab = makeNavFilter(ctxFor(user, areas));
  const out: Array<string | undefined> = [];
  const walk = (t: NavTab) => {
    if (t.to === "/scm/product-requests") out.push(t.badge);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.map(filterTab).filter((t): t is NavTab => t !== null).forEach(walk);
  return out;
}

describe("Product Request in the sidebar", () => {
  it("the Purchaser's entry carries the waiting-for-approval count", () => {
    const purchaser = productRequestBadges(person(["scm.access", "scm.product_request.approve"]), ["scm.consignment.po_orders"]);
    expect(purchaser).toEqual(["product-request-approvals"]);
  });
});
