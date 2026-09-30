// ----------------------------------------------------------------------------
// supplier-finance-fields — the part of a supplier only Finance sees and edits
// (owner 2026-09-30: 采购只看采购的部分; finance 这里的权限最大; 代码只有
// finance 能改). Finance is the caller who may move money — capability
// `scm.money.move`: Finance Executive, Managing Director, Owner, Super Admin.
//
// Byte-identical in backend/src/scm/shared and frontend/src/vendor/shared: the
// server strips these fields from what a purchaser reads and ignores them in
// what a purchaser writes; the screens do not show them to a purchaser.
//
// Currency and payment terms stay with purchasing: a PO is priced in the
// supplier's currency and prints its terms. The CODE is neither side's alone:
// everyone reads it (it names the supplier on every purchase document and
// AutoCount export) and only Finance changes it.
// ----------------------------------------------------------------------------

/** The Finance part, as scm.suppliers names the columns. */
export const SUPPLIER_FINANCE_COLUMNS = [
  'credit_limit_sen', 'tin_number', 'business_reg_no', 'registration_no',
  'exemption_no', 'statement_type', 'aging_basis',
] as const;

/** The same fields as a create or update body names them. */
export const SUPPLIER_FINANCE_BODY_KEYS = [
  'creditLimitSen', 'tinNumber', 'businessRegNo', 'registrationNo',
  'exemptionNo', 'statementType', 'agingBasis',
] as const;

export type SupplierFinanceColumn = (typeof SUPPLIER_FINANCE_COLUMNS)[number];
export type SupplierFinanceBodyKey = (typeof SUPPLIER_FINANCE_BODY_KEYS)[number];

/** A supplier row without its Finance part: what a purchaser reads. */
export function withoutSupplierFinance<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const k of SUPPLIER_FINANCE_COLUMNS) delete out[k];
  return out as T;
}

/** A create or update body without its Finance part: what a purchaser may write. */
export function withoutSupplierFinanceKeys<T extends object>(body: T): T {
  const out = { ...body } as Record<string, unknown>;
  for (const k of SUPPLIER_FINANCE_BODY_KEYS) delete out[k];
  return out as T;
}
