// so-history-labels — the human labels the mobile SO timeline prints for an
// audit row's `field` key, and which of those keys hold money.
//
// Lifted out of MobileSODetail.tsx on 2026-09-09, unchanged. That file sits at
// its file-size ceiling (scripts/file-size-ceilings.json), and the repo's rule
// for a file at its ceiling is that the fix is a new module, never a bigger
// number — so the "Shared with" field needed room, and a pure constant map with
// no behaviour is the cheapest thing in that file to move and the safest to
// review. Nothing here changed in the move; only its address did.
//
// It remains a SUBSET of desktop's FIELD_LABEL, as its original comment said,
// and the two are still hand-maintained copies. Unifying them is a real
// improvement and deliberately NOT done here: desktop's map carries labels this
// screen has no surface for, so a merge is a product decision about what the
// mobile timeline should show, not a refactor.

/* Human labels for the audit `field` keys — subset of desktop's FIELD_LABEL
   plus the payment / amendment / automation keys the mobile timeline surfaces. */
export const HIST_FIELD_LABEL: Record<string, string> = {
  debtorName: "Customer", debtorCode: "Customer code", agent: "Agent",
  phone: "Phone", email: "Email", soDate: "SO date", status: "Status",
  paymentMethod: "Payment method", depositSen: "Deposit",
  processingDate: "Processing Date", customerSoNo: "Customer SO ref",
  customerPo: "Customer PO", customerDeliveryDate: "Delivery Date",
  amendedDeliveryDate: "Amended delivery date",
  amendDateFromCustomer: "Amend date (customer)", amendReason: "Amend reason",
  deliveryState: "Delivery region", possessionDate: "Possession date",
  houseType: "House type", replacementDisposal: "Replacement / disposal",
  referral: "Referral", city: "City", postcode: "Postcode",
  buildingType: "Building type", address1: "Address 1", address2: "Address 2",
  address3: "Address 3", address4: "Address 4", note: "Note", remark: "Remark",
  itemCode: "Item", itemGroup: "Group", description: "Description",
  description2: "Description 2", uom: "UOM", qty: "Qty",
  unitPriceSen: "Unit price", discountSen: "Discount",
  unitCostSen: "Unit cost", totalSen: "Line total", lineCount: "Lines",
  localTotalSen: "Total", amountSen: "Amount", paidAt: "Paid on",
  method: "Method", merchantProvider: "Bank", installmentMonths: "Installment months",
  onlineType: "Online type", approvalCode: "Approval code",
  stockStatus: "Stock status", salespersonId: "Salesperson",
  customerType: "Customer type", venue: "Venue", venueId: "Venue (master)",
  salesLocation: "Sales location", customerState: "State", cancelled: "Cancelled",
  photoAdded: "Photo added", photoRemoved: "Photo removed",
  tbcVariants: "Variants updated", sofaBuild: "Sofa build",
  pwpCode: "PWP code", pwpRewardsReverted: "PWP rewards reverted",
  pwpCodesDeleted: "PWP codes deleted", photosCleaned: "Photos removed",
  /* Added with shared Sales Orders (2026-09-09). The bulk share/withdraw writes
     this field, so a timeline that did not know it printed the raw key. */
  collaboratorStaffIds: "Shared with",
};

/* WHICH audit fields are money has ONE home, and it is desktop's SO audit
   dictionary. The two sets were byte-identical copies until 2026-09-09, when
   lifting this file out of MobileSODetail.tsx made them visible to
   `audit:duplicated-decisions` — the gate was right: whether `depositSen` is
   money is one question, and two surfaces answering it separately is a
   divergence waiting to happen, not a presentation difference.
   (Mobile importing a pure data module out of `pages/` follows
   MobileMailCenter.tsx, which reads `pages/MailCenter/mail-labels`.) */
export { SO_AUDIT_MONEY_FIELDS as HIST_MONEY_FIELDS } from "../pages/scm-v2/so-audit-labels";
