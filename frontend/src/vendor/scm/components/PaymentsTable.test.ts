import { describe, it, expect } from "vitest";
import {
  draftMethodFields,
  editDraftOf,
  labelToApi,
  missingMethodSubField,
  parseInstallmentMonths,
  UnknownPaymentMethodError,
  convertDraftsFrom,
} from "./PaymentsTable";
import { CONVERT_LABEL } from "../lib/so-money-queries";

/* docs/bugs/0838 (owner 2026-09-12: 用 finance 权限改资料时 payment method 会跳掉
   去 cash … 我按 edit 时默认会已输入的资料，我只会 edit 我想要 edit 的东西). An
   Installment row opened for edit must come back as Installment, with its bank
   and plan, and save as `installment`; a value none of the four is refused by
   name, never booked as cash. */
describe("labelToApi — every value the ledger stores resolves, an unknown one is refused", () => {
  it("resolves the four core values, Installment included", () => {
    expect(labelToApi("Merchant").method).toBe("merchant");
    expect(labelToApi("Online").method).toBe("transfer");
    expect(labelToApi("Installment").method).toBe("installment");
    expect(labelToApi("Cash").method).toBe("cash");
  });

  it("refuses a value that is none of the four instead of falling back to cash", () => {
    expect(() => labelToApi("Cheque")).toThrow(UnknownPaymentMethodError);
    expect(() => labelToApi("")).toThrow(/pick the method again/);
  });
});

describe("editDraftOf — the edit draft is the persisted row, verbatim", () => {
  const row = {
    id: "p1", version: 3, paid_at: "2026-06-14T10:00:00", method: "installment", merchant_provider: "MBB",
    installment_months: 6, online_type: null, amount_sen: 356500, account_sheet: "Card terminal",
    approval_code: "009577", collected_by: "staff-1", created_at: "2026-06-14T10:00:00Z",
  } as unknown as Parameters<typeof editDraftOf>[0];

  it("an installment row opens as Installment with its bank, plan, sheet and code — and saves as installment", () => {
    const d = editDraftOf(row, (m) => (m ? `${m} months` : "One-off"));
    expect(d).toMatchObject({
      methodLabel: "Installment", merchantProvider: "MBB", installmentMonthsLabel: "6 months",
      amountSen: 356500, accountSheet: "Card terminal", approvalCode: "009577", collectedBy: "staff-1",
      paidAt: "2026-06-14", editingPersistedId: "p1",
    });
    const { method } = labelToApi(d.methodLabel);
    expect(method).toBe("installment");
    expect(draftMethodFields(method, d)).toEqual({ merchantProvider: "MBB", installmentMonths: 6 });
  });

  it("a row whose stored method the screen does not know opens under that value, not as Cash", () => {
    const d = editDraftOf({ ...row, method: "imported" } as unknown as typeof row, () => "");
    expect(d.methodLabel).toBe("imported");
    expect(() => labelToApi(d.methodLabel)).toThrow(UnknownPaymentMethodError);
  });
});

/**
 * Installment gains a Bank picker (owner 2026-07-19 "Installment 要能选银行的").
 * The bank drives the EPP/installment fee, so the row must now carry
 * merchant_provider just like Merchant does — while Merchant, Cash and Online
 * stay exactly as they were. draftMethodFields is the ONE place the per-method
 * payload is derived (shared by the desktop commit + every draft-batching page),
 * so pinning it here proves the change reaches every surface.
 */
describe("draftMethodFields — installment carries the bank", () => {
  it("installment sends BOTH the bank (merchant_provider) and the plan", () => {
    expect(
      draftMethodFields("installment", {
        merchantProvider: "CIMB",
        installmentMonthsLabel: "12 months",
        onlineType: "",
      }),
    ).toEqual({ merchantProvider: "CIMB", installmentMonths: 12 });
  });

  it("installment with no bank picked persists a null bank (optional, still books)", () => {
    expect(
      draftMethodFields("installment", {
        merchantProvider: "",
        installmentMonthsLabel: "6 months",
        onlineType: "",
      }),
    ).toEqual({ merchantProvider: null, installmentMonths: 6 });
  });

  it("merchant is unchanged — bank + plan, same as before", () => {
    expect(
      draftMethodFields("merchant", {
        merchantProvider: "MBB",
        installmentMonthsLabel: "One Shot",
        onlineType: "",
      }),
    ).toEqual({ merchantProvider: "MBB", installmentMonths: null });
  });

  it("cash carries no bank", () => {
    expect(
      draftMethodFields("cash", {
        merchantProvider: "MBB",
        installmentMonthsLabel: "12 months",
        onlineType: "TNG",
      }),
    ).toEqual({});
  });

  it("online (transfer) carries no bank — only its sub-type", () => {
    expect(
      draftMethodFields("transfer", {
        merchantProvider: "MBB",
        installmentMonthsLabel: "12 months",
        onlineType: "TNG",
      }),
    ).toEqual({ onlineType: "TNG" });
  });
});

describe("missingMethodSubField — the Installment bank is OPTIONAL (not gated)", () => {
  it("installment with neither bank nor plan is still allowed to book", () => {
    expect(
      missingMethodSubField({
        methodLabel: "Installment",
        merchantProvider: "",
        installmentMonthsLabel: "",
        onlineType: "",
      }),
    ).toBeNull();
  });

  it("merchant still REQUIRES the bank (unchanged)", () => {
    expect(
      missingMethodSubField({
        methodLabel: "Merchant",
        merchantProvider: "",
        installmentMonthsLabel: "12 months",
        onlineType: "",
      }),
    ).toBe("Bank");
  });
});

describe("parseInstallmentMonths", () => {
  it("parses an N-month plan to its integer term", () => {
    expect(parseInstallmentMonths("12 months")).toBe(12);
  });
  it("treats the one-shot labels as no installment", () => {
    expect(parseInstallmentMonths("One Shot")).toBeNull();
    expect(parseInstallmentMonths("One-off")).toBeNull();
    expect(parseInstallmentMonths("")).toBeNull();
  });
});

/* Money moved from a cancelled order (owner 2026-09-15; docs/bugs/0927 the
   backend, 0931 these screens): "Convert from cancelled SO" is a method of its
   own on the desktop — resolved to the ledger code `converted`, carrying the
   order it comes from, refused without one; a stored converted row opens
   under that label with its source; a ?convert= parameter seeds the rows. */
describe("Convert from cancelled SO — the desktop's fifth method", () => {
  it("resolves to `converted` and carries the cancelled order; nothing else rides along", () => {
    const { method } = labelToApi(CONVERT_LABEL);
    expect(method).toBe("converted");
    expect(draftMethodFields(method, { merchantProvider: "MBB", installmentMonthsLabel: "6 months", onlineType: "TNG", convertedFromDocNo: "2990-SO-2607-010" }))
      .toEqual({ convertedFromDocNo: "2990-SO-2607-010" });
    expect(draftMethodFields(method, { merchantProvider: "", installmentMonthsLabel: "", onlineType: "", convertedFromDocNo: "" }))
      .toEqual({ convertedFromDocNo: null });
  });

  it("the gate wants the cancelled order picked; the other methods are unchanged", () => {
    expect(missingMethodSubField({ methodLabel: CONVERT_LABEL, merchantProvider: "", installmentMonthsLabel: "", onlineType: "", convertedFromDocNo: "" })).toBe("order the money comes from");
    expect(missingMethodSubField({ methodLabel: CONVERT_LABEL, merchantProvider: "", installmentMonthsLabel: "", onlineType: "", convertedFromDocNo: "2990-SO-2607-010" })).toBeNull();
    expect(missingMethodSubField({ methodLabel: "Cash", merchantProvider: "", installmentMonthsLabel: "", onlineType: "" })).toBeNull();
  });

  it("a stored converted row opens under the label with its source", () => {
    const row = {
      id: "p9", version: 1, paid_at: "2026-07-01", method: "converted", merchant_provider: null, installment_months: null, online_type: null,
      amount_sen: 30000, account_sheet: "Converted from 2990-SO-2607-010", approval_code: null, collected_by: "staff-1",
      created_at: "2026-09-15T08:00:00Z", converted_from_so_doc_no: "2990-SO-2607-010",
    } as unknown as Parameters<typeof editDraftOf>[0];
    const d = editDraftOf(row, () => "");
    expect(d).toMatchObject({ methodLabel: CONVERT_LABEL, convertedFromDocNo: "2990-SO-2607-010", amountSen: 30000 });
    expect(labelToApi(d.methodLabel).method).toBe("converted");
  });

  it("?convert=SO-a:sen,SO-b:sen seeds one converted draft per pick", () => {
    const drafts = convertDraftsFrom("2990-SO-2607-010:40000,2990-SO-2607-024:30000,junk,2990-SO-0:0", "staff-1");
    expect(drafts.map((d) => [d.methodLabel, d.convertedFromDocNo, d.amountSen, d.collectedBy])).toEqual([
      [CONVERT_LABEL, "2990-SO-2607-010", 40000, "staff-1"],
      [CONVERT_LABEL, "2990-SO-2607-024", 30000, "staff-1"],
    ]);
    expect(convertDraftsFrom(null)).toEqual([]);
  });
});
