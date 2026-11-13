import type { Env } from "../types";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { applyErpSupplierNames, attachOrderPurchaseOrders, itemsWithLivePo, poKey, supplierPickerResults } from "./assrOrderPos";
import { resolveCreditorForCase } from "./stockItems";

/** HC-0130: a PO raised after the case was created never reached the Supplier.
 *  Only blank, non-manual rows with a live PO for THEIR OWN item (order_pos is
 *  any PO on the SO, so it is not enough) are resolved; once filled, no more reads. */
export async function fillCreditorFromNewPo(env: Env, rows: Array<Record<string, any>>) {
  let todo = rows.filter((r) => !r.creditor_code && r.creditor_source !== "manual" && r.item_code && r.order_pos?.length);
  if (todo.length === 0 || !isSupabaseConfigured(env)) return;
  const withPo = await itemsWithLivePo(getSupabaseService(env), todo);
  todo = todo.filter((r) => withPo.has(poKey(r.company_id, r.doc_no, r.item_code)));
  await Promise.all(todo.map(async (r) => {
    const { code } = await resolveCreditorForCase(env, r.id, r.item_code, { onlyIfBlank: true }).catch(() => ({ code: null }));
    if (!code) return;
    const cr = await env.DB.prepare(
      `SELECT c.creditor_code, c.creditor_source, cr.company_name, cr.email, cr.phone1
         FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code WHERE c.id = ?`
    ).bind(r.id).first<any>();
    r.creditor_code = cr?.creditor_code ?? code;
    r.creditor_source = cr?.creditor_source ?? null;
    r.creditor_name = cr?.company_name ?? null;
    r.creditor_email = cr?.email ?? null;
    r.creditor_phone = cr?.phone1 ?? null;
  }));
}

/** The case list/detail "Order PO" read, then the Supplier fill that depends on it. */
export async function attachOrderPosAndFill(env: Env, rows: Array<Record<string, any>>) {
  await attachOrderPurchaseOrders(getSupabaseService(env), rows);
  await fillCreditorFromNewPo(env, rows);
  await showErpSupplierNames(env, rows, null);
}

/** `<a>company_id` for a case read, or NULL with no scm: the D1 test mirror has
 *  neither scm nor assr_cases.company_id, and showErpSupplierNames is a no-op there. */
export function caseCompanySql(env: Env, a: string): string {
  return isSupabaseConfigured(env) ? `${a}company_id` : "NULL";
}

/** HC-0228: see applyErpSupplierNames. No scm in the D1 test env. Returns `rows`, renamed in place. */
export async function showErpSupplierNames<T extends Record<string, unknown>>(env: Env, rows: T[], trips: Array<Record<string, unknown>> | null): Promise<T[]> {
  if (isSupabaseConfigured(env)) await applyErpSupplierNames(getSupabaseService(env), rows, trips);
  return rows;
}

type PickerHit = { creditor_code: string; company_name: string | null; phone1: string | null };

/** HC-0228: the supplier picker, ERP suppliers first (see supplierPickerResults). */
export async function withErpSuppliers(env: Env, companyIds: number[] | undefined, q: string, hits: PickerHit[]): Promise<PickerHit[]> {
  if (!isSupabaseConfigured(env) || !companyIds?.length) return hits;
  return supplierPickerResults(getSupabaseService(env), companyIds, q, hits);
}

/** HC-0228: the By Creditor groups, ERP-named, then searched by name or code, so
 *  "hookka" finds the 400-H004 group. Shaped as the tab reads it (email, phone). */
export async function namedSupplierGroups(env: Env, groups: Array<Record<string, unknown>>, search: string) {
  const q = search.toLowerCase();
  return (await showErpSupplierNames(env, groups, null))
    .filter((r) => !q || [r.creditor_name, r.creditor_code].some((v) => String(v ?? "").toLowerCase().includes(q)))
    .map(({ creditor_email, creditor_phone, creditor_mobile: _m, creditor_attention: _a, ...r }) => ({ ...r, email: creditor_email ?? null, phone: creditor_phone ?? null }));
}

/** HC-0228: the name for a hand-picked code, ERP list first. undefined = the code is in neither list. */
export async function pickedSupplierName(env: Env, code: string, companyId: number | null): Promise<string | null | undefined> {
  const cr = await env.DB.prepare(`SELECT company_name FROM creditors WHERE creditor_code = ?`).bind(code).first<{ company_name: string | null }>();
  const [erp] = await showErpSupplierNames(env, [{ creditor_code: code, company_id: companyId } as Record<string, unknown>], null);
  if (erp.creditor_name !== undefined) return (erp.creditor_name as string | null) ?? null;
  return cr ? cr.company_name ?? null : undefined;
}
