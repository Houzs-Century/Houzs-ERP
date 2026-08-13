import type { Env, ACSalesOrder } from "../types";
import { AutoCountClient, cleanPhone, dateOnly, routeRegion } from "./autocount";
import { writeLog } from "./logger";

export type PullMode = "filtered" | "all";

export interface PullResult {
  mode: PullMode;
  fetched: number;
  upserted: number;
  skipped: number;
  failed: number;
  checkpointAdvanced: boolean;
  newCheckpoint: string | null;
  message: string;
}

export async function runPull(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED",
  mode: PullMode = "filtered"
): Promise<PullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);
  const logType = mode === "all" ? `PULL_ALL_${triggerType}` : `PULL_${triggerType}`;

  try {
    // "all" mode: full refresh via /getAll, no checkpoint involvement.
    // "filtered" mode: incremental via /getSince, advances checkpoint.
    let checkpoint = "";
    if (mode === "filtered") {
      const cp = await env.DB.prepare(
        `SELECT value FROM system_settings WHERE key = 'pull_checkpoint'`
      ).first<{ value: string }>();
      checkpoint = cp?.value || "2000-01-01 00:00:00";
    }

    const data = mode === "all" ? await client.getAll() : await client.getSince(checkpoint);

    if (!data.length) {
      const result: PullResult = {
        mode,
        fetched: 0,
        upserted: 0,
        skipped: 0,
        failed: 0,
        checkpointAdvanced: false,
        newCheckpoint: null,
        message: "No modifications since checkpoint.",
      };
      await writeLog(env, { requestId: rid, type: logType, startedAt, status: "SKIPPED", message: result.message });
      return result;
    }

    let upserted = 0;
    let skipped = 0;
    let failed = 0;

    for (const o of data) {
      const region = routeRegion(o);
      if (!region) {
        skipped++;
        continue;
      }
      try {
        await upsertSalesOrder(env, o, region);
        upserted++;
      } catch (err) {
        failed++;
        console.error(`[pull][${rid}] Upsert failed for ${o.DocNo}`, err);
      }
    }

    let checkpointAdvanced = false;
    let newCheckpoint: string | null = null;
    // Only the filtered (incremental) mode advances the checkpoint.
    if (mode === "filtered" && failed === 0) {
      const last = data[data.length - 1];
      if (last.LastModified) {
        await env.DB.prepare(
          `UPDATE system_settings SET value = ? WHERE key = 'pull_checkpoint'`
        )
          .bind(last.LastModified)
          .run();
        checkpointAdvanced = true;
        newCheckpoint = last.LastModified;
      }
    }

    const result: PullResult = {
      mode,
      fetched: data.length,
      upserted,
      skipped,
      failed,
      checkpointAdvanced,
      newCheckpoint,
      message: `[${mode}] Fetched ${data.length}, upserted ${upserted}, skipped ${skipped}, failed ${failed}.`,
    };

    await writeLog(env, {
      requestId: rid,
      type: logType,
      startedAt,
      status: failed > 0 ? "FAILED" : "SYNCED",
      message: result.message,
    });
    return result;
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, { requestId: rid, type: logType, startedAt, status: "FAILED", message });
    throw err;
  }
}

/* Upsert one AutoCount SO into the local `sales_orders` MIRROR. Read-only
   against AutoCount — this only ever writes ERP tables.

   `ac_udf_pdate` (renamed from `processing_date` in mig 0285) is AutoCount's own
   user-defined field SO.UDF_PDate, copied verbatim for AutoCount's document. It
   is NOT the ERP's Processing Date and must never be read as one: the ERP has
   exactly ONE Processing Date, scm.mfg_sales_orders.internal_expected_dd, on a
   different table for a different document, and nothing joins the two. The old
   name made this column look like the ERP's field to every reader who met it,
   which is the confusion the owner has now called out more than three times. */
export async function upsertSalesOrder(env: Env, o: ACSalesOrder, region: "WEST" | "EAST" | "SG"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_orders (
       doc_no, region, transfer_to, doc_date, ref, branding, debtor_name, phone,
       sales_location, sales_agent, local_total, balance, remark2, remark3, remark4,
       ac_udf_pdate, expiry_date, note, po_doc_no, inv_addr1, inv_addr2, inv_addr3,
       inv_addr4, venue, attention, sync_status, sync_error, last_modified, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       'SYNCED', NULL, ?, datetime('now')
     )
     ON CONFLICT(doc_no) DO UPDATE SET
       region = excluded.region,
       transfer_to = excluded.transfer_to,
       doc_date = excluded.doc_date,
       ref = excluded.ref,
       branding = excluded.branding,
       debtor_name = excluded.debtor_name,
       phone = excluded.phone,
       sales_location = excluded.sales_location,
       sales_agent = excluded.sales_agent,
       local_total = excluded.local_total,
       balance = excluded.balance,
       remark2 = excluded.remark2,
       remark3 = excluded.remark3,
       remark4 = excluded.remark4,
       ac_udf_pdate = excluded.ac_udf_pdate,
       expiry_date = excluded.expiry_date,
       note = excluded.note,
       po_doc_no = excluded.po_doc_no,
       inv_addr1 = excluded.inv_addr1,
       inv_addr2 = excluded.inv_addr2,
       inv_addr3 = excluded.inv_addr3,
       inv_addr4 = excluded.inv_addr4,
       venue = excluded.venue,
       attention = excluded.attention,
       sync_status = 'SYNCED',
       sync_error = NULL,
       last_modified = excluded.last_modified,
       updated_at = datetime('now')`
  )
    .bind(
      o.DocNo,
      region,
      o.TransferTo ?? null,
      dateOnly(o.DocDate),
      o.Ref ?? null,
      o.SOUDF_BRANDING ?? null,
      o.DebtorName ?? null,
      cleanPhone(o.Phone1),
      o.SalesLocation ?? null,
      o.SalesAgent ?? null,
      o.Total ?? 0,
      o.SOUDF_BALANCE ?? 0,
      o.Remark2 ?? null,
      o.Remark3 ?? null,
      o.Remark4 ?? null,
      dateOnly(o.SOUDF_PDate),
      dateOnly(o.SalesExemptionExpiryDate),
      o.SOUDF_Note ?? null,
      o.SOUDF_ToPONo ?? null,
      o.InvAddr1 ?? null,
      o.InvAddr2 ?? null,
      o.InvAddr3 ?? null,
      o.InvAddr4 ?? null,
      o.SOUDF_VENUE ?? null,
      o.Attention ?? null,
      o.LastModified ?? null
    )
    .run();
}
