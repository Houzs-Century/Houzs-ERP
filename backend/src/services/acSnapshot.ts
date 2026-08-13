// ── AutoCount full snapshots (migration reconciliation) ─────────────
// Unfiltered copies of AutoCount's Sales Orders and Purchase Order headers
// into the ac_snapshot_* staging tables (mig 0282).
//
// This is NOT another mirror. The live `sales_orders` mirror is filtered:
// runPull() skips every order routeRegion() rejects, which on 2026-08-12 left
// it holding 3,208 rows against SO numbers issued up to SO-013214. Because the
// dropped rows leave no trace, "is the migration data clean yet?" had no
// answer — a document missing from the ERP and a document the filter removed
// look identical.
//
// So the snapshot stores EVERY row and, for sales orders, records what
// routeRegion() would have decided (`region_route`, NULL = the live mirror
// skips it). The filter's losses become a WHERE clause.
//
// Read-only against AutoCount, and it writes only to its own staging tables —
// it can never corrupt the mirror the business runs on.

import type { Env, ACSalesOrder, ACPurchaseOrderDoc } from "../types";
import { AutoCountClient, dateOnly, routeRegion } from "./autocount";
import { writeLog } from "./logger";

export type SnapshotKind = "SO" | "PO";

export interface SnapshotResult {
  kind: SnapshotKind;
  fetched: number;
  stored: number;
  failed: number;
  snapshotAt: string;
  message: string;
}

// Matches the DO mirror's batch size: big enough that 13k rows is ~33 round
// trips, small enough that one bad batch loses little and the bound-parameter
// count stays well inside the driver's limit.
const FLUSH_AT = 400;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * AutoCount writes Cancelled as the string "T"/"F" on some endpoints and a
 * real boolean on others. Treat every shape as the same question.
 */
export function isCancelled(v: unknown): boolean {
  if (v === true || v === 1) return true;
  const s = String(v ?? "").trim().toUpperCase();
  return s === "T" || s === "TRUE" || s === "1";
}

async function recordRun(
  env: Env,
  kind: SnapshotKind,
  triggerType: "MANUAL" | "SCHEDULED",
  status: "SYNCED" | "FAILED",
  r: { fetched: number; stored: number; failed: number; message: string },
  startedAt: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ac_snapshot_runs
       (kind, trigger_type, status, fetched, stored, failed, message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      kind,
      triggerType,
      status,
      r.fetched,
      r.stored,
      r.failed,
      r.message,
      startedAt,
      new Date().toISOString()
    )
    .run();
}

/**
 * Full Sales Order snapshot via /SalesOrder/getAll — every order, including
 * the ones routeRegion() rejects.
 */
export async function runSOSnapshot(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<SnapshotResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const snapshotAt = startedAt.toISOString();
  const client = new AutoCountClient(env, rid);

  let fetched = 0;
  let stored = 0;
  let failed = 0;
  let batch: unknown[][] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    const values = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
    try {
      await env.DB.prepare(
        `INSERT INTO ac_snapshot_sales_orders
           (doc_no, doc_date, ref, branding, debtor_name, sales_location, sales_agent,
            venue, local_total, balance, remark2, transfer_to, po_doc_no, last_modified,
            region_route, raw, snapshot_at)
         VALUES ${values}
         ON CONFLICT(doc_no) DO UPDATE SET
           doc_date = excluded.doc_date,
           ref = excluded.ref,
           branding = excluded.branding,
           debtor_name = excluded.debtor_name,
           sales_location = excluded.sales_location,
           sales_agent = excluded.sales_agent,
           venue = excluded.venue,
           local_total = excluded.local_total,
           balance = excluded.balance,
           remark2 = excluded.remark2,
           transfer_to = excluded.transfer_to,
           po_doc_no = excluded.po_doc_no,
           last_modified = excluded.last_modified,
           region_route = excluded.region_route,
           raw = excluded.raw,
           snapshot_at = excluded.snapshot_at`
      )
        .bind(...rows.flat())
        .run();
      stored += rows.length;
    } catch (err) {
      failed += rows.length;
      console.error(`[ac-snapshot-so][${rid}] batch failed (${rows.length} rows)`, err);
    }
  };

  try {
    const data = await client.getAll();

    for (const o of data as ACSalesOrder[]) {
      fetched++;
      if (!o?.DocNo) continue;
      batch.push([
        String(o.DocNo),
        dateOnly(o.DocDate),
        o.Ref ?? null,
        o.SOUDF_BRANDING ?? null,
        o.DebtorName ?? null,
        o.SalesLocation ?? null,
        o.SalesAgent ?? null,
        o.SOUDF_VENUE ?? null,
        num(o.Total),
        num(o.SOUDF_BALANCE),
        o.Remark2 ?? null,
        o.TransferTo ?? null,
        o.SOUDF_ToPONo ?? null,
        o.LastModified ?? null,
        routeRegion(o),
        JSON.stringify(o),
        snapshotAt,
      ]);
      if (batch.length >= FLUSH_AT) await flush();
    }
    await flush();

    const message = `SO snapshot: fetched=${fetched} stored=${stored} failed=${failed}`;
    const result: SnapshotResult = { kind: "SO", fetched, stored, failed, snapshotAt, message };
    await writeLog(env, {
      requestId: rid,
      type: `AC_SNAPSHOT_SO_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: failed === 0 ? "SYNCED" : "FAILED",
      message,
    });
    await recordRun(env, "SO", triggerType, failed === 0 ? "SYNCED" : "FAILED", result, snapshotAt);
    return result;
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: `AC_SNAPSHOT_SO_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: "FAILED",
      message,
    });
    await recordRun(
      env,
      "SO",
      triggerType,
      "FAILED",
      { fetched, stored, failed, message },
      snapshotAt
    ).catch(() => {});
    throw err;
  }
}

/**
 * Full Purchase Order header snapshot via /PurchaseOrder/getAll — including
 * cancelled and completed documents, which the outstanding-only line pull
 * cannot see.
 */
export async function runPOSnapshot(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<SnapshotResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const snapshotAt = startedAt.toISOString();
  const client = new AutoCountClient(env, rid);

  let fetched = 0;
  let stored = 0;
  let failed = 0;
  let batch: unknown[][] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    const values = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
    try {
      await env.DB.prepare(
        `INSERT INTO ac_snapshot_purchase_orders
           (doc_no, doc_date, ref, so_doc_no, creditor_code, creditor_name,
            purchase_location, doc_status, cancelled, local_ex_tax, local_net_total,
            final_total, currency_code, last_modified, raw, snapshot_at)
         VALUES ${values}
         ON CONFLICT(doc_no) DO UPDATE SET
           doc_date = excluded.doc_date,
           ref = excluded.ref,
           so_doc_no = excluded.so_doc_no,
           creditor_code = excluded.creditor_code,
           creditor_name = excluded.creditor_name,
           purchase_location = excluded.purchase_location,
           doc_status = excluded.doc_status,
           cancelled = excluded.cancelled,
           local_ex_tax = excluded.local_ex_tax,
           local_net_total = excluded.local_net_total,
           final_total = excluded.final_total,
           currency_code = excluded.currency_code,
           last_modified = excluded.last_modified,
           raw = excluded.raw,
           snapshot_at = excluded.snapshot_at`
      )
        .bind(...rows.flat())
        .run();
      stored += rows.length;
    } catch (err) {
      failed += rows.length;
      console.error(`[ac-snapshot-po][${rid}] batch failed (${rows.length} rows)`, err);
    }
  };

  try {
    const data = await client.getAllPODocs();

    for (const o of data as ACPurchaseOrderDoc[]) {
      fetched++;
      if (!o?.DocNo) continue;
      batch.push([
        String(o.DocNo),
        dateOnly(o.DocDate),
        o.Ref ?? null,
        o.POUDF_SONo ?? null,
        o.CreditorCode ?? null,
        o.CreditorName ?? null,
        o.PurchaseLocation ?? null,
        o.DocStatus ?? null,
        isCancelled(o.Cancelled) ? 1 : 0,
        num(o.LocalExTax),
        num(o.LocalNetTotal),
        num(o.FinalTotal),
        o.CurrencyCode ?? null,
        o.LastModified ?? null,
        JSON.stringify(o),
        snapshotAt,
      ]);
      if (batch.length >= FLUSH_AT) await flush();
    }
    await flush();

    const message = `PO snapshot: fetched=${fetched} stored=${stored} failed=${failed}`;
    const result: SnapshotResult = { kind: "PO", fetched, stored, failed, snapshotAt, message };
    await writeLog(env, {
      requestId: rid,
      type: `AC_SNAPSHOT_PO_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: failed === 0 ? "SYNCED" : "FAILED",
      message,
    });
    await recordRun(env, "PO", triggerType, failed === 0 ? "SYNCED" : "FAILED", result, snapshotAt);
    return result;
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: `AC_SNAPSHOT_PO_${triggerType}`,
      startedAt,
      endedAt: new Date(),
      status: "FAILED",
      message,
    });
    await recordRun(
      env,
      "PO",
      triggerType,
      "FAILED",
      { fetched, stored, failed, message },
      snapshotAt
    ).catch(() => {});
    throw err;
  }
}
