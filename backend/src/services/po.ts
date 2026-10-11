// ── AutoCount Purchase Order pulls ──────────────────────────────────
// Restored from dfa1111~1 (strip-to-core removed it) with the batch shape
// updated to the multi-row INSERT the DO mirror uses.
//
// WHY THIS MATTERS beyond the migration reconciliation: both target tables are
// still read on main and both have been frozen since 2026-06-12, because the
// 2026-07-14 restore brought back the SO pull only.
//   * `purchase_orders`      → ASSR's supplier-PO lookup by SO number
//   * `purchase_order_docs`  → Finance / P&L purchase-cost roll-up
// Finance has therefore been costing against a two-month-old mirror. The first
// successful run WILL move those numbers — that is the bug being fixed, not a
// regression.
//
// Two endpoints, two different questions:
//   * /PurchaseOrder/getOutstanding → LINE level, already filtered by the
//     middleware to `Qty - TransferedQty > 0`. Every row is outstanding by
//     construction; cancelled and fully-delivered docs never appear.
//   * /PurchaseOrder/getAll         → DOC level, everything, including
//     cancelled and completed.
//
// Both are wipe-and-reload, and both fetch BEFORE deleting so a failed fetch
// leaves the existing mirror untouched. Locally-edited fields (overdue_days,
// manual amount overrides) are read back and restored across the reload —
// a sync must never silently eat somebody's typing.

import type { Env } from "../types";
import { AutoCountClient, dateOnly } from "./autocount";
import { isCancelled } from "./acSnapshot";
import { writeLog } from "./logger";

const FLUSH_AT = 400;

export interface POPullResult {
  fetched: number;
  inserted: number;
  preserved: number;
  message: string;
}

export interface PODocsPullResult {
  fetched: number;
  inserted: number;
  outstanding: number;
  delivered: number;
  cancelled: number;
  preserved: number;
  message: string;
}

interface ManualLineAmount {
  amount: number | null;
  amount_source: string | null;
  amount_updated_at: string | null;
  amount_updated_by: number | null;
  unit_price: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Line money, in preference order: the local-currency line total AutoCount
 * computed, then the foreign-currency one, then unit price × outstanding qty
 * so the *outstanding commitment* still surfaces when the middleware version
 * returns no totals at all. Returns null when nothing is derivable — a null
 * amount is a visible gap the user can fill, a wrong amount is not.
 */
export function deriveLineAmount(o: Record<string, any>): number | null {
  const local = num(o.LocalSubTotal) ?? num(o.LocalSubTotalExTax);
  if (local != null) return local;
  const foreign = num(o.SubTotal);
  if (foreign != null) return foreign;
  const unit = num(o.UnitPriceAfterDiscount) ?? num(o.UnitPrice);
  const qty = num(o.RemainingQty);
  if (unit != null && qty != null) return unit * qty;
  return null;
}

/**
 * Pull outstanding PO LINES from /PurchaseOrder/getOutstanding into the
 * line-level `purchase_orders` table.
 */
export async function runPOPull(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<POPullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    // Fetch FIRST — a failure here must leave the mirror alone.
    const data = await client.getOutstandingPOs();

    // Back up the fields a human may have edited, keyed by doc_no|item_code.
    const existing = await env.DB.prepare(
      `SELECT doc_no, item_code, overdue_days,
              amount, amount_source, amount_updated_at, amount_updated_by, unit_price
         FROM purchase_orders`
    ).all<{
      doc_no: string;
      item_code: string;
      overdue_days: string | null;
      amount: number | null;
      amount_source: string | null;
      amount_updated_at: string | null;
      amount_updated_by: number | null;
      unit_price: number | null;
    }>();

    const overdueMap = new Map<string, string>();
    const manualMap = new Map<string, ManualLineAmount>();
    for (const r of existing.results || []) {
      const key = `${r.doc_no}|${r.item_code}`;
      if (r.overdue_days) overdueMap.set(key, r.overdue_days);
      if (r.amount_source === "manual") {
        manualMap.set(key, {
          amount: r.amount,
          amount_source: r.amount_source,
          amount_updated_at: r.amount_updated_at,
          amount_updated_by: r.amount_updated_by,
          unit_price: r.unit_price,
        });
      }
    }

    await env.DB.prepare(`DELETE FROM purchase_orders`).run();

    let inserted = 0;
    let preserved = 0;
    let batch: unknown[][] = [];
    const syncedAt = new Date().toISOString();

    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      const values = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
      await env.DB.prepare(
        `INSERT INTO purchase_orders (
           doc_no, so_doc_no, creditor_code, creditor_name, item_code, item_description,
           location, doc_date, remaining_qty, delivery_date, supplier_date1, supplier_date2,
           supplier_date3, overdue_days,
           unit_price, amount, amount_source, amount_updated_at, amount_updated_by
         ) VALUES ${values}
         ON CONFLICT(doc_no, item_code) DO NOTHING`
      )
        .bind(...rows.flat())
        .run();
      inserted += rows.length;
    };

    for (const o of data) {
      if (!o.DocNo || !o.ItemCode) continue;
      const key = `${o.DocNo}|${o.ItemCode}`;
      const restoredOverdue = overdueMap.get(key) || null;
      if (restoredOverdue) preserved++;

      // A manual override always wins; otherwise take what the sync derives.
      const manual = manualMap.get(key);
      let unit_price: number | null;
      let amount: number | null;
      let amount_source: string | null;
      let amount_updated_at: string | null;
      let amount_updated_by: number | null;

      if (manual) {
        unit_price = manual.unit_price;
        amount = manual.amount;
        amount_source = manual.amount_source;
        amount_updated_at = manual.amount_updated_at;
        amount_updated_by = manual.amount_updated_by;
      } else {
        unit_price = num(o.UnitPriceAfterDiscount) ?? num(o.UnitPrice);
        amount = deriveLineAmount(o);
        amount_source = amount != null ? "sync" : null;
        amount_updated_at = amount != null ? syncedAt : null;
        amount_updated_by = null;
      }

      batch.push([
        o.DocNo,
        o.SODocNo ?? null,
        o.CreditorCode ?? null,
        o.CreditorName ?? null,
        o.ItemCode,
        o.ItemDescription ?? null,
        o.Location ?? null,
        dateOnly(o.DocDate),
        o.RemainingQty ?? 0,
        dateOnly(o.DeliveryDate),
        dateOnly(o.SupplierDeliveryDate1),
        dateOnly(o.SupplierDeliveryDate2),
        dateOnly(o.SupplierDeliveryDate3),
        restoredOverdue,
        unit_price,
        amount,
        amount_source,
        amount_updated_at,
        amount_updated_by,
      ]);
      if (batch.length >= FLUSH_AT) await flush();
    }
    await flush();

    const message = `Pulled ${data.length} PO lines, inserted ${inserted}. Restored ${preserved} overdue_days.`;
    await writeLog(env, {
      requestId: rid,
      type: `PO_PULL_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: "SYNCED",
      message,
    });
    return { fetched: data.length, inserted, preserved, message };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: `PO_PULL_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: "FAILED",
      message,
    });
    throw err;
  }
}

/**
 * Pull doc-level POs from /PurchaseOrder/getAll into `purchase_order_docs`.
 * One row per PO header — feeds the P&L module and the PO "Documents" view.
 */
export async function runPODocsPull(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<PODocsPullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    const data = await client.getAllPODocs();

    const existing = await env.DB.prepare(
      `SELECT doc_no, local_ex_tax, amount_source, amount_updated_at, amount_updated_by
         FROM purchase_order_docs`
    ).all<{
      doc_no: string;
      local_ex_tax: number | null;
      amount_source: string | null;
      amount_updated_at: string | null;
      amount_updated_by: number | null;
    }>();

    const manualMap = new Map<
      string,
      {
        local_ex_tax: number | null;
        amount_source: string | null;
        amount_updated_at: string | null;
        amount_updated_by: number | null;
      }
    >();
    for (const r of existing.results || []) {
      if (r.amount_source === "manual") {
        manualMap.set(r.doc_no, {
          local_ex_tax: r.local_ex_tax,
          amount_source: r.amount_source,
          amount_updated_at: r.amount_updated_at,
          amount_updated_by: r.amount_updated_by,
        });
      }
    }

    await env.DB.prepare(`DELETE FROM purchase_order_docs`).run();

    let inserted = 0;
    let preserved = 0;
    let outstanding = 0;
    let delivered = 0;
    let cancelledCount = 0;
    let batch: unknown[][] = [];
    const syncedAt = new Date().toISOString();

    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      const values = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
      await env.DB.prepare(
        `INSERT INTO purchase_order_docs (
           doc_no, doc_date, ref, so_doc_no, creditor_code, creditor_name,
           purchase_location, doc_status, cancelled,
           local_ex_tax, local_tax, local_net_total, final_total,
           currency_code, currency_rate,
           remark1, remark2, remark3, remark4, note, last_modified,
           amount_source, amount_updated_at, amount_updated_by, raw
         ) VALUES ${values}
         ON CONFLICT(doc_no) DO NOTHING`
      )
        .bind(...rows.flat())
        .run();
      inserted += rows.length;
    };

    for (const o of data) {
      if (!o.DocNo) continue;

      const cancelled = isCancelled(o.Cancelled);
      // DocStatus 'C' = Closed/Completed; anything else is still active.
      const isDelivered = !cancelled && String(o.DocStatus || "").toUpperCase() === "C";
      if (cancelled) cancelledCount++;
      else if (isDelivered) delivered++;
      else outstanding++;

      const manual = manualMap.get(o.DocNo);
      let local_ex_tax: number | null = null;
      let amount_source: string | null = null;
      let amount_updated_at: string | null = null;
      let amount_updated_by: number | null = null;

      if (manual) {
        local_ex_tax = manual.local_ex_tax;
        amount_source = manual.amount_source;
        amount_updated_at = manual.amount_updated_at;
        amount_updated_by = manual.amount_updated_by;
        preserved++;
      } else {
        // Ex-tax local subtotal is what cost analysis wants; fall back
        // through the with-tax and foreign-currency totals.
        for (const c of [o.LocalExTax, o.LocalNetTotal, o.FinalTotal, o.Total]) {
          const n = num(c);
          if (n != null && n !== 0) {
            local_ex_tax = n;
            break;
          }
        }
        if (local_ex_tax != null) {
          amount_source = "sync";
          amount_updated_at = syncedAt;
        }
      }

      batch.push([
        o.DocNo,
        dateOnly(o.DocDate),
        o.Ref ?? null,
        o.POUDF_SONo ?? null,
        o.CreditorCode ?? null,
        o.CreditorName ?? null,
        o.PurchaseLocation ?? null,
        o.DocStatus ?? null,
        cancelled ? 1 : 0,
        local_ex_tax,
        num(o.LocalTax),
        num(o.LocalNetTotal),
        num(o.FinalTotal),
        o.CurrencyCode ?? null,
        num(o.CurrencyRate),
        o.Remark1 ?? null,
        o.Remark2 ?? null,
        o.Remark3 ?? null,
        o.Remark4 ?? null,
        o.Note ?? null,
        o.LastModified ?? null,
        amount_source,
        amount_updated_at,
        amount_updated_by,
        JSON.stringify(o),
      ]);
      if (batch.length >= FLUSH_AT) await flush();
    }
    await flush();

    const message =
      `Pulled ${data.length} PO docs, inserted ${inserted} ` +
      `(outstanding ${outstanding}, delivered ${delivered}, cancelled ${cancelledCount}). ` +
      `Preserved ${preserved} manual amounts.`;
    await writeLog(env, {
      requestId: rid,
      type: `PO_DOCS_PULL_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: "SYNCED",
      message,
    });
    return {
      fetched: data.length,
      inserted,
      outstanding,
      delivered,
      cancelled: cancelledCount,
      preserved,
      message,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: `PO_DOCS_PULL_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: "FAILED",
      message,
    });
    throw err;
  }
}
