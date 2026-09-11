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
 *  The audit differ writes camelCase keys; the columns are snake_case.
 *
 *  The pre-mig-0286 spelling of the Processing Date is NOT here: it is a retired
 *  vocabulary term and `audit:vocabulary` refuses it in code, correctly. That
 *  narrows this marker to rows written since the rename — which is every row
 *  this investigation is about, since the saves in question are from 2026-09.
 *  An audit row older than the rename would still be PRINTED in full; it would
 *  simply not carry the `>>` marker, so nothing is hidden, only unhighlighted. */
const DATE_FIELDS = new Set([
  "processingDate", "processing_date",
  "customerDeliveryDate", "customer_delivery_date",
]);

/** Fields whose ANSWER lives past the 60th character, so truncating them hides
 *  the very difference the row was printed for.
 *
 *  `buildVariantSummary` puts the SPECIAL segment LAST — "PC151-01 / DIVAN 10\"
 *  + NO LEG / GAP 14\" / T.Heights 24\" / SPECIAL: ..." — and everything before
 *  it is fabric and dimensions that rarely move. On HC-SO-012312 the two
 *  amendments applied on 2026-09-10 printed as
 *  `line_HILTON (A)-(Q)_spec: PC151-01 / DIVAN 10" + NO LEG / GAP...  ->
 *   PC151-01 / DIVAN 10" + NO LEG / GAP...`, identical on both sides and
 *  therefore useless: whether the amendment removed "Right Drawer" is decided
 *  entirely in the characters that were cut off. A trail that cannot show what
 *  changed is not a trail.
 *
 *  Matched on the field name rather than the value's length so the widening is a
 *  DECISION about which fields carry a tail, not a blanket "print everything" —
 *  this goes into a CI log, and a jsonb blob of custom specials or an address
 *  has no business being dumped whole. */
const LONG_TAIL_FIELDS = /(^|_)(spec|specs|description2|variantSummary)$/i;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

const short = (v, field) => {
  if (v == null) return "(empty)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return clip(s, field && LONG_TAIL_FIELDS.test(field) ? 400 : 60);
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
        note(`      ${isDate ? ">> " : "   "}${f}: ${short(c?.from, f)} -> ${short(c?.to, f)}`);
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
          note(`      ${isDate ? ">> " : "   "}${k}: ${short(v, k)}`);
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
