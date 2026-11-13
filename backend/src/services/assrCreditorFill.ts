import type { Env } from "../types";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { attachOrderPurchaseOrders, attachExchangePurchaseOrders, itemsWithLivePo, poKey } from "./assrOrderPos";
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
}

/** `exchange_pos` — the case's OWN exchange purchase orders (scm.purchase_orders
 *  .assr_case_id), the env wrapper of attachExchangePurchaseOrders. Company-scoped
 *  and fail-soft; the D1 test env has no scm, so it is skipped there. */
export async function attachExchangePosEnv(env: Env, rows: Array<Record<string, any>>) {
  for (const r of rows) r.exchange_pos = [];
  if (isSupabaseConfigured(env)) await attachExchangePurchaseOrders(getSupabaseService(env), rows);
}
