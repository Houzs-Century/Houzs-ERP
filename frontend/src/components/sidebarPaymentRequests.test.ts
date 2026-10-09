import { describe, expect, it } from "vitest";
import { NAV_TABS, type NavTab } from "./Sidebar";
import { makeNavFilter, type NavFilterCtx } from "./navFilter";
import type { AccessLevel, AuthUser } from "../types";

/**
 * PAYMENT REQUESTS SHOW ONCE (owner 2026-10-08: 你看payment request 同时会出现
 * 两边？ … 做). The Workspace entry is the requester's; Finance (the voucher
 * key, `*` included) keeps only the one under Money out — the same page twice
 * was noise — and that one carries the red count of requests waiting for
 * Finance. Pinned for a requester, Finance and the owner.
 */

const person = (permissions: string[]): AuthUser =>
  ({
    id: 7, email: "p@example.test", name: "P", role_id: 1, role_name: "user", status: "active",
    permissions, position_name: "Executive", department_name: "Finance",
  }) as AuthUser;

const ctxFor = (user: AuthUser): NavFilterCtx => ({
  user,
  can: (p) => user.permissions.includes("*") || user.permissions.includes(p),
  pageAccess: (): AccessLevel => (user.permissions.includes("*") ? "full" : "none"),
});

/** Every surviving Payment Requests entry, with where it sits and its badge. */
function paymentRequestEntries(user: AuthUser): Array<{ section: string | undefined; badge: string | undefined }> {
  const filterTab = makeNavFilter(ctxFor(user));
  const out: Array<{ section: string | undefined; badge: string | undefined }> = [];
  const walk = (t: NavTab, section: string | undefined) => {
    if (t.to === "/scm/payment-requests") out.push({ section, badge: t.badge });
    (t.children ?? []).forEach((c) => walk(c, section));
  };
  NAV_TABS.map(filterTab)
    .filter((t): t is NavTab => t !== null)
    .forEach((t) => walk(t, t.section ?? t.groupId));
  return out;
}

describe("Payment Requests in the sidebar", () => {
  it("a requester sees the Workspace entry, with no count", () => {
    expect(paymentRequestEntries(person(["scm.payment_request.create"]))).toEqual([{ section: "workspace", badge: undefined }]);
  });

  it("Finance sees it once — under Money out, carrying the waiting count", () => {
    const finance = paymentRequestEntries(person(["scm.payment_request.create", "scm.payment_voucher.create", "scm.access"]));
    expect(finance).toHaveLength(1);
    expect(finance[0]?.badge).toBe("payment-requests-waiting");
    expect(finance[0]?.section).not.toBe("workspace");
  });

  it("the owner (*) sees it once too", () => {
    const owner = paymentRequestEntries(person(["*"]));
    expect(owner).toHaveLength(1);
    expect(owner[0]?.badge).toBe("payment-requests-waiting");
  });
});
