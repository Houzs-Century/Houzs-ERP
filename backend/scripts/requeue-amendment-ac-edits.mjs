#!/usr/bin/env node
// ----------------------------------------------------------------------------
// RE-QUEUE THE AUTOCOUNT EDITS THAT APPROVED AMENDMENTS NEVER QUEUED — 0888.
//
// WHY. From the deploy of #3545 (2026-09-10T10:07:50Z) until the fix in
// docs/bugs/0888, every SO / PO amendment approve ran enqueueEdit through the
// transaction client, whose filter() threw on `in`; the error was dropped and
// NOTHING was queued — no row, not even skipped. Measured on production (run
// 34819514473): 0 of 32 SO and 0 of 15 PO amendments approved after the cutoff
// queued an edit, against 12/12 and 9/9 before it. AutoCount still holds those
// documents as they were before the amendment (HC-PO-2609-064 still carries
// 5536-L(LHF), 5536-1NA x2, 5536-1A(RHF)).
//
// WHAT IT DOES. For each affected document it calls the SAME `enqueueEdit` the
// approve routes call — a KEYED edit of the document AS IT IS NOW. One edit per
// DOCUMENT, not per amendment: an edit composes the whole current state, so the
// last one carries every amendment before it.
//
// TARGETS (company COMPANY_ID): documents with an SO amendment (so_approved_at)
// or an APPROVED PO amendment (approved_at) at or after SINCE, MINUS documents
// that already have an `edit` row in `pending` or `sent` created AFTER their
// latest such approval — a later ordinary save already carried the state —
// MINUS cancelled documents. Override with DOC_NOS="HC-SO-x,HC-PO-y".
//
// MODE: plan unless MODE=apply. The plan is not a prediction: each document is
// composed by the real enqueueEdit inside its own transaction, the row it would
// write is read back, and the transaction is ROLLED BACK. A composer refusal
// shows as the `skipped` row it would have written, verbatim.
// CONFIRM: MODE=apply needs CONFIRM="REQUEUE AMENDMENT EDITS".
// VERIFY: after apply, a FRESH connection re-reads every row this run wrote and
// asserts its shape (op edit, status pending or skipped, payload.body an object,
// a pending row's Lines a non-empty array, selfDoc naming the document).
// RE-RUN: a second run finds the pending edits the first one wrote (created
// after the latest approval), so those documents drop out of TARGETS and it plans
// nothing for them. Documents the composer refused are planned again — and
// refused again — until their cause is fixed; each apply adds one more skipped
// row for those, so re-run apply only after fixing the refusal.
//
// Run: npx tsx scripts/requeue-amendment-ac-edits.mjs                     (plan)
//      MODE=apply CONFIRM="REQUEUE AMENDMENT EDITS" npx tsx scripts/requeue-amendment-ac-edits.mjs
// ----------------------------------------------------------------------------
import postgres from "postgres";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";
import { resetWritebackFlagCache } from "../src/scm/lib/autocount-writeback-flag.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "REQUEUE AMENDMENT EDITS";
const COMPANY_ID = Number(process.env.COMPANY_ID || "1");
const SINCE = String(process.env.SINCE || "2026-09-10T10:07:50Z");
const DOC_NOS = (process.env.DOC_NOS || "").split(",").map((s) => s.trim()).filter(Boolean);

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${JSON.stringify(CONFIRM_PHRASE)}. Got ${JSON.stringify(CONFIRM)}.`);
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

class PlanRollback extends Error {
  constructor(rows) { super("plan: rolled back"); this.rows = rows; }
}

async function targets() {
  const rows = await pg`
    WITH appr AS (
      SELECT 'SO'::text AS doc_type, a.so_doc_no AS doc_no, NULL::text AS doc_id,
             a.amendment_no, a.so_approved_at AS approved_at
        FROM scm.so_amendments a
       WHERE a.company_id = ${COMPANY_ID} AND a.so_approved_at >= ${SINCE}::timestamptz
      UNION ALL
      SELECT 'PO', a.po_number, a.po_id::text, a.amendment_no, a.approved_at
        FROM scm.po_amendments a
       WHERE a.company_id = ${COMPANY_ID} AND a.status = 'APPROVED' AND a.approved_at >= ${SINCE}::timestamptz
    ), per_doc AS (
      SELECT doc_type, doc_no, max(doc_id) AS doc_id, max(approved_at) AS last_approved_at,
             string_agg(amendment_no, ' ' ORDER BY approved_at) AS amendments
        FROM appr GROUP BY doc_type, doc_no
    )
    SELECT d.*,
           CASE WHEN d.doc_type = 'SO'
                THEN (SELECT h.status::text FROM scm.mfg_sales_orders h WHERE h.doc_no = d.doc_no AND h.company_id = ${COMPANY_ID})
                ELSE (SELECT p.status::text FROM scm.purchase_orders p WHERE p.id::text = d.doc_id) END AS doc_status,
           CASE WHEN d.doc_type = 'SO'
                THEN (SELECT h.linked_ac_docno FROM scm.mfg_sales_orders h WHERE h.doc_no = d.doc_no AND h.company_id = ${COMPANY_ID})
                ELSE (SELECT p.linked_ac_docno FROM scm.purchase_orders p WHERE p.id::text = d.doc_id) END AS linked_ac_docno,
           (SELECT o.status || '@' || to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              FROM scm.autocount_outbox o
             WHERE o.company_id = ${COMPANY_ID} AND o.doc_type = d.doc_type AND o.op = 'edit'
               AND o.status IN ('pending', 'sent')
               AND (o.doc_no = d.doc_no OR (d.doc_id IS NOT NULL AND o.doc_id = d.doc_id))
               AND o.created_at > d.last_approved_at
             ORDER BY o.created_at DESC LIMIT 1) AS covered_by
      FROM per_doc d
     ORDER BY d.last_approved_at`;
  return DOC_NOS.length ? rows.filter((r) => DOC_NOS.includes(r.doc_no)) : rows;
}

/* One document, one transaction. The rows enqueueEdit wrote are read back on the
   SAME transaction (the only place they exist in plan mode), then the
   transaction is rolled back in plan and committed in apply. */
async function composeOne(t) {
  const run = async (tx) => {
    resetWritebackFlagCache();
    const sb = pgrestShim(tx, "scm", { writeback: "enqueue" });
    const returned = await enqueueEdit(sb, {
      companyId: COMPANY_ID,
      docType: t.doc_type,
      docNo: t.doc_no,
      docId: t.doc_type === "PO" ? t.doc_id : null,
      createdBy: null,
    });
    const written = await tx`
      SELECT id, op, status, last_error, doc_no, doc_id,
             jsonb_typeof(payload->'body') AS body_type,
             jsonb_typeof(payload->'body'->'Lines') AS lines_type,
             CASE WHEN jsonb_typeof(payload->'body'->'Lines') = 'array'
                  THEN jsonb_array_length(payload->'body'->'Lines') END AS line_count,
             payload->'selfDoc' AS self_doc
        FROM scm.autocount_outbox
       WHERE company_id = ${COMPANY_ID} AND doc_type = ${t.doc_type}
         AND (doc_no = ${t.doc_no} OR (${t.doc_id}::text IS NOT NULL AND doc_id = ${t.doc_id}::text))
         AND created_at >= now()`;
    return { returned, written: [...written] };
  };
  if (APPLY) return pg.begin(run);
  try {
    await pg.begin(async (tx) => { throw new PlanRollback(await run(tx)); });
  } catch (e) {
    if (e instanceof PlanRollback) return e.rows;
    throw e;
  }
  throw new Error("plan transaction was not rolled back");
}

async function main() {
  notice(`mode=${APPLY ? "APPLY" : "PLAN (rolled back)"} company=${COMPANY_ID} since=${SINCE}${DOC_NOS.length ? ` doc_nos=${DOC_NOS.join(",")}` : ""}`);
  const all = await targets();
  const covered = all.filter((r) => r.covered_by);
  const cancelled = all.filter((r) => !r.covered_by && String(r.doc_status ?? "").toUpperCase() === "CANCELLED");
  const todo = all.filter((r) => !r.covered_by && String(r.doc_status ?? "").toUpperCase() !== "CANCELLED");

  notice(`documents with an approved amendment since the cutoff: ${all.length} (SO ${all.filter((r) => r.doc_type === "SO").length}, PO ${all.filter((r) => r.doc_type === "PO").length})`);
  notice(`already carried by a LATER pending/sent edit: ${covered.length}`);
  for (const r of covered) console.log(`   covered  ${r.doc_type} ${r.doc_no}  [${r.amendments}]  last approved ${r.last_approved_at.toISOString()}  by edit ${r.covered_by}`);
  if (cancelled.length) notice(`cancelled since, excluded: ${cancelled.map((r) => r.doc_no).join(", ")}`);
  notice(`to requeue: ${todo.length} (SO ${todo.filter((r) => r.doc_type === "SO").length}, PO ${todo.filter((r) => r.doc_type === "PO").length})`);

  const outcomes = [];
  for (const t of todo) {
    let res;
    try {
      res = await composeOne(t);
    } catch (e) {
      outcomes.push({ t, kind: "error", detail: e?.message ?? String(e) });
      warn(`${t.doc_type} ${t.doc_no}: ERROR ${e?.message ?? e}`);
      continue;
    }
    const pending = res.written.find((w) => w.op === "edit" && w.status === "pending");
    const skipped = res.written.find((w) => w.status === "skipped");
    const kind = pending ? "edit" : skipped ? "refused" : "nothing";
    const detail = pending
      ? `${pending.line_count ?? "?"} line(s)`
      : skipped ? skipped.last_error : `enqueueEdit returned ${res.returned} and wrote no row`;
    outcomes.push({ t, kind, detail, ids: res.written.map((w) => w.id) });
    console.log(`   ${kind.padEnd(8)} ${t.doc_type} ${t.doc_no}  ac=${t.linked_ac_docno ?? "-"}  status=${t.doc_status ?? "?"}  [${t.amendments}]  last approved ${t.last_approved_at.toISOString()}  -> ${detail}`);
  }
  const count = (k) => outcomes.filter((o) => o.kind === k).length;
  notice(`${APPLY ? "QUEUED" : "WOULD QUEUE"}: ${count("edit")} edit(s); composer refusals: ${count("refused")}; no row: ${count("nothing")}; errors: ${count("error")}`);

  if (!APPLY) {
    notice(`PLAN only — every transaction was rolled back. Re-run with MODE=apply CONFIRM=${JSON.stringify(CONFIRM_PHRASE)} to queue.`);
    return 0;
  }

  /* VERIFY on a FRESH connection — the session that wrote is the worst witness
     that the write landed. Assert the shape of every row this run wrote. */
  const ids = outcomes.flatMap((o) => o.ids ?? []);
  const verify = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  try {
    const rows = ids.length ? await verify`
      SELECT id, op, status, doc_type, doc_no,
             jsonb_typeof(payload->'body') AS body_type,
             jsonb_typeof(payload->'body'->'Lines') AS lines_type,
             CASE WHEN jsonb_typeof(payload->'body'->'Lines') = 'array'
                  THEN jsonb_array_length(payload->'body'->'Lines') END AS line_count,
             payload->'selfDoc'->>'table' AS self_table
        FROM scm.autocount_outbox WHERE id = ANY(${ids}::uuid[])` : [];
    const bad = [];
    if (rows.length !== ids.length) bad.push(`expected ${ids.length} row(s), re-read ${rows.length}`);
    for (const r of rows) {
      const shapeOk = r.op === "edit" && r.body_type === "object" && (
        r.status === "skipped"
        || (r.status === "pending" && r.lines_type === "array" && Number(r.line_count) > 0
          && r.self_table === (r.doc_type === "SO" ? "mfg_sales_orders" : "purchase_orders")));
      if (!shapeOk) bad.push(`${r.doc_type} ${r.doc_no} row ${r.id}: ${JSON.stringify(r)}`);
    }
    if (bad.length) {
      console.error(`::error::VERIFY FAILED on a fresh connection:\n${bad.join("\n")}`);
      return 1;
    }
    notice(`VERIFIED on a fresh connection: ${rows.length} row(s) carry the expected shape; the outbox drain sends the pending ones.`);
  } finally {
    await verify.end({ timeout: 5 });
  }
  return 0;
}

main().then((c) => pg.end({ timeout: 5 }).then(() => process.exit(c ?? 0)))
  .catch((e) => { console.error(e); return pg.end({ timeout: 5 }).then(() => process.exit(1)); });
