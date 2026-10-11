// Read-only health report on the ERP -> AutoCount write-back queue
// (scm.autocount_outbox, migrations 0277 + 0280).
//
// WHY THIS EXISTS. Hard rule 4: "a save that succeeds in the ERP while its sync
// is silently lost MUST BE IMPOSSIBLE — a durable queue plus a LOUD alarm...
// making failure VISIBLE." The queue and the alarm are runtime machinery; this
// is the way to ASK, from outside, whether they are actually working. Without
// it the only answer available was `wrangler tail` at the moment a cron fired.
//
// The module doc used to hand the operator two SQL snippets to run by hand.
// That is exactly what this repo's CLAUDE.md forbids ("never ask the owner to
// run a query — build the check instead"), so they are this script instead.
//
// STRICTLY READ-ONLY. SELECT only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer including a bad one — a red job reads as "the
// check broke", and here the ANSWER is the output. Only an unreachable database
// or a malformed query exits non-zero.
//
// THE ORPHAN SECTION IS THE POINT. Every other section reads the queue, so it
// can only ever describe rows that EXIST. The one failure the queue cannot
// describe is its own absence: enqueueAcOp is a dual write outside the
// document's transaction, so a Worker evicted between the two leaves a
// committed ERP document with no outbox row at all — no status, no error, no
// alarm, nothing to count. Section 6 is the only place that failure is
// visible, and it finds it from the DOCUMENT side.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const TOP = Number(process.env.TOP || 25);

const out = (s = "") => console.log(s);
// `notice` puts a line on the workflow run's summary page, so the verdict is
// readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

/* Managed Postgres requires TLS; the postgres:16 service container the PG test
   suite runs against does not offer it at all, and 'require' against it fails
   the connection outright. Local hosts are the only exception, so a production
   DSN can never silently downgrade. */
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
const pg = postgres(url, { ssl: isLocal ? false : "require", prepare: false, max: 1 });

/** Age of a timestamp in whole hours, or null. Formatting only. */
const ageOf = (iso) => {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
};

const pad = (v, n) => String(v ?? "").padEnd(n);
const num = (v, n) => String(v ?? 0).padStart(n);

/**
 * Which of the six document tables can be checked for orphans.
 *
 * Probed rather than assumed. A hard-coded column list that has drifted would
 * make the whole query fail with 42703 (or, worse, silently describe the wrong
 * thing) — and a wrong answer here is worse than a missing one, because this
 * section's whole job is to be believed. A table that cannot be checked is
 * REPORTED as unchecked, never quietly dropped.
 */
const DOC_TABLES = [
  { docType: "SO", table: "mfg_sales_orders", noCol: "doc_no" },
  { docType: "PO", table: "purchase_orders", noCol: "po_number" },
  { docType: "DO", table: "delivery_orders", noCol: "doc_no" },
  { docType: "GR", table: "grns", noCol: "doc_no" },
  { docType: "IV", table: "sales_invoices", noCol: "doc_no" },
  { docType: "PI", table: "purchase_invoices", noCol: "doc_no" },
];

let verdictLines = [];
let worst = "OK";
const escalate = (level) => {
  const rank = { OK: 0, ATTENTION: 1, ALARM: 2 };
  if (rank[level] > rank[worst]) worst = level;
};

try {
  // ── 0. is the write-back even switched on ────────────────────────────────
  out("=".repeat(78));
  out("SECTION 0 — CONFIGURATION");
  out("=".repeat(78));
  const flag = await pg`
    SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
  const flagValue = flag.length ? (flag[0].value ?? "") : "(row absent)";
  const flagOn = flag.length && !["", "off"].includes(String(flag[0].value ?? "").trim().toLowerCase());
  out(`  scm.autocount_writeback = ${JSON.stringify(flagValue)}  ->  ${flagOn ? "ON" : "OFF"}`);
  out(
    flagOn
      ? "  Rows are being queued AND drained for the companies in scope."
      : "  Nothing is queued and nothing is drained. Rows already in the queue stay\n"
        + "  pending — off is not a failure. Everything below describes a queue at rest.",
  );
  out();

  // ── 1. the queue, by status ──────────────────────────────────────────────
  out("=".repeat(78));
  out("SECTION 1 — QUEUE BY STATUS");
  out("=".repeat(78));
  const byStatus = await pg`
    SELECT status,
           count(*)::int                                            AS rows,
           count(*) FILTER (WHERE attempts > 0)::int                AS tried,
           min(created_at)                                          AS oldest,
           max(created_at)                                          AS newest
      FROM scm.autocount_outbox
     GROUP BY status
     ORDER BY status`;
  if (byStatus.length === 0) {
    out("  The outbox is EMPTY — no row has ever been queued.");
  } else {
    out(`  ${pad("status", 10)}${num("rows", 8)}${num("tried", 8)}   oldest`);
    for (const r of byStatus) {
      out(`  ${pad(r.status, 10)}${num(r.rows, 8)}${num(r.tried, 8)}   ${ageOf(r.oldest) ?? "-"}`);
    }
  }
  const total = byStatus.reduce((a, r) => a + r.rows, 0);
  const countOf = (s) => byStatus.find((r) => r.status === s)?.rows ?? 0;
  const pending = countOf("pending");
  const failed = countOf("failed");
  const skipped = countOf("skipped");
  out();
  out(`  TOTAL ${total} row(s): pending ${pending}, sent ${countOf("sent")}, failed ${failed}, skipped ${skipped}`);
  out();

  // ── 2. skipped rows, grouped by reason ───────────────────────────────────
  //
  // A 'skipped' row is not an error — it is the ERP writing down, on purpose,
  // something it will NOT send (a multi-source DO the SDK has no shape for, a
  // compose that failed, an edit refused for want of line identity). The whole
  // value is that it is FINDABLE, so it has to be read back somewhere.
  out("=".repeat(78));
  out("SECTION 2 — SKIPPED ROWS, BY REASON");
  out("=".repeat(78));
  const skippedRows = await pg`
    SELECT doc_type,
           op,
           -- The reason text carries document numbers and DB messages, so the
           -- raw string is near-unique. Cut to its leading clause to group.
           split_part(coalesce(last_error, '(no reason recorded)'), ':', 1) AS reason,
           count(*)::int AS rows,
           max(created_at) AS newest,
           (array_agg(doc_no ORDER BY created_at DESC))[1] AS example
      FROM scm.autocount_outbox
     WHERE status = 'skipped'
     GROUP BY 1, 2, 3
     ORDER BY rows DESC
     LIMIT ${TOP}`;
  if (skippedRows.length === 0) {
    out("  No skipped rows.");
  } else {
    out(`  ${pad("doc", 5)}${pad("op", 12)}${num("rows", 6)}  reason / example`);
    for (const r of skippedRows) {
      out(`  ${pad(r.doc_type, 5)}${pad(r.op, 12)}${num(r.rows, 6)}  ${r.reason}`);
      out(`  ${" ".repeat(23)}  e.g. ${r.example} (${ageOf(r.newest) ?? "-"} ago)`);
    }
    escalate("ATTENTION");
    verdictLines.push(
      `${skippedRows.reduce((a, r) => a + r.rows, 0)} skipped row(s): documents the ERP consciously did NOT send.`,
    );
  }
  out();

  // ── 3. oldest undelivered ────────────────────────────────────────────────
  //
  // "Undelivered" is three different shapes and they must not be averaged:
  //   pending  — still trying, or waiting for its backoff.
  //   waiting  — pending on a parent that has no AutoCount number. Burns no
  //              attempt, so it can sit forever without ever becoming failed.
  //   failed   — the attempts are spent. Terminal until a human acts.
  out("=".repeat(78));
  out("SECTION 3 — OLDEST UNDELIVERED");
  out("=".repeat(78));
  const oldest = await pg`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int                        AS pending,
      count(*) FILTER (WHERE status = 'failed')::int                         AS failed,
      count(*) FILTER (WHERE status = 'pending'
                         AND first_waiting_at IS NOT NULL)::int              AS waiting,
      min(created_at) FILTER (WHERE status IN ('pending','failed'))          AS oldest_undelivered,
      min(first_waiting_at) FILTER (WHERE status = 'pending')                AS oldest_wait,
      max(attempts) FILTER (WHERE status IN ('pending','failed'))            AS max_attempts
      FROM scm.autocount_outbox`;
  const o = oldest[0];
  out(`  pending ................ ${o.pending}`);
  out(`  of which WAITING on a parent ... ${o.waiting}`);
  out(`  failed ................. ${o.failed}`);
  out(`  oldest undelivered ..... ${ageOf(o.oldest_undelivered) ?? "(none)"}`);
  out(`  longest current wait ... ${ageOf(o.oldest_wait) ?? "(none)"}`);
  out(`  highest attempt count .. ${o.max_attempts ?? 0}`);
  out();
  const undeliveredList = await pg`
    SELECT doc_type, doc_no, op, status, attempts, created_at, first_waiting_at,
           left(coalesce(last_error, ''), 110) AS last_error
      FROM scm.autocount_outbox
     WHERE status IN ('pending', 'failed')
     ORDER BY created_at ASC
     LIMIT ${TOP}`;
  if (undeliveredList.length) {
    out(`  ${pad("doc", 5)}${pad("doc_no", 18)}${pad("op", 12)}${pad("status", 9)}${num("att", 4)}  age / error`);
    for (const r of undeliveredList) {
      out(`  ${pad(r.doc_type, 5)}${pad(r.doc_no, 18)}${pad(r.op, 12)}${pad(r.status, 9)}${num(r.attempts, 4)}  ${ageOf(r.created_at)}`);
      if (r.last_error) out(`  ${" ".repeat(48)}${r.last_error}`);
    }
  } else {
    out("  Nothing undelivered.");
  }
  if (o.failed > 0) {
    escalate("ALARM");
    verdictLines.push(`${o.failed} FAILED row(s): document(s) in the ERP that are NOT in AutoCount.`);
  }
  out();

  // ── 4. is the alarm actually reaching anyone ─────────────────────────────
  //
  // alerted_at is the receipt the drain stamps when it posts the notice. An
  // undeliverable row with a NULL receipt means the alarm pass has not run —
  // which is the alarm itself failing, the one thing no other section catches.
  out("=".repeat(78));
  out("SECTION 4 — ALARM COVERAGE");
  out("=".repeat(78));
  const alarm = await pg`
    SELECT
      count(*) FILTER (WHERE status = 'failed')::int                      AS failed,
      count(*) FILTER (WHERE status = 'failed' AND alerted_at IS NULL)::int AS failed_unalerted,
      count(*) FILTER (WHERE status = 'pending'
                         AND first_waiting_at < now() - interval '6 hours')::int AS stalled,
      count(*) FILTER (WHERE status = 'pending'
                         AND first_waiting_at < now() - interval '6 hours'
                         AND alerted_at IS NULL)::int                     AS stalled_unalerted,
      count(*) FILTER (WHERE alerted_at IS NOT NULL)::int                 AS alerted
      FROM scm.autocount_outbox`;
  const a = alarm[0];
  out(`  failed rows ................... ${a.failed}   (never alarmed: ${a.failed_unalerted})`);
  out(`  stalled > 6h waiting .......... ${a.stalled}   (never alarmed: ${a.stalled_unalerted})`);
  out(`  rows a human has been told about ... ${a.alerted}`);
  const unalerted = a.failed_unalerted + a.stalled_unalerted;
  if (unalerted > 0) {
    // Only meaningful once the drain runs at all; while the flag is off there is
    // nothing to raise an alarm, and saying otherwise would be a false alarm.
    if (flagOn) {
      escalate("ALARM");
      verdictLines.push(
        `${unalerted} undeliverable row(s) with NO alarm raised — the alarm pass is not running.`,
      );
    } else {
      out("  (write-back is OFF, so no sweep has run to raise these. Not a fault.)");
    }
  }
  out();

  // ── 5. the ERP documents that DID reach AutoCount ────────────────────────
  out("=".repeat(78));
  out("SECTION 5 — DOCUMENTS LINKED TO AUTOCOUNT");
  out("=".repeat(78));
  for (const t of DOC_TABLES) {
    const has = await pg`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = ${t.table}
         AND column_name = 'linked_ac_docno'`;
    if (!has[0].n) {
      out(`  ${pad(t.docType, 4)} ${pad(t.table, 20)} NOT CHECKED — no linked_ac_docno column`);
      continue;
    }
    const r = await pg`
      SELECT count(*)::int AS total,
             count(linked_ac_docno)::int AS linked
        FROM scm.${pg(t.table)}`;
    out(`  ${pad(t.docType, 4)} ${pad(t.table, 20)} ${num(r[0].linked, 7)} linked of ${r[0].total}`);
  }
  out();

  // ── 6. ORPHANS — committed documents with no queue row at all ────────────
  //
  // The dual write's blind spot, found from the document side. enqueueAcOp
  // returns a boolean that all 14 call sites discard, and the insert is not in
  // the document's transaction, so a lost enqueue leaves NOTHING behind: no
  // row, no status, no error. The only way to see it is to ask which documents
  // have no row.
  //
  // SCOPED TO THE QUEUE'S OWN LIFETIME, deliberately. Every document older than
  // the first outbox row predates the write-back and is not an orphan — it is
  // history. Reporting 13,000 "orphans" would be a wrong answer, and a wrong
  // answer is worse than a blank.
  out("=".repeat(78));
  out("SECTION 6 — ORPHANS (committed in the ERP, never queued)");
  out("=".repeat(78));
  const firstRow = await pg`
    SELECT min(created_at) AS since FROM scm.autocount_outbox`;
  const since = firstRow[0].since;
  if (!since) {
    out("  SKIPPED — the outbox has never held a row, so there is no point in time");
    out("  from which a document could be called 'missed'. Every ERP document");
    out("  predates the write-back. This section becomes meaningful once the flag");
    out("  is switched on and the first row is queued.");
  } else {
    out(`  Counting documents created since the queue's first row (${since.toISOString()}).`);
    out();
    let orphanTotal = 0;
    for (const t of DOC_TABLES) {
      const cols = await pg`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'scm' AND table_name = ${t.table}
           AND column_name IN ('created_at', 'linked_ac_docno', ${t.noCol})`;
      const have = new Set(cols.map((c) => c.column_name));
      if (!have.has("created_at") || !have.has("linked_ac_docno") || !have.has(t.noCol)) {
        // Reported, never silently dropped: an unchecked table must not read as
        // a clean one.
        out(`  ${pad(t.docType, 4)} ${pad(t.table, 20)} NOT CHECKED — missing one of `
          + `created_at / linked_ac_docno / ${t.noCol}`);
        escalate("ATTENTION");
        verdictLines.push(`${t.table} could not be checked for orphans (column missing).`);
        continue;
      }
      const r = await pg`
        SELECT count(*)::int AS orphans
          FROM scm.${pg(t.table)} d
         WHERE d.created_at >= ${since}
           AND d.linked_ac_docno IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM scm.autocount_outbox o
                  WHERE o.doc_type = ${t.docType}
                    AND o.doc_no = d.${pg(t.noCol)}::text)`;
      const n = r[0].orphans;
      orphanTotal += n;
      out(`  ${pad(t.docType, 4)} ${pad(t.table, 20)} ${num(n, 7)} orphan(s)`);
      if (n > 0) {
        const eg = await pg`
          SELECT d.${pg(t.noCol)}::text AS doc_no, d.created_at
            FROM scm.${pg(t.table)} d
           WHERE d.created_at >= ${since}
             AND d.linked_ac_docno IS NULL
             AND NOT EXISTS (
                   SELECT 1 FROM scm.autocount_outbox o
                    WHERE o.doc_type = ${t.docType}
                      AND o.doc_no = d.${pg(t.noCol)}::text)
           ORDER BY d.created_at DESC
           LIMIT 5`;
        for (const e of eg) out(`  ${" ".repeat(26)}e.g. ${e.doc_no} (${ageOf(e.created_at)} ago)`);
      }
    }
    out();
    if (orphanTotal > 0) {
      escalate("ALARM");
      verdictLines.push(
        `${orphanTotal} ORPHAN document(s): committed in the ERP with no outbox row at all. `
        + `Either the enqueue was lost, or that route was never wired.`,
      );
    } else {
      out("  No orphans. Every document created since the queue started has a row.");
    }
  }
  out();

  // ── VERDICT ──────────────────────────────────────────────────────────────
  out("=".repeat(78));
  if (worst === "OK") {
    notice("VERDICT: OK — every ERP document since the queue started has a row, "
      + "nothing has failed, and nothing is stalled.");
  } else {
    notice(`VERDICT: ${worst}`);
    for (const line of verdictLines) notice(`  - ${line}`);
  }
  if (!flagOn) {
    notice("NOTE: the write-back flag is OFF. Nothing is being pushed to AutoCount at all.");
  }
} catch (e) {
  // Reserved for a broken check, per the repo rule: the ANSWER is never a
  // non-zero exit, only an unreachable or misqueried database is.
  console.error("check-ac-outbox-health FAILED:", e?.message ?? e);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await pg.end({ timeout: 5 });
process.exit(0);
