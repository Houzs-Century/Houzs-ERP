// ----------------------------------------------------------------------------
// pms-ledger-categories — CANONICAL project P&L category list + label.
// NO React, no I/O. Imported by desktop `Projects.tsx` and mobile
// `MobilePMS.tsx`, the same split `pms-status.ts` already uses for stages.
//
// WHY IT EXISTS. Desktop mapped these slugs explicitly; mobile ran a generic
// `humanize()` (underscores -> spaces, title-case) over every finance and sales
// line. The same P&L row therefore read "COGS — Matt/Sofa" on the PC and
// "Cogs Matt Sofa" on the phone — two people reading one P&L read different
// category names. Desktop was right, so desktop's words are the ones here.
//
// Mirrors backend/src/services/projects.ts -> LEDGER_COST_CATEGORIES /
// LEDGER_INCOME_CATEGORIES. The backend accepts arbitrary strings on write;
// these lists are the PICKER surface only, which is why `ledgerCategoryLabel`
// still degrades gracefully for a slug that is not in them.
//
// 2026-05-08 — the boss's Financial Snapshot model split COGS into product
// sub-categories and transport into a rate-driven fee + actual logistics cost.
// Legacy `cogs` and `transport` stay in the picker so old rows are still
// pickable on edit; new rows should pick a sub-category.
// ----------------------------------------------------------------------------

export const LEDGER_COST_CATS = [
  "rental",
  "cogs", "cogs_matt_sofa", "cogs_bedframe", "cogs_accessories",
  "setup",
  "transport", "transport_fee", "transport_setup_dismantle",
  "commission", "merchandise",
  "contractor", "license", "deposit", "permit",
  "accommodation", "staffing", "marketing", "misc",
];

export const LEDGER_INCOME_CATS = ["sales", "deposit_refund", "rebate", "other_income"];

/** The words themselves. Anything not named here title-cases its slug — the
 *  same fallback desktop's `catLabel` always had, kept so a category the
 *  backend accepts but the picker has never heard of still renders readably
 *  instead of blank. */
const LEDGER_CATEGORY_LABEL: Record<string, string> = {
  cogs: "COGS",
  cogs_matt_sofa: "COGS — Matt/Sofa",
  cogs_bedframe: "COGS — Bedframe",
  cogs_accessories: "COGS — Accessories",
  transport: "Transport",
  transport_fee: "Transport Fee",
  transport_setup_dismantle: "Transport Setup & Dismantle",
  contractor: "Contractor",
  license: "License",
  deposit: "Deposit paid",
  deposit_refund: "Deposit refund",
  other_income: "Other income",
};

export function ledgerCategoryLabel(cat: string | null | undefined): string {
  const c = (cat ?? "").trim();
  if (!c) return "—";
  return (
    LEDGER_CATEGORY_LABEL[c] ??
    c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, " ")
  );
}
