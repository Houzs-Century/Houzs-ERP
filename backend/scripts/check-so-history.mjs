// Read-only probe: what actually HAPPENED to one Sales Order, in order?
//
// Owner 2026-09-09, relaying Cheah Huan on HC-SO-012312: 「proceed 放日期了 save
// 了，跳出来时 变成没有 date 那些 / 这是我按了第二次才有」. She set the Processing
// Date, saved, the dates came back empty, and only a second attempt stuck.
//
// THREE EXPLANATIONS HAVE ALREADY BEEN REFUTED, which is why this exists:
//   1. the colour-KIV save gate blocked it — refuted: that gate REFUSES with a
//      message naming the line, and she saw no error;
//   2. the refusal reached nobody — refuted: the mobile edit path runs through
//      notifySaveProblems, and the SO detail carries an amber pending banner;
//   3. the dates went out as an amendment awaiting approval — refuted by the
//      owner's own screenshot: no pending banner, and BOTH dates are now set.
//
// So the cause is UNKNOWN and reasoning has produced three wrong answers. The
// only thing left that can settle it is the order's own recorded history, which
// is what this prints — every audit row and every amendment, oldest first, with
// the field-level from/to. If a save wrote the Processing Date, there is a row.
// If an amendment carried it, there is a row. If NEITHER exists for the first
// attempt, that is itself the finding: the first save changed nothing at all.
//
// WHAT IT PRINTS, for the ONE order named in DOC_NO:
//
//   1. Every `mfg_so_audit_log` row: when, who, action, note, and each field
//      change as `field: from -> to`. DATE fields are called out with a marker
//      so the processing/delivery pair is findable in a long timeline.
//   2. Every `so_amendments` row: number, lane, status, when raised, and the
//      header_changes it carried — so an amendment that moved the dates and was
//      later approved is visible even though nothing is pending now.
//   3. A one-line verdict naming which of those two, if either, ever touched
//      the Processing Date.
//
// It reports what is recorded. It does not explain a gap: an audit log with no
// row for the first attempt proves the save wrote nothing, NOT why.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — including "no such order" and "no history", both of which
// are findings — so a red job always means the check itself broke. Manual
// dispatch, own concurrency group, never on a schedule.
//
// RE-RUN: safe and free. It reads and prints; running it twice changes nothing.
//
// Nothing here coerces an enum through `COALESCE(col, '')`. That idiom asks
// Postgres to cast '' into a type with no such member and dies at execution —
// it is what killed the SO-holders probe on its first dispatch
// (docs/bugs/0754 in that series, run 34334122124).
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const note = (s) => console.log(`::notice::${s}`);

/** The two fields this investigation is about, by every spelling they carry.
 *  The audit differ writes camelCase keys; the columns are snake_case. */
const DATE_FIELDS = new Set([
  "processingDate", "processing_date",
  "customerDeliveryDate", "customer_delivery_date",
  "internalExpectedDd", "internal_expected_dd",
]);

const short = (v) => {
  if (v == null) return "(empty)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

async function main() {
  const docNo = (process.env.DOC_NO ?? "").trim();
  if (!docNo) {
    console.error("Set DOC_NO to the Sales Order to inspect, e.g. DOC_NO=HC-SO-012312.");
    process.exit(1);
  }
  const url = resolveUrl();
  if (!url) {
    console.error("No DATABASE_URL (env or backend/.dev.vars). Cannot answer.");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

  try {
    const [h] = await sql`
      SELECT doc_no, status, processing_date, customer_delivery_date, created_at
        FROM scm.mfg_sales_orders
       WHERE doc_no = ${docNo}`;
    if (!h) {
      note(`No Sales Order ${docNo} in this database.`);
      return;
    }
    note(`${docNo} — status ${h.status ?? "-"}, created ${h.created_at ?? "-"}`);
    note(`  NOW: processing_date ${h.processing_date ?? "(empty)"}   delivery_date ${h.customer_delivery_date ?? "(empty)"}`);

    let dateTouchedByAudit = 0;

    const rows = await sql`
      SELECT created_at, action, actor_name_snapshot, note, source,
             status_snapshot, field_changes
        FROM scm.mfg_so_audit_log
       WHERE so_doc_no = ${docNo}
       ORDER BY created_at ASC`;

    note(`---- audit log: ${rows.length} row(s), oldest first ----`);
    if (rows.length === 0) {
      note("  EMPTY. Nothing was ever recorded against this order — including the saves she made.");
    }
    for (const r of rows) {
      note(`  ${r.created_at} ${r.action} by ${r.actor_name_snapshot ?? "(unknown)"} [${r.source ?? "-"}]${r.note ? ` — ${r.note}` : ""}`);
      /* field_changes is jsonb written by the differ as [{field, from, to}]. A
         shape this does not recognise is PRINTED rather than skipped: the row
         that does not parse is exactly the row worth seeing. */
      const changes = Array.isArray(r.field_changes) ? r.field_changes : null;
      if (changes == null) {
        if (r.field_changes != null) note(`      field_changes (unrecognised shape): ${short(r.field_changes)}`);
        continue;
      }
      for (const c of changes) {
        const f = String(c?.field ?? "?");
        const isDate = DATE_FIELDS.has(f);
        if (isDate) dateTouchedByAudit += 1;
        note(`      ${isDate ? ">> " : "   "}${f}: ${short(c?.from)} -> ${short(c?.to)}`);
      }
    }

    const amendments = await sql`
      SELECT amendment_no, lane, status, reason, requested_by,
             created_at, updated_at, header_changes
        FROM scm.so_amendments
       WHERE so_doc_no = ${docNo}
       ORDER BY created_at ASC`;

    note(`---- amendments: ${amendments.length} row(s), oldest first ----`);
    if (amendments.length === 0) {
      note("  NONE. No amendment was ever raised on this order.");
    }
    let dateTouchedByAmendment = 0;
    for (const a of amendments) {
      note(`  ${a.created_at} ${a.amendment_no ?? "(no number)"} lane ${a.lane ?? "-"} status ${a.status ?? "-"} (updated ${a.updated_at ?? "-"})${a.reason ? ` — ${a.reason}` : ""}`);
      const hc = a.header_changes;
      if (hc && typeof hc === "object") {
        for (const [k, v] of Object.entries(hc)) {
          const isDate = DATE_FIELDS.has(k);
          if (isDate) dateTouchedByAmendment += 1;
          note(`      ${isDate ? ">> " : "   "}${k}: ${short(v)}`);
        }
      } else if (hc != null) {
        note(`      header_changes (unrecognised shape): ${short(hc)}`);
      }
    }

    note("---- verdict ----");
    note(`  Processing/Delivery date touched by an AUDIT row: ${dateTouchedByAudit} time(s)`);
    note(`  Processing/Delivery date carried by an AMENDMENT: ${dateTouchedByAmendment} time(s)`);
    if (dateTouchedByAudit === 0 && dateTouchedByAmendment === 0) {
      note("  NEITHER records touching those dates. Whatever set the values above did not go through the header PATCH's audit or the amendment flow — that is the finding to chase next, and this probe does not explain it.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(`check-so-history failed: ${e?.message ?? e}`);
  process.exit(1);
});
