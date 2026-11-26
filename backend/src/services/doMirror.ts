
import type { Env, ACDeliveryOrder } from "../types";
import { AutoCountClient, dateOnly } from "./autocount";
import { writeLog } from "./logger";
import { isCancelled } from "./acSnapshot";

export interface DoMirrorResult {
  mode: "incremental" | "full";
  fetched: number;
  upserted: number;
  failed: number;
  message: string;
}

const FLUSH_AT = 400;
const CHECKPOINT_KEY = "do_mirror_checkpoint";

async function saveCheckpoint(env: Env, value: string) {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('${CHECKPOINT_KEY}', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(value)
    .run();
}

export async function runDoMirrorSync(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<DoMirrorResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);
  const logType = `DO_MIRROR_${triggerType}`;
  const syncedAt = new Date().toISOString();

  let fetched = 0;
  let upserted = 0;
  let failed = 0;
  let maxLastModified: string | null = null;
  let batch: unknown[][] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    const values = rows.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
    try {
      await env.DB.prepare(
        `INSERT INTO autocount_delivery_orders
           (doc_no, doc_date, ref, debtor_name, sales_agent, total, cancelled, last_modified, synced_at)
         VALUES ${values}
         ON CONFLICT(doc_no) DO UPDATE SET
           doc_date = excluded.doc_date,
           ref = excluded.ref,
           debtor_name = excluded.debtor_name,
           sales_agent = excluded.sales_agent,
           total = excluded.total,
           cancelled = excluded.cancelled,
           last_modified = excluded.last_modified,
           synced_at = excluded.synced_at`
      )
        .bind(...rows.flat())
        .run();
      upserted += rows.length;
    } catch (err) {
      failed += rows.length;
      console.error(`[do-mirror][${rid}] batch upsert failed (${rows.length} rows)`, err);
    }
  };

  const takeDoc = async (o: ACDeliveryOrder | any) => {
    fetched++;
    if (!o?.DocNo) return;
    const lm = o.LastModified != null ? String(o.LastModified) : null;
    if (lm && (!maxLastModified || lm > maxLastModified)) maxLastModified = lm;
    batch.push([
      String(o.DocNo),
      dateOnly(o.DocDate),
      o.Ref != null ? String(o.Ref).trim() : null,
      o.DebtorName ?? null,
      o.SalesAgent ?? null,
      typeof o.Total === "number" ? o.Total : null,
      isCancelled(o.Cancelled) ? 1 : 0,
      lm,
      syncedAt,
    ]);
    if (batch.length >= FLUSH_AT) await flush();
  };

  const finish = async (mode: DoMirrorResult["mode"]): Promise<DoMirrorResult> => {
    const result: DoMirrorResult = {
      mode,
      fetched,
      upserted,
      failed,
      message: `DO mirror [${mode}]: fetched=${fetched} upserted=${upserted} failed=${failed}`,
    };
    await writeLog(env, {
      requestId: rid,
      type: logType,
      startedAt,
      endedAt: new Date(),
      status: failed === 0 ? "SYNCED" : "FAILED",
      message: result.message,
    });
    return result;
  };

  try {
    const cp = await env.DB.prepare(
      `SELECT value FROM system_settings WHERE key = '${CHECKPOINT_KEY}'`
    ).first<{ value: string }>();
    if (cp?.value) {
      const since = await client.getDeliveryOrdersSince(cp.value);
      if (since !== null) {
        for (const o of since) await takeDoc(o);
        await flush();
        if (failed === 0 && maxLastModified) await saveCheckpoint(env, maxLastModified);
        return await finish("incremental");
      }
    }

    const res = await client.fetchAllDeliveryOrders();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let pos = 0;
    let depth = 0;
    let objStart = -1;
    let inStr = false;
    let esc = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      while (pos < buf.length) {
        const ch = buf[pos];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          if (depth === 0) objStart = pos;
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && objStart !== -1) {
            let doc: any = null;
            try {
              doc = JSON.parse(buf.slice(objStart, pos + 1));
            } catch {
              failed++;
            }
            if (doc) await takeDoc(doc);
            buf = buf.slice(pos + 1);
            pos = -1;
            objStart = -1;
          }
        }
        pos++;
      }
    }
    await flush();
    if (failed === 0 && maxLastModified) await saveCheckpoint(env, maxLastModified);
    return await finish("full");
  } catch (err) {
    await writeLog(env, {
      requestId: rid,
      type: logType,
      startedAt,
      endedAt: new Date(),
      status: "FAILED",
      message: `DO mirror aborted after ${fetched} docs: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    throw err;
  }
}
