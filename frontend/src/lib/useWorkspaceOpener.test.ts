import { describe, expect, it } from "vitest";
import { openerLabel } from "./useWorkspaceOpener";

/* Back from a document names the page it was opened from (owner 2026-10-21).
   The Finance reports (owner's Claude Design, batch 6 §1.1): an order opened
   from Collection, Corrections, Self-check or the Sales report reads "Back to
   <that page>" — the Accounting page by the tab it was on, not "Accounting". */
describe("the name Back gives the page a document was opened from", () => {
  it("names an Accounting tab by its title, whatever else its address carries", () => {
    expect(openerLabel("/scm/accounting?tab=collection&from=2026-10-01&to=2026-10-31")).toBe("Collection");
    expect(openerLabel("/scm/accounting?tab=corrections")).toBe("Corrections");
    expect(openerLabel("/scm/accounting?tab=check")).toBe("Self-check");
    expect(openerLabel("/scm/accounting?tab=tb&in=reports")).toBe("Trial balance");
  });

  it("names the Sales report, and keeps the pages it named before", () => {
    expect(openerLabel("/reports/fair-report?stage=so")).toBe("Sales report");
    expect(openerLabel("/scm/merchant-recon?batch=230")).toBe("Merchant reports");
    expect(openerLabel("/scm/receipts")).toBe("Receipts");
  });

  it("falls back to the page's own label, and an Accounting address with no tab is the page", () => {
    expect(openerLabel("/scm/forecast")).toBe("Forecast P&L");
    expect(openerLabel("/scm/finance-dashboard")).toBe("Dashboard");
    expect(openerLabel("/scm/accounting")).toBe("Accounting");
  });
});
