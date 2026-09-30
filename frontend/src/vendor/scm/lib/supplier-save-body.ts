// ----------------------------------------------------------------------------
// supplierSaveBody — what the supplier page sends on Save, for THIS caller
// (owner 2026-09-30: 采购只看采购的部分; 代码只有 finance 能改).
//
// A caller who is not Finance never sends the Finance part: they never saw it,
// and the page used to send the whole form back, so a purchaser's save would
// have written blanks over Finance's TIN and registration numbers. The code
// goes only when it changed — the server refuses a purchaser's change, and
// Finance's once the supplier already has documents or ledger entries.
// ----------------------------------------------------------------------------
import { withoutSupplierFinanceKeys } from '../../shared/supplier-finance-fields';

export function supplierSaveBody<T extends { code: string }>(
  form: T,
  codeOnFile: string,
  finance: boolean,
): Omit<T, 'code'> & { code?: string } {
  const { code, ...rest } = form;
  const base = finance ? rest : withoutSupplierFinanceKeys(rest);
  const next = code.trim();
  return next === codeOnFile ? base : { ...base, code: next };
}
