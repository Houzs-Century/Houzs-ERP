import type { FormSchema } from "./MobileModuleForm";
import { SUPPLIER_FINANCE_BODY_KEYS } from "../vendor/shared/supplier-finance-fields";

/**
 * The phone's supplier form for THIS caller (owner 2026-09-30: 采购只看采购的
 * 部分; finance 这里的权限最大; 代码只有 finance 能改).
 *
 * A caller who is not Finance gets no Finance field — the server strips them
 * from what that caller reads and ignores them in what that caller writes,
 * and the form used to send a "0.00" credit limit back on every save — and,
 * when EDITING, no code field: only Finance changes a supplier's code. A new
 * supplier still takes its code (it must match the AutoCount creditor).
 */
export function supplierFormFor(form: FormSchema, finance: boolean, mode: "new" | "edit"): FormSchema {
  /* The Type numbers a NEW code (owner 2026-11-20): only Finance picks it, and
     an edit numbers nothing. A purchaser's blank code is numbered 400-. */
  const hidden = new Set<string>(finance ? [] : SUPPLIER_FINANCE_BODY_KEYS);
  if (!finance || mode === "edit") hidden.add("codeKind");
  if (!finance && mode === "edit") hidden.add("code");
  if (hidden.size === 0) return form;
  return { ...form, fields: form.fields.filter((f) => !hidden.has(f.key)) };
}
