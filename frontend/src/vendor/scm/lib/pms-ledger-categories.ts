
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
