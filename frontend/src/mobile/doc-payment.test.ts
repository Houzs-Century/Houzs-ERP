import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { offersRecordPayment, piPaymentHint } from "./doc-payment";
import { PI_PAYMENT_ROUTE_HINT } from "../vendor/scm/lib/pi-payment-path";
import { stripComments } from "../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("a purchase invoice on the phone is paid with an AP Payment (docs/bugs/0889)", () => {
  const owed = { status: "POSTED", total_sen: 255_000, paid_sen: 0, supplier: { id: "sup-1" } };

  it("offers no Record Payment sheet on a purchase invoice, whatever it owes", () => {
    expect(offersRecordPayment("purchase-invoices", owed)).toBe(false);
    expect(offersRecordPayment("purchase-invoices", { ...owed, status: "PARTIALLY_PAID", paid_sen: 5_000 })).toBe(false);
  });

  it("says where the payment is made while the invoice still awaits one", () => {
    expect(piPaymentHint("purchase-invoices", owed)).toBe(PI_PAYMENT_ROUTE_HINT);
    expect(PI_PAYMENT_ROUTE_HINT).toContain("AP Payment");
  });

  it("says nothing on a paid, cancelled, draft or held invoice, or on another document", () => {
    expect(piPaymentHint("purchase-invoices", { ...owed, status: "PAID", paid_sen: 255_000 })).toBeNull();
    expect(piPaymentHint("purchase-invoices", { ...owed, status: "CANCELLED" })).toBeNull();
    expect(piPaymentHint("purchase-invoices", { ...owed, status: "DRAFT" })).toBeNull();
    expect(piPaymentHint("purchase-invoices", { ...owed, on_hold: true })).toBeNull();
    expect(piPaymentHint("purchase-invoices", null)).toBeNull();
    expect(piPaymentHint("sales-invoices", owed)).toBeNull();
  });
});

describe("a sales invoice keeps its Record Payment sheet", () => {
  it("offered while confirmed and still owed", () => {
    expect(offersRecordPayment("sales-invoices", { status: "SENT", total_sen: 10_000, paid_sen: 0 })).toBe(true);
    expect(offersRecordPayment("sales-invoices", { status: "PARTIALLY_PAID", total_sen: 10_000, paid_sen: 4_000 })).toBe(true);
  });

  it("not on a draft, a cancelled or a settled invoice", () => {
    expect(offersRecordPayment("sales-invoices", { status: "DRAFT", total_sen: 10_000, paid_sen: 0 })).toBe(false);
    expect(offersRecordPayment("sales-invoices", { status: "CANCELLED", total_sen: 10_000, paid_sen: 0 })).toBe(false);
    expect(offersRecordPayment("sales-invoices", { status: "PAID", total_sen: 10_000, paid_sen: 10_000 })).toBe(false);
  });
});

describe("the phone detail screen no longer writes a supplier invoice's paid amount", () => {
  const src = stripComments(readFileSync(resolve(HERE, "MobileModuleDetail.tsx"), "utf8"));

  it("never calls the retired purchase invoice payment route", () => {
    expect(src).not.toMatch(/purchase-invoices\/[^"'`]*\/payment\b/);
  });

  it("decides its payment footer through doc-payment", () => {
    expect(src).toMatch(/import \{ offersRecordPayment, piPaymentHint \} from "\.\/doc-payment"/);
  });
});
