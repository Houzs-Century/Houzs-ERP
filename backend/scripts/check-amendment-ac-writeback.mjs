#!/usr/bin/env node
// check-amendment-ac-writeback — did every APPROVED SO / PO amendment queue its
// AutoCount edit?
//
// WHY IT EXISTS. 2026-09-14: HC-PO-2609-064's PO amendment A1 (approved 01:19
// UTC) and HC-SO-013497/A1 + /A2 (01:09, 01:13) were applied in the ERP, yet
// scm.autocount_outbox held NO row for any of them — not even skipped/failed —
// while the write-back switch was ON (runs 34815098686 / 34814256189). Both
// approve routes call enqueueEdit (so-amendments.ts approveSoCommandHandler,
// po-amendments.ts approvePoAmendmentHandler). This measures how wide that is,
// and separates "amendments never queue" from "these documents never queue".
//
// WHAT IT PRINTS (company COMPANY, since GO_LIVE):
//   0. the write-back switch as stored;
//   1. every SO amendment approved (so_approved_at >= GO_LIVE): its SO, lane,
//      the SO's linked_ac_docno, and the outbox rows for that SO created within
//      WINDOW_MIN minutes either side of the approval (any op, any status) —
//      plus the first outbox row of any kind AFTER the approval;
//   2. the same for every PO amendment approved (approved_at >= GO_LIVE);
//   3. the split of (1) and (2) before / after CUTOFF — the deploy of #3545
//      (7f06b3502, Deploy run 34463750229 finished 2026-09-10T10:07:50Z), the
//      commit that moved bindingsFor's read onto `.filter(col, 'in', ...)`;
//   4. for the same documents, every outbox row since GO_LIVE by op/status,
//      and their audit actions by type — did a NON-amendment save queue?
//   5. company-wide outbox `edit` rows per UTC day by doc_type since GO_LIVE.
//
// The window is two-sided on purpose: outbox.created_at is DEFAULT now(), and
// inside the approve route's transaction now() is the transaction START, which
// precedes the so_approved_at / approved_at the JS stamps later.
//
// READ-ONLY. Plain SELECTs over one connection, no transaction, no DDL, no
// writes. Each section is independent; a failing section prints its error and
// the rest still run. Exit 0 for every answer; exit 1 only when the database
// cannot be reached.
//
// RE-RUN: read-only and idempotent; every run re-reads the live rows.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const GO_LIVE = String(process.env.GO_LIVE || "2026-09-07");
const CUTOFF = String(process.env.CUTOFF || "2026-09-10T10:07:50Z");
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 2);
const SAMPLE = Number(process.env.SAMPLE || 400);

const out = (m = "") => console.log(m);
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? "-" : String(v));

async function section(title, fn) {
  out("");
  out(`==== ${title} ====`);
  try { await fn(); } catch (e) { out(`!! section failed: ${e?.message ?? e}`); }
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
try {
  await sql`SELECT 1`;
} catch (e) {
  console.error(`::error::cannot reach the database: ${e?.message ?? e}`);
  process.exit(1);
}

out(`company=${CO} go_live=${GO_LIVE} cutoff=${CUTOFF} window=±${WINDOW_MIN}min`);

const tally = { SO: [], PO: [] };
const soDocs = new Set();
const poIds = new Set();

function summarise(kind) {
  const rows = tally[kind];
  const cut = Date.parse(CUTOFF);
  const before = rows.filter((r) => r.at < cut);
  const after = rows.filter((r) => r.at >= cut);
  const n = (xs, f) => xs.filter(f).length;
  out(`${kind} amendments approved: ${rows.length}`);
  out(`   with an outbox row in the window: ${n(rows, (r) => r.windowRows > 0)}   with an EDIT row in the window: ${n(rows, (r) => r.windowEdit > 0)}`);
  out(`   BEFORE cutoff: ${before.length} approved, ${n(before, (r) => r.windowRows > 0)} with a window row (${n(before, (r) => r.windowEdit > 0)} edit)`);
  out(`   AFTER  cutoff: ${after.length} approved, ${n(after, (r) => r.windowRows > 0)} with a window row (${n(after, (r) => r.windowEdit > 0)} edit)`);
  out(`   documents with NO linked_ac_docno: ${n(rows, (r) => !r.linked)}   AFTER cutoff, linked, and NO window row: ${n(after, (r) => r.linked && r.windowRows === 0)}`);
}

try {
  await section("0. WRITE-BACK SWITCH", async () => {
    const rows = await sql`SELECT key, value, updated_at FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
    if (!rows.length) out("(no row — reads as OFF)");
    for (const r of rows) out(`${r.key} = ${JSON.stringify(r.value)}  updated_at=${iso(r.updated_at)}`);
  });

  await section(`1. SO AMENDMENTS approved since ${GO_LIVE}`, async () => {
    const rows = await sql`
      SELECT a.id, a.amendment_no, a.so_doc_no, a.lane, a.status, a.so_approved_at,
             h.linked_ac_docno,
             (SELECT count(*)::int FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.doc_no = a.so_doc_no
                 AND o.created_at BETWEEN a.so_approved_at - make_interval(mins => ${WINDOW_MIN}::int)
                                      AND a.so_approved_at + make_interval(mins => ${WINDOW_MIN}::int)) AS window_rows,
             (SELECT count(*)::int FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.doc_no = a.so_doc_no AND o.op = 'edit'
                 AND o.created_at BETWEEN a.so_approved_at - make_interval(mins => ${WINDOW_MIN}::int)
                                      AND a.so_approved_at + make_interval(mins => ${WINDOW_MIN}::int)) AS window_edit,
             (SELECT o.op || '/' || o.status || '@' || to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.doc_no = a.so_doc_no
                 AND o.created_at > a.so_approved_at
               ORDER BY o.created_at LIMIT 1) AS first_after
        FROM scm.so_amendments a
        LEFT JOIN scm.mfg_sales_orders h ON h.doc_no = a.so_doc_no AND h.company_id = a.company_id
       WHERE a.company_id = ${CO} AND a.so_approved_at >= ${GO_LIVE}::date
       ORDER BY a.so_approved_at`;
    let shown = 0;
    for (const r of rows) {
      soDocs.add(r.so_doc_no);
      tally.SO.push({ at: new Date(r.so_approved_at).getTime(), windowRows: r.window_rows, windowEdit: r.window_edit, linked: !!r.linked_ac_docno });
      if (shown++ < SAMPLE) {
        out(`${iso(r.so_approved_at)}  ${r.amendment_no ?? r.id}  lane=${r.lane ?? "legacy"}  status=${r.status}  ac=${r.linked_ac_docno ?? "-"}  ` +
          `window_rows=${r.window_rows} window_edit=${r.window_edit}  first_after=${r.first_after ?? "-"}`);
      }
    }
    if (!rows.length) out("(none)");
  });

  await section(`2. PO AMENDMENTS approved since ${GO_LIVE}`, async () => {
    const rows = await sql`
      SELECT a.id, a.amendment_no, a.po_number, a.po_id, a.status, a.approved_at,
             (a.source_so_amendment_id IS NOT NULL) AS follow_up,
             p.linked_ac_docno, p.revision,
             (SELECT count(*)::int FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'PO'
                 AND (o.doc_id = a.po_id::text OR o.doc_no = a.po_number)
                 AND o.created_at BETWEEN a.approved_at - make_interval(mins => ${WINDOW_MIN}::int)
                                      AND a.approved_at + make_interval(mins => ${WINDOW_MIN}::int)) AS window_rows,
             (SELECT count(*)::int FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'PO' AND o.op = 'edit'
                 AND (o.doc_id = a.po_id::text OR o.doc_no = a.po_number)
                 AND o.created_at BETWEEN a.approved_at - make_interval(mins => ${WINDOW_MIN}::int)
                                      AND a.approved_at + make_interval(mins => ${WINDOW_MIN}::int)) AS window_edit,
             (SELECT o.op || '/' || o.status || '@' || to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'PO'
                 AND (o.doc_id = a.po_id::text OR o.doc_no = a.po_number)
                 AND o.created_at > a.approved_at
               ORDER BY o.created_at LIMIT 1) AS first_after
        FROM scm.po_amendments a
        LEFT JOIN scm.purchase_orders p ON p.id = a.po_id
       WHERE a.company_id = ${CO} AND a.status = 'APPROVED' AND a.approved_at >= ${GO_LIVE}::date
       ORDER BY a.approved_at`;
    let shown = 0;
    for (const r of rows) {
      poIds.add(String(r.po_id));
      tally.PO.push({ at: new Date(r.approved_at).getTime(), windowRows: r.window_rows, windowEdit: r.window_edit, linked: !!r.linked_ac_docno });
      if (shown++ < SAMPLE) {
        out(`${iso(r.approved_at)}  ${r.amendment_no ?? r.id}  ${r.follow_up ? "follow-up" : "manual"}  rev=${r.revision ?? "?"}  ac=${r.linked_ac_docno ?? "-"}  ` +
          `window_rows=${r.window_rows} window_edit=${r.window_edit}  first_after=${r.first_after ?? "-"}`);
      }
    }
    if (!rows.length) out("(none)");
  });

  await section("3. SUMMARY — before / after the cutoff", async () => {
    summarise("SO");
    summarise("PO");
  });

  await section("4a. OUTBOX rows since go-live for those documents, by op/status/edit-before-or-after cutoff", async () => {
    const docs = [...soDocs];
    const ids = [...poIds];
    const rows = await sql`
      SELECT o.doc_type, o.op, o.status, (o.created_at >= ${CUTOFF}::timestamptz) AS after_cutoff,
             count(*)::int AS n, count(DISTINCT coalesce(o.doc_id, o.doc_no))::int AS docs
        FROM scm.autocount_outbox o
       WHERE o.company_id = ${CO} AND o.created_at >= ${GO_LIVE}::date
         AND ((o.doc_type = 'SO' AND o.doc_no = ANY(${docs}::text[]))
           OR (o.doc_type = 'PO' AND (o.doc_id = ANY(${ids}::text[]) OR o.doc_no IN (
                 SELECT po_number FROM scm.purchase_orders WHERE id::text = ANY(${ids}::text[])))))
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`;
    if (!rows.length) out("(none)");
    for (const r of rows) out(`${r.doc_type} ${r.op}/${r.status} ${r.after_cutoff ? "AFTER " : "BEFORE"} cutoff: ${r.n} rows over ${r.docs} docs`);
  });

  await section("4b. AUDIT actions since go-live on those documents (non-amendment saves show here)", async () => {
    const docs = [...soDocs];
    const rows = await sql`
      SELECT e.entity_type, e.action, (e.created_at >= ${CUTOFF}::timestamptz) AS after_cutoff,
             count(*)::int AS n, count(DISTINCT e.entity_doc_no)::int AS docs
        FROM scm.entity_audit_log e
       WHERE e.created_at >= ${GO_LIVE}::date
         AND (e.entity_doc_no = ANY(${docs}::text[]) OR e.entity_id = ANY(${[...poIds]}::text[]))
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    if (!rows.length) out("(none in scm.entity_audit_log)");
    for (const r of rows) out(`${r.entity_type} ${r.action} ${r.after_cutoff ? "AFTER " : "BEFORE"}: ${r.n} rows over ${r.docs} docs`);
  });

  await section("4c. Per document AFTER the cutoff: direct (non-amendment) outbox edits vs amendment approvals", async () => {
    const docs = [...soDocs];
    const rows = await sql`
      SELECT a.so_doc_no,
             count(DISTINCT a.id)::int AS approvals_after,
             (SELECT count(*)::int FROM scm.autocount_outbox o
               WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.doc_no = a.so_doc_no
                 AND o.op = 'edit' AND o.created_at >= ${CUTOFF}::timestamptz) AS edits_after
        FROM scm.so_amendments a
       WHERE a.company_id = ${CO} AND a.so_doc_no = ANY(${docs}::text[]) AND a.so_approved_at >= ${CUTOFF}::timestamptz
       GROUP BY a.so_doc_no ORDER BY a.so_doc_no`;
    const withEdits = rows.filter((r) => r.edits_after > 0).length;
    out(`SOs with an approval after cutoff: ${rows.length}; of those, SOs that DID get some outbox edit after cutoff: ${withEdits}`);
    for (const r of rows.slice(0, SAMPLE)) out(`${r.so_doc_no}  approvals_after=${r.approvals_after}  edits_after=${r.edits_after}`);
  });

  await section(`5. COMPANY-WIDE outbox rows since ${GO_LIVE} per UTC day, doc_type, op`, async () => {
    const rows = await sql`
      SELECT to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, o.doc_type, o.op, count(*)::int AS n
        FROM scm.autocount_outbox o
       WHERE o.company_id = ${CO} AND o.created_at >= ${GO_LIVE}::date
         AND o.doc_type IN ('SO', 'PO')
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    for (const r of rows) out(`${r.day} ${r.doc_type} ${r.op}: ${r.n}`);
  });
} finally {
  await sql.end({ timeout: 5 });
}
