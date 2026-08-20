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
  /* BACKFILL WINDOW. `null` = normal behaviour. A date here makes the pull ask
     getSince(<that date>) instead of getSince(checkpoint), and the checkpoint is
     NEITHER read NOR advanced — so a backfill cannot disturb the incremental pull
     that is working.

     Required as `| null` rather than optional: it decides which window AutoCount
     is asked for, and CLAUDE.md's rule is that a parameter which decides
     something must make every caller say so.

     Why this exists: `mode: "all"` calls getAll(), and against ~13,000 orders
     that KILLED THE WORKER — measured 2026-08-19, 39 seconds then
     `Worker exceeded resource limits`. A full refresh cannot run in one request,
     so a backlog has to be collected in windows. */
  since: string | null = null
): Promise<PullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);
  const logType = mode === "all" ? `PULL_ALL_${triggerType}` : `PULL_${triggerType}`;

  try {
    // "all" mode: full refresh via /getAll, no checkpoint involvement.
    // "filtered" mode: incremental via /getSince, advances checkpoint.
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
    // `since` never advances the checkpoint: a backfill reaches BACKWARDS, so
    // writing its window forward would skip everything between.
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
/* WHAT THIS STATEMENT WRITES IS THE POSTGRES TABLE, NOT THE OLD D1 ONE.
 *
 * `public.sales_orders` was created by `0000_baseline.sql` with 22 columns and
 * has gained exactly two since (`customer_email`, 0009; `processing_date` renamed
 * to `ac_udf_pdate`, 0285). This INSERT named SEVEN columns that have never
 * existed on it — `transfer_to`, `note`, `inv_addr1..4`, `sync_error` — carried
 * over verbatim from the D1 schema (`src/db/schema.sql`) at the Postgres cutover.
 * Postgres answers an unknown column with 42703 and refuses the whole statement,
 * so EVERY AutoCount sales-order pull threw, `failed` incremented for all of
 * them, and `runPull` only advances `pull_checkpoint` when `failed === 0` — the
 * window is refetched forever and the mirror has taken nothing since the cutover.
 * Nothing surfaced it because the per-row failure is caught and counted.
 *
 * `company_id` is the other half. Migration 0083 added it and set it NOT NULL
 * with no DEFAULT, and this statement never named it, so even with the seven
 * phantom columns removed the first INSERT of a new doc_no would 23502. It is
 * resolved in SQL from the companies master rather than passed in, because that
 * is precisely what 0083's own backfill did (`WHERE code = 'HOUZS'`) and it keeps
 * the value out of reach of a caller that could get it wrong: this mirror is the
 * HOUZS account book by construction — AutoCount is company 1's system, 2990 has
 * its own — so there is no second answer to pick between.
 *
 * The four address fields and the note are NOT quietly dropped data: the columns
 * they were being written to do not exist, so nothing was ever stored in them.
 * `o.InvAddr1..4` / `o.SOUDF_Note` are still read from AutoCount by the puller's
 * caller and are simply not part of this table's shape. If they are wanted, the
 * fix is a migration that adds them, not a statement that pretends they are there.
 */
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
