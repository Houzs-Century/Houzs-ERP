/* What the shared PMS vocabulary answers.
 *
 * The one-home half — that neither surface keeps its own copy — is pinned by
 * pms-vocabulary-one-home.test.ts. This file pins the WORDS, including the two
 * that had already drifted between desktop and mobile.
 */
import { describe, expect, test } from "vitest";
import { ledgerCategoryLabel, LEDGER_COST_CATS, LEDGER_INCOME_CATS } from "./pms-ledger-categories";
import { isReviewableTitle, REVIEWABLE_TITLES } from "./pms-reviewable-titles";
import { PROJECT_STATUS_OPTIONS, paymentPillOptions } from "./pms-project-status";

describe("ledger category labels", () => {
  test("the sub-categories keep desktop's spelling, not a humanized slug", () => {
    // The drift: mobile's humanize() produced "Cogs Matt Sofa" for this row.
    expect(ledgerCategoryLabel("cogs_matt_sofa")).toBe("COGS — Matt/Sofa");
    expect(ledgerCategoryLabel("cogs_bedframe")).toBe("COGS — Bedframe");
    expect(ledgerCategoryLabel("cogs_accessories")).toBe("COGS — Accessories");
    expect(ledgerCategoryLabel("transport_setup_dismantle")).toBe("Transport Setup & Dismantle");
    expect(ledgerCategoryLabel("cogs")).toBe("COGS");
  });

  test("an unnamed slug still title-cases rather than rendering blank", () => {
    expect(ledgerCategoryLabel("marketing")).toBe("Marketing");
    expect(ledgerCategoryLabel("some_new_bucket")).toBe("Some new bucket");
  });

  test("empty and null render the dash, never the word 'null'", () => {
    expect(ledgerCategoryLabel("")).toBe("—");
    expect(ledgerCategoryLabel(null)).toBe("—");
    expect(ledgerCategoryLabel(undefined)).toBe("—");
  });

  test("every picker category has a label that is not empty", () => {
    for (const c of [...LEDGER_COST_CATS, ...LEDGER_INCOME_CATS]) {
      expect(ledgerCategoryLabel(c).length, c).toBeGreaterThan(0);
    }
  });
});

describe("the reviewable-title rule", () => {
  test("PREFIX IS A STRICT SUPERSET OF THE EXACT SET — nobody loses a control", () => {
    // This is the whole argument for choosing prefix. If any exact title failed
    // its own prefix, adopting it would REMOVE the workflow from that document
    // on desktop, and the choice would be wrong.
    for (const t of REVIEWABLE_TITLES) {
      expect(isReviewableTitle(t), t).toBe(true);
    }
  });

  test("the suffixed rows that desktop used to refuse now match", () => {
    expect(isReviewableTitle("3D Design (Revision 2)")).toBe(true);
    expect(isReviewableTitle("Agreement — signed copy")).toBe(true);
    expect(isReviewableTitle("Stock Out Transfer Record FINAL")).toBe(true);
  });

  test("it stays case- and spacing-tolerant, the way titles are typed", () => {
    expect(isReviewableTitle("3d  design")).toBe(true);
    expect(isReviewableTitle("  Exchange List  ")).toBe(true);
    expect(isReviewableTitle("STOCK IN TRANSFER RECORD")).toBe(true);
  });

  test("an ordinary checklist row is still NOT reviewable", () => {
    for (const t of ["Setup Image", "Defect List Setup", "Permit", "Decoration", "", null]) {
      expect(isReviewableTitle(t), String(t)).toBe(false);
    }
  });

  test("a row that merely MENTIONS a reviewable name is not reviewable", () => {
    // Prefix, not substring — "Photo of 3D Design" is a different document.
    expect(isReviewableTitle("Photo of 3D Design")).toBe(false);
    expect(isReviewableTitle("Old agreement")).toBe(false);
  });
});

describe("project status + payment pills", () => {
  test("the three statuses and their words", () => {
    expect(PROJECT_STATUS_OPTIONS.map((o) => o.value)).toEqual(["confirmed", "pending", "cancelled"]);
    expect(PROJECT_STATUS_OPTIONS.map((o) => o.label)).toEqual(["Confirmed", "Pending", "Cancelled"]);
  });

  test("the rental pill says 'Fully paid' — the label that had drifted to 'Paid'", () => {
    expect(paymentPillOptions("rental_payment")).toEqual([
      ["none", "N/A"], ["unpaid", "Pending"], ["fully_paid", "Fully paid"],
    ]);
  });

  test("anything else is the deposit-shaped pill", () => {
    expect(paymentPillOptions("deposit")).toEqual([
      ["none", "N/A"], ["unpaid", "Pending"], ["refunded", "Refunded"],
    ]);
    expect(paymentPillOptions(null)).toEqual(paymentPillOptions("deposit"));
  });
});
