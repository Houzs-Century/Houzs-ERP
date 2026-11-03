import { describe, expect, it } from "vitest";
import { inItsCompany, opensElsewhere, systemNoticeLink } from "./systemNoticeLink";

/* Where a bell notice opens, read off its source tag (the payment voucher
   reminder, backend scm/routes/payment-vouchers-remind.ts PV_REMIND_SOURCE). */
describe("systemNoticeLink", () => {
  it("a reminder about one voucher opens that voucher", () => {
    expect(systemNoticeLink("pv_approval:1:8f0c3a2e-1b2c-4d5e-9f00-1234567890ab")).toEqual({
      to: "/scm/payment-vouchers/8f0c3a2e-1b2c-4d5e-9f00-1234567890ab",
      companyId: 1,
    });
  });

  it("a reminder about several opens the checked vouchers", () => {
    expect(systemNoticeLink("pv_approval:2")).toEqual({ to: "/scm/payment-vouchers?status=CHECKED", companyId: 2 });
  });

  it("every other notice carries no place, and a mangled id opens nothing", () => {
    expect(systemNoticeLink("service_case")).toBeNull();
    expect(systemNoticeLink("pos_alert:42")).toBeNull();
    expect(systemNoticeLink(null)).toBeNull();
    expect(systemNoticeLink("pv_approval:1:../../admin")).toBeNull();
  });

  it("another company's voucher opens in a new window on that company", () => {
    const one = systemNoticeLink("pv_approval:2:pv-9")!;
    expect(opensElsewhere(one, 1)).toBe(true);
    expect(opensElsewhere(one, 2)).toBe(false);
    /* A tab that has not resolved its company yet stays where it is. */
    expect(opensElsewhere(one, null)).toBe(false);
    expect(inItsCompany(one)).toBe("/scm/payment-vouchers/pv-9?company=2");
    expect(inItsCompany(systemNoticeLink("pv_approval:2")!)).toBe("/scm/payment-vouchers?status=CHECKED&company=2");
  });
});
