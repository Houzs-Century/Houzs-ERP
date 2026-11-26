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
  mode: PullMode = "filtered",
  since: string | null = null
): Promise<PullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);
  const logType = mode === "all" ? `PULL_ALL_${triggerType}` : `PULL_${triggerType}`;

  try {
    let checkpoint = "";
    if (mode === "filtered" && !since) {
      const cp = await env.DB.prepare(
        `SELECT value FROM system_settings WHERE key = 'pull_checkpoint'`
      ).first<{ value: string }>();
      checkpoint = cp?.value || "2000-01-01 00:00:00";
    }

    const data =
      since ? await client.getSince(since)
      : mode === "all" ? await client.getAll()
      : await client.getSince(checkpoint);

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
    const failedRows: string[] = [];

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
        if (failedRows.length < 5) failedRows.push(`${o.DocNo}: ${(err as Error)?.message ?? String(err)}`.slice(0, 200));
        console.error(`[pull][${rid}] Upsert failed for ${o.DocNo}`, err);
      }
    }

    let checkpointAdvanced = false;
    let newCheckpoint: string | null = null;
    if (mode === "filtered" && !since && failed === 0) {
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
      message: `[${mode}] Fetched ${data.length}, upserted ${upserted}, skipped ${skipped}, failed ${failed}.${failedRows.length ? ` Failed rows: ${failedRows.join(" | ")}` : ""}`,
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

export async function upsertSalesOrder(env: Env, o: ACSalesOrder, region: "WEST" | "EAST" | "SG"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_orders (
       company_id,
       doc_no, region, doc_date, ref, branding, debtor_name, phone,
       sales_location, sales_agent, local_total, balance, remark2, remark3, remark4,
       ac_udf_pdate, expiry_date, po_doc_no,
       venue, attention, sync_status, last_modified, updated_at
     ) VALUES (
       (SELECT id FROM companies WHERE code = 'HOUZS'),
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       'SYNCED', ?, datetime('now')
     )
     ON CONFLICT(doc_no) DO UPDATE SET
       region = excluded.region,
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
       po_doc_no = excluded.po_doc_no,
       venue = excluded.venue,
       attention = excluded.attention,
       sync_status = 'SYNCED',
       last_modified = excluded.last_modified,
       updated_at = datetime('now')`
  )
    .bind(
      o.DocNo,
      region,
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
      o.SOUDF_ToPONo ?? null,
      o.SOUDF_VENUE ?? null,
      o.Attention ?? null,
      o.LastModified ?? null
    )
    .run();
}

/**
 * The columns `public.sales_orders` actually has, and the ones this module is
 * allowed to write. Exported so a test can hold the statement above to the
 * schema instead of to a reviewer's memory — the seven phantom columns survived
 * every review of this file for the whole life of the Postgres cutover.
 */
export const SALES_ORDERS_MIRROR_COLUMNS = [
  "id", "company_id", "doc_no", "doc_date", "ref", "branding", "debtor_name",
  "phone", "sales_location", "sales_agent", "region", "local_total", "balance",
  "remark2", "remark3", "remark4", "ac_udf_pdate", "expiry_date", "po_doc_no",
  "venue", "attention", "last_modified", "sync_status", "updated_at",
  "customer_email",
] as const;
