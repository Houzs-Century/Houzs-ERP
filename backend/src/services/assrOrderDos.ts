/* ----------------------------------------------------------------------------
   assrOrderDos — the ORDER's delivery orders on a service case, each with the
   date it was delivered (owner 2026-09-28: the Customer card needs "DO No" and
   "Delivery Date" beside SO No / Ref No).

   WHY NOT assr_cases.do_date. That column is the SERVICE delivery leg's date
   (delivery_by='own' + do_date feeds the HC Delivery sheet), not the date the
   customer originally received the order. Showing it here would put the return
   trip's date on the original delivery.

   Input is what attachDeliveryOrders already resolved (hand-entered
   delivery_order wins, else do_numbers), so the DO NUMBERS stay decided in one
   place; this only adds each one's date:
     · SCM DOs (scm.delivery_orders, both companies' ERP-native DOs) — the
       actual delivered_at when stamped, else do_date (for linked AutoCount DOs
       do_date IS AutoCount's DocDate = the delivery date).
     · AutoCount-mirror DOs (autocount_delivery_orders, HOUZS pre-cutover) —
       doc_date.
   SCM reads are scoped to the case's own company_id; a case without one gets
   no SCM dates rather than an unscoped read.

   Fail-soft like do_numbers: a failed read leaves the date null and the case
   still loads. Detail-only — the list does not need it.
   ---------------------------------------------------------------------------- */
import type { Env } from "../types";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";

export interface AssrOrderDo {
  do_number: string;
  delivery_date: string | null;
}

export function orderDoNumbers(r: Record<string, unknown>): string[] {
  const raw = String(r.delivery_order || r.do_numbers || "");
  return [...new Set(raw.split(/\s*[·,;]\s*/).map((s) => s.trim()).filter(Boolean))];
}

const dayOf = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export async function attachOrderDeliveryDates(env: Env, rows: Array<Record<string, unknown>>): Promise<void> {
  const dates = new Map<string, string>();
  const all = [...new Set(rows.flatMap(orderDoNumbers))];

  if (all.length > 0 && isSupabaseConfigured(env)) {
    const byCompany = new Map<number, string[]>();
    for (const r of rows) {
      const companyId = Number(r.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) continue;
      byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), ...orderDoNumbers(r)]);
    }
    try {
      const sb = getSupabaseService(env);
      await Promise.all(
        [...byCompany].map(async ([companyId, nos]) => {
          const { data, error } = await sb
            .from("delivery_orders")
            .select("do_number, do_date, delivered_at")
            .eq("company_id", companyId)
            .in("do_number", [...new Set(nos)]);
          if (error) throw error;
          for (const d of data ?? []) {
            const day = dayOf(d.delivered_at) ?? dayOf(d.do_date);
            if (d.do_number && day) dates.set(String(d.do_number), day);
          }
        }),
      );
    } catch (e) {
      console.warn("[assr-detail] SCM DO date lookup skipped:", e);
    }
  }

  const missing = all.filter((n) => !dates.has(n));
  if (missing.length > 0) {
    try {
      const q = await env.DB.prepare(
        `SELECT doc_no, doc_date FROM autocount_delivery_orders
          WHERE cancelled = 0 AND doc_no IN (${missing.map(() => "?").join(",")})`,
      )
        .bind(...missing)
        .all();
      for (const d of (q.results ?? []) as Array<Record<string, unknown>>) {
        const day = dayOf(d.doc_date);
        if (d.doc_no && day) dates.set(String(d.doc_no), day);
      }
    } catch (e) {
      console.warn("[assr-detail] AutoCount DO date lookup skipped:", e);
    }
  }

  for (const r of rows) {
    r.order_dos = orderDoNumbers(r).map<AssrOrderDo>((n) => ({ do_number: n, delivery_date: dates.get(n) ?? null }));
  }
}
