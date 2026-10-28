#!/usr/bin/env node
// READ-ONLY drift sentinel for the 2990 -> Houzs one-way mirrors (SO + SO
// amendments). The two are separate transports that share one outbox table, so
// every query here is scoped by `entity` -- see the note on the outbox query.
//
// The mirror is: a trigger on 2990 (dolvxrchzbnqvahocwsu) enqueues every SO into
// public.sync_outbox; pg_cron workers (so_outbox_drain / _confirm / _reconcile)
// POST each SO to the Houzs receiver, which idempotently upserts it into Houzs
// (anogrigyjbduyzclzjgn) as scm.mfg_sales_orders WHERE company_id = 2.
//
// There is no alarm today if the mirror silently stops (pg_cron paused,
// receiver down, or rows wedged). This script is that alarm: it verifies every
// source SO doc_no is PRESENT in the mirror (source is a subset of the mirror)
// and inspects outbox health, prints a one-line summary, and EXITS NON-ZERO
// when an alarm condition is met so the scheduled GitHub Action fails and the
// owner gets the standard failed-workflow email. Exit 0 when healthy. It only
// ever SELECTs -- never writes.
//
// WHY subset, not count equality (2026-07-28). Equality was the original
// invariant and it went permanently red on 2026-07-27 at drift=-5: the five
// "extra" rows were 2990-SO-2607-020..024, every one created since the
// 2026-07-24 POS cutover by the POS seam principal DIRECTLY in Houzs. Post-
// cutover, new 2990-company SOs are born in Houzs and never exist in the
// legacy source DB, so the mirror legitimately outgrows the source -- equality
// alarms on healthy growth and gets one count redder per POS sale. The failure
// this sentinel exists to catch (2026-07-17, source=63 mirrored=62: one source
// SO the mirror never received) is one-directional, so the check is now the
// set difference source MINUS mirror, by doc_no. Mirror-only rows are printed
// as `extra` for visibility (Houzs-born rows; in principle also a lost
// source-delete delivery) but never alarm.
//
// CREDENTIALS -- why there are two paths.
// This script originally demanded SENTINEL_2990_DB_URL + SENTINEL_HOUZS_DB_URL,
// two secrets nobody ever set. So from the day it was scheduled it printed SKIP
// and exited 0 -- every 30 minutes, green, checking nothing. On 2026-07-17 the
// mirror was found holding at source=63 mirrored=62: one SO had been stuck for
// days and the alarm built to catch exactly that had reported healthy the whole
// time. An alarm that fails silent is worse than no alarm, because the green
// tick gets read as evidence.
//
// The repo already had working credentials for BOTH sides under other names --
// diag-2990.yml reaches 2990 via SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY
// and Houzs via DATABASE_URL, and a 2026-07-17 prod run proved both live. So the
// sentinel was never missing credentials; it was asking for the wrong ones. It
// now accepts either:
//
//   2990:  SENTINEL_2990_DB_URL (postgres)  ||  SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY (REST)
//   Houzs: SENTINEL_HOUZS_DB_URL (postgres) ||  DATABASE_URL (postgres)
//
// Prefer a direct URL when present (one round trip, real SQL aggregates); fall
// back to PostgREST, which needs head-count queries to do what one FILTER
// aggregate does. Same numbers either way for the SO mirror. The amendment
// block is postgres-only -- see readAmendments().
//
// Usage: node scripts/mirror-drift-sentinel.mjs
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const url2990 = process.env.SENTINEL_2990_DB_URL;
const urlHouzs = process.env.SENTINEL_HOUZS_DB_URL || process.env.DATABASE_URL;
const restUrl = process.env.SOURCE_SUPABASE_URL;
const restKey = process.env.SOURCE_SERVICE_ROLE_KEY;

const has2990 = Boolean(url2990 || (restUrl && restKey));

// Stay inert only when a side is genuinely unreachable. This is the ONLY path
// that may exit 0 without checking anything, and reaching it now requires all
// four credential options to be absent -- not just the two nobody set.
if (!has2990 || !urlHouzs) {
  const missing = [];
  if (!has2990) missing.push("2990 (SENTINEL_2990_DB_URL, or SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY)");
  if (!urlHouzs) missing.push("Houzs (SENTINEL_HOUZS_DB_URL, or DATABASE_URL)");
  console.log(`SKIP: no credentials for ${missing.join(" and ")} -- sentinel inert.`);
  process.exit(0);
}

// Alarm thresholds.
const STUCK_MINUTES = 15; // outbox row not 'done' this long past enqueue = stuck
const STALE_DELIVERY_HOURS = 1; // last successful delivery older than this = stale

const src = url2990 ? postgres(url2990, { ssl: "require", prepare: false, max: 1 }) : null;
const rest = src ? null : createClient(restUrl, restKey, { auth: { persistSession: false } });
const dst = postgres(urlHouzs, { ssl: "require", prepare: false, max: 1 });

// entity = 'sales_order' is LOAD-BEARING on every outbox read below, not
// tidiness. sync_outbox is shared with the amendment mirror (entity =
// 'so_amendment', docs/2990-live-sync/04_amendment_outbox_2990.sql). Unscoped,
// these queries broke in both directions the moment a second entity existed:
//   * MASKING -- last_delivery is max(delivered_at) across ALL entities, so a
//     healthy amendment stream keeps it fresh and the staleDelivery alarm never
//     fires even if the SO mirror has stopped delivering entirely. That is the
//     alarm on the one link the owner says must not break.
//   * FALSE ALARM -- a pending amendment row (e.g. 04 applied but the drain not
//     yet enabled, so nothing drains it) counts as `stuck` and reports as an
//     SO-mirror failure.
// The SO alarm is scoped to the SO mirror; amendments get their own block.
const SO_ENTITY = "sales_order";

// Mirror rows carry the batch importer's company prefix (see prefixDoc in
// backend/src/scm/lib/mirror-map.ts): source "SO-2607-020" is stored as
// "2990-SO-2607-020". Apply the same rule to source doc_nos before diffing.
const prefix2990 = (v) => (v == null || String(v).startsWith("2990-") ? String(v) : `2990-${v}`);

/** 2990 SO doc_nos + outbox health, over whichever transport is configured.
 *  The SO doc_no list is fetched in full (tens of rows; the set-diff needs the
 *  actual keys). The OUTBOX is still counted with head:true / FILTER
 *  aggregates rather than fetched: PostgREST caps a select at 1000 rows and
 *  the outbox grows one row per SO EDIT, so aggregating that client-side would
 *  silently under-report past the ceiling. The REST doc_no fetch page-walks in
 *  1000s and cross-checks against the head-count for the same reason. */
async function read2990() {
  if (src) {
    const srcRows = await src`SELECT doc_no FROM public.mfg_sales_orders`;
    const sourceDocNos = srcRows.map((r) => prefix2990(r.doc_no));
    const [o] = await src`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'sent')::int    AS sent,
        count(*) FILTER (WHERE status = 'done')::int    AS done,
        count(*) FILTER (
          WHERE status <> 'done'
            AND enqueued_at < now() - (${STUCK_MINUTES} * interval '1 minute')
        )::int AS stuck,
        max(delivered_at) AS last_delivery
      FROM public.sync_outbox
      WHERE entity = ${SO_ENTITY}`;
    return {
      sourceDocNos,
      pending: Number(o.pending),
      sent: Number(o.sent),
      done: Number(o.done),
      stuck: Number(o.stuck),
      lastDelivery: o.last_delivery,
    };
  }

  const outboxCount = async (build) => {
    const { count, error } = await build(
      rest.from("sync_outbox").select("*", { count: "exact", head: true }).eq("entity", SO_ENTITY),
    );
    if (error) throw new Error(`sync_outbox count: ${error.message}`);
    return Number(count ?? 0);
  };

  const soHead = await rest.from("mfg_sales_orders").select("*", { count: "exact", head: true });
  if (soHead.error) throw new Error(`mfg_sales_orders count: ${soHead.error.message}`);

  // Page-walk the doc_no list and refuse to proceed on a partial read: a
  // silently truncated list would report every truncated row as "missing".
  const sourceDocNos = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await rest
      .from("mfg_sales_orders")
      .select("doc_no")
      .order("doc_no", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`mfg_sales_orders doc_nos: ${error.message}`);
    for (const r of data ?? []) sourceDocNos.push(prefix2990(r.doc_no));
    if (!data || data.length < PAGE) break;
  }
  if (sourceDocNos.length !== Number(soHead.count ?? 0)) {
    throw new Error(
      `source doc_no page-walk returned ${sourceDocNos.length} rows but head-count says ` +
        `${soHead.count} -- refusing to set-diff a partial list`,
    );
  }

  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();
  const [pending, sent, done, stuck] = await Promise.all([
    outboxCount((q) => q.eq("status", "pending")),
    outboxCount((q) => q.eq("status", "sent")),
    outboxCount((q) => q.eq("status", "done")),
    outboxCount((q) => q.neq("status", "done").lt("enqueued_at", cutoff)),
  ]);

  const last = await rest
    .from("sync_outbox")
    .select("delivered_at")
    .eq("entity", SO_ENTITY)
    .not("delivered_at", "is", null)
    .order("delivered_at", { ascending: false })
    .limit(1);
  if (last.error) throw new Error(`last delivery: ${last.error.message}`);

  return {
    sourceDocNos,
    pending,
    sent,
    done,
    stuck,
    lastDelivery: last.data?.[0]?.delivered_at ?? null,
  };
}

/** The stuck rows themselves, capped. "6 rows stuck" is a number to worry about;
 *  the doc_no and last_error are what someone can act on at 2am. */
async function stuckRows(limit = 10) {
  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();
  const cols = "entity_key, op, status, enqueued_at, attempts, last_error";
  if (src) {
    return src`
      SELECT entity_key, op, status, enqueued_at, attempts, last_error
        FROM public.sync_outbox
       WHERE entity = ${SO_ENTITY} AND status <> 'done' AND enqueued_at < ${cutoff}
       ORDER BY enqueued_at ASC LIMIT ${limit}`;
  }
  const { data, error } = await rest
    .from("sync_outbox")
    .select(cols)
    .eq("entity", SO_ENTITY)
    .neq("status", "done")
    .lt("enqueued_at", cutoff)
    .order("enqueued_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`stuck rows: ${error.message}`);
  return data ?? [];
}

/** Amendment mirror health -- POSTGRES ONLY, and today that means it does not
 *  run: SENTINEL_2990_DB_URL is unset, so the live transport is REST and this
 *  reports `amendments=unchecked`. Deliberately not faked over REST rather than
 *  half-built: it is reported as unchecked, never as `off` or healthy, because
 *  an unrun check that reads as a pass is the exact failure this file exists to
 *  cure. Set SENTINEL_2990_DB_URL to switch it on.
 *
 *  Gated on the same sync_config row that gates the drain, so the period
 *  between "04 applied" and "owner enables it" reports as disabled instead of
 *  alarming on rows nothing is draining yet. Reports parity but alarms ONLY on
 *  stuck rows: an unmirrored-but-moving amendment is a transient, whereas the
 *  FK failures this receiver can hit (a 2990 staff member hired after the
 *  one-time import has no scm.staff row) do NOT self-heal and must be seen. */
async function readAmendments() {
  if (!src) return { summary: "amendments=unchecked (needs SENTINEL_2990_DB_URL)", alarms: [] };

  const [amdCfg] = await src`
    SELECT COALESCE((SELECT v FROM sync_config WHERE k = 'enabled_entities'), '') AS v`;
  const amendmentOn = String(amdCfg.v)
    .split(",")
    .map((s) => s.trim())
    .includes("so_amendment");
  if (!amendmentOn) return { summary: "amendments=off", alarms: [] };

  const [{ n: amdSource }] = await src`SELECT count(*)::int AS n FROM public.so_amendments`;
  const [amdOutbox] = await src`
    SELECT count(*) FILTER (
      WHERE status <> 'done'
        AND enqueued_at < now() - (${STUCK_MINUTES} * interval '1 minute')
    )::int AS stuck
    FROM public.sync_outbox
    WHERE entity = 'so_amendment'`;
  const [{ n: amdMirrored }] =
    await dst`SELECT count(*)::int AS n FROM scm.so_amendments WHERE company_id = 2`;
  const amdStuck = Number(amdOutbox.stuck);

  const alarms = [];
  if (amdStuck > 0)
    alarms.push(
      `${amdStuck} amendment outbox row(s) stuck > ${STUCK_MINUTES}m ` +
        `(read net._http_response.content for the receiver's reason)`,
    );
  return {
    summary: `amendments src=${amdSource} mirrored=${amdMirrored} stuck=${amdStuck}`,
    alarms,
  };
}

async function main() {
  const { sourceDocNos, pending, sent, done, stuck, lastDelivery } = await read2990();
  const sourceCount = sourceDocNos.length;

  const mirroredRows = await dst`SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = 2`;
  const mirroredSet = new Set(mirroredRows.map((r) => r.doc_no));
  const mirroredCount = mirroredSet.size;

  // The one-directional invariant (see header): every source SO must exist in
  // the mirror. `extra` = mirror-only rows -- healthy Houzs-born growth since
  // the POS cutover -- reported but never alarmed on.
  const missing = sourceDocNos.filter((d) => !mirroredSet.has(d));
  const extra = mirroredCount - (sourceCount - missing.length);

  const { summary: amendmentSummary, alarms: amendmentAlarms } = await readAmendments();

  // --- last-delivery staleness (only meaningful while work is waiting) ---
  const now = Date.now();
  const lastDeliveryMs = lastDelivery ? new Date(lastDelivery).getTime() : null;
  const deliveryAgeHours = lastDeliveryMs == null ? null : (now - lastDeliveryMs) / 3_600_000;
  const staleDelivery =
    pending > 0 && (lastDeliveryMs == null || deliveryAgeHours > STALE_DELIVERY_HOURS);

  // --- alarm decision ---
  // 1) rows wedged in the SO outbox past the stuck window;
  // 2) source SOs missing from the mirror, once the gap has outlived a drain
  //    cycle;
  // 3) deliveries gone stale while pending work is queued;
  // 4) the amendment mirror's own stuck rows. Kept in the same alarm list so one
  //    failing workflow still means "the mirror needs a look", but worded so the
  //    reader knows WHICH mirror.
  //
  // (2) does not require stuck rows. A trigger that never fired, or a row the
  // reconcile sweep dropped, produces a missing SO with an EMPTY outbox and
  // would stay silent forever -- exactly the 63-vs-62 case: a missing SO
  // leaves nothing wedged to point at it. The transient just-created case is
  // excluded by requiring the gap to outlive a drain cycle, which
  // `pending == 0 && sent == 0` establishes far more precisely than `stuck`
  // ever did. Named doc_nos go in the alarm because "3 missing" is a number to
  // worry about; the doc_no is what someone can chase at 2am.
  const alarms = [...amendmentAlarms];
  if (stuck > 0) alarms.push(`${stuck} SO outbox row(s) stuck > ${STUCK_MINUTES}m`);
  if (missing.length > 0 && (stuck > 0 || (pending === 0 && sent === 0)))
    alarms.push(
      `${missing.length} source SO(s) missing from mirror: ` +
        missing.slice(0, 10).join(", ") +
        (missing.length > 10 ? ` (+${missing.length - 10} more)` : ""),
    );
  if (staleDelivery)
    alarms.push(
      `no delivery for ${deliveryAgeHours == null ? "ever" : deliveryAgeHours.toFixed(1) + "h"} while ${pending} pending`,
    );

  const lastDeliveryStr = lastDelivery ? new Date(lastDelivery).toISOString() : "never";

  console.log(
    `mirror-sentinel: source=${sourceCount} mirrored=${mirroredCount} missing=${missing.length} extra=${extra} ` +
      `stuck=${stuck} pending=${pending} sent=${sent} done=${done} lastDelivery=${lastDeliveryStr} ` +
      `transport=${src ? "pg" : "rest"} | ${amendmentSummary}`,
  );

  if (alarms.length > 0) {
    console.error(`ALARM: ${alarms.join("; ")}`);
    if (stuck > 0) {
      const rows = await stuckRows();
      console.error(`stuck rows (oldest ${rows.length}):`);
      for (const r of rows) {
        console.error(
          `  ${r.entity_key}  op=${r.op}  status=${r.status}  enqueued=${
            r.enqueued_at ? new Date(r.enqueued_at).toISOString() : "?"
          }  attempts=${r.attempts}  last_error=${r.last_error ?? "(none)"}`,
        );
      }
    }
    return 1;
  }
  console.log("OK: mirror healthy (no stuck rows, no missing source SOs, deliveries current).");
  return 0;
}

let code = 0;
try {
  code = await main();
} catch (e) {
  console.error("FAIL: sentinel error -", e.message);
  code = 1;
} finally {
  await src?.end({ timeout: 5 }).catch(() => {});
  await dst.end({ timeout: 5 }).catch(() => {});
}
process.exit(code);
