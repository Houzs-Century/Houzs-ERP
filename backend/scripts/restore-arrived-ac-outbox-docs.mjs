#!/usr/bin/env node
/* restore-arrived-ac-outbox-docs — put back on the AutoCount Sync list the
 * cleared documents that have since reached AutoCount.
 *
 * 白话. 页面上的「已清除」本来只放做完的单。9 月 10 日一个脚本把还没进 AutoCount 的单也清掉了，
 * 那些单后来都进去了，页面却还把它们放在「已清除」，看起来像没进。这个脚本把「脚本清掉、
 * 后来确实进了 AutoCount」的单放回正常列表（它们会显示为已进 AutoCount）；
 * 人手在页面上清的单不动；还没进的单不动，只列出来。
 *
 * ── WHY (docs/bugs/0917) ───────────────────────────────────────────────────
 * `archive-ac-outbox-docs.mjs` archived by document number with no verdict, and
 * on 2026-09-10 it cleared documents whose refusal was still open. The page's
 * own archive refuses exactly that (`acArchiveVerdict`). Those documents were
 * sent later, under new rows the page shows as live, while their old refusals
 * stayed on the CLEARED shelf with a refused badge, so the owner read
 * 「已清除 22」 as 22 documents not in AutoCount. On 2026-09-15, 21 of them were
 * in the book.
 *
 * Six of the cleared refusals were filed under the ROW ID of a delivery order or
 * purchase order instead of its number (docs/bugs/0774), so the page could never
 * join them to the document's later arrival. Those rows are re-filed under the
 * number before they are restored, and the plan names each re-filing.
 *
 * ── THE JUDGEMENT ──────────────────────────────────────────────────────────
 * `lib/cleared-arrived-plan.mjs`, which imports the page's own
 * `acOutboxState` and `acRefusalPredatesArrival`. A document is restored only
 * when all of these hold:
 *   - a script cleared it (`archived_by` is NULL — the page stamps the person);
 *   - nothing of it is still waiting to send;
 *   - it has arrived, and its newest refusal predates its newest arrival.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan and writes nothing. Apply needs CONFIRM. One
 * transaction; every UPDATE names rows by id and re-asserts what the plan saw
 * (still cleared, still cleared by no person, still filed under the old
 * number), and a mismatch rolls the whole run back. `status` and `last_error`
 * are never written. A FRESH connection then re-reads every row and asserts
 * the SHAPE: not cleared, filed under the planned number, and each restored
 * document reading as NOT needing attention by the page's own rule.
 *
 * REVERSAL: set `archived_at` back on the listed row ids; set `doc_no` back to
 * the `from` value the plan printed for each re-filed row.
 *
 * RE-RUN: a second apply finds none of those rows cleared, plans nothing and
 * writes nothing.
 *
 * NAMED DOCUMENTS. DOC_NOS names documents a PERSON cleared that should come
 * back as well (the owner, 2026-09-15, on the last three: 「还有3张」). They are
 * judged exactly like the rest and restored only once they have arrived.
 *
 * Env: DATABASE_URL (required)  MODE=plan|apply (default plan)
 *      CONFIRM (apply)  COMPANY_ID (default 1)  DOC_NOS (optional, comma separated)
 */
import postgres from "postgres";
import { acOutboxState, acRefusalPredatesArrival } from "../src/scm/lib/autocount-outbox-status.ts";
import { planClearedArrivals } from "./lib/cleared-arrived-plan.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").trim().toLowerCase() === "apply";
const CONFIRM_PHRASE = "put the cleared documents that reached AutoCount back on the list";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const NAMED = new Set((process.env.DOC_NOS || "").split(",").map((s) => s.trim()).filter(Boolean));
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const ID_TABLES = {
  PO: { table: "purchase_orders", number: "po_number" },
  DO: { table: "delivery_orders", number: "do_number" },
  GR: { table: "grns", number: "grn_number" },
  IV: { table: "sales_invoices", number: "invoice_number" },
  PI: { table: "purchase_invoices", number: "invoice_number" },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_COLS = (sql) => sql`id::text AS id, doc_type, doc_no, status, left(coalesce(last_error, ''), 40) AS error_head,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  archived_at::text AS archived_at, archived_by`;

async function readPlan(sql) {
  const cleared = await sql`SELECT DISTINCT doc_type, doc_no FROM scm.autocount_outbox WHERE company_id = ${CO} AND archived_at IS NOT NULL`;
  const numberOfId = new Map();
  for (const [type, spec] of Object.entries(ID_TABLES)) {
    const ids = cleared.filter((c) => c.doc_type === type && UUID.test(c.doc_no)).map((c) => c.doc_no.toLowerCase());
    if (!ids.length) continue;
    const found = await sql`SELECT id::text AS id, ${sql(spec.number)} AS number FROM ${sql("scm." + spec.table)} WHERE company_id = ${CO} AND id::text IN ${sql(ids)}`;
    for (const f of found) numberOfId.set(`${type}|${f.id.toLowerCase()}`, f.number);
  }
  const names = [...new Set([...cleared.map((c) => c.doc_no), ...numberOfId.values()])];
  const rows = names.length
    ? await sql`SELECT ${ROW_COLS(sql)} FROM scm.autocount_outbox WHERE company_id = ${CO} AND doc_no IN ${sql(names)}`
    : [];
  return { plan: planClearedArrivals([...rows], numberOfId, NAMED), clearedDocs: cleared.length };
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const { plan, clearedDocs } = await readPlan(sql);
notice(`${APPLY ? "APPLY" : "PLAN"}: ${clearedDocs} cleared document key(s); ${plan.restore.length} reached AutoCount and go back on the list; ${plan.held.length} stay cleared`);
for (const r of plan.restore) {
  console.log(`  restore: ${r.docType} ${r.docNo} — ${r.rowIds.length} row(s)${r.refile.length ? `; re-filed from ${[...new Set(r.refile.map((f) => f.from))].join(", ")}` : ""}`);
}
for (const h of plan.held) console.log(`  stays cleared: ${h.docType} ${h.docNo} — ${h.reason}`);

if (!APPLY) {
  notice(`PLAN: nothing written. Apply with MODE=apply CONFIRM='${CONFIRM_PHRASE}'`);
  await sql.end();
  process.exit(0);
}
if (!plan.restore.length) { notice("APPLY: nothing to restore."); await sql.end(); process.exit(0); }

try {
  await sql.begin(async (tx) => {
    for (const r of plan.restore) {
      for (const f of r.refile) {
        const res = await tx`UPDATE scm.autocount_outbox SET doc_no = ${f.to}
                              WHERE id = ${f.id} AND company_id = ${CO} AND doc_no = ${f.from} AND archived_at IS NOT NULL
                                AND (archived_by IS NULL OR ${NAMED.has(r.docNo)})`;
        if (res.count !== 1) throw new Error(`row ${f.id} (${r.docType} ${r.docNo}) moved since the plan: re-filing matched ${res.count}`);
      }
      const res = await tx`UPDATE scm.autocount_outbox SET archived_at = NULL, archived_by = NULL
                            WHERE id::text IN ${tx(r.rowIds)} AND company_id = ${CO} AND archived_at IS NOT NULL
                              AND (archived_by IS NULL OR ${NAMED.has(r.docNo)})`;
      if (res.count !== r.rowIds.length) throw new Error(`${r.docType} ${r.docNo} moved since the plan: restored ${res.count} of ${r.rowIds.length}`);
    }
  });
} catch (e) {
  console.error(`APPLY rolled back: ${e.message}`);
  await sql.end();
  process.exit(1);
}
await sql.end();

/* A fresh connection, and the SHAPE: every planned row live and filed under its
   document's number, and every restored document reading, by the page's own
   rule over its live rows, as not needing attention. */
const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const ids = plan.restore.flatMap((r) => r.rowIds);
const back = await verify`SELECT id::text AS id, doc_no, archived_at FROM scm.autocount_outbox WHERE id::text IN ${verify(ids)}`;
const live = await verify`SELECT ${ROW_COLS(verify)} FROM scm.autocount_outbox
                            WHERE company_id = ${CO} AND archived_at IS NULL AND doc_no IN ${verify([...new Set(plan.restore.map((r) => r.docNo))])}`;
await verify.end();
const byId = new Map(back.map((b) => [b.id, b]));
const failures = [];
for (const r of plan.restore) {
  for (const id of r.rowIds) {
    const b = byId.get(id);
    if (!b) failures.push(`${r.docType} ${r.docNo}: row ${id} not found`);
    else if (b.archived_at !== null) failures.push(`${r.docType} ${r.docNo}: row ${id} is still cleared`);
    else if (b.doc_no !== r.docNo) failures.push(`${r.docType} ${r.docNo}: row ${id} is filed under ${b.doc_no}`);
  }
  let arrived = null;
  let refused = null;
  for (const x of live.filter((l) => l.doc_type === r.docType && l.doc_no === r.docNo)) {
    const state = acOutboxState(String(x.status), x.error_head);
    if (state === "sent" && (!arrived || x.created_at > arrived)) arrived = x.created_at;
    if ((state === "failed" || state === "skipped") && (!refused || x.created_at > refused)) refused = x.created_at;
  }
  if (refused && !acRefusalPredatesArrival(refused, arrived)) failures.push(`${r.docType} ${r.docNo}: the page would list it as not accepted`);
}
if (failures.length) {
  console.error(`verify FAILED on a fresh connection: ${failures.join("; ")}`);
  process.exit(1);
}
notice(`APPLIED: ${plan.restore.length} document(s), ${ids.length} row(s) back on the list, ${plan.restore.reduce((s, r) => s + r.refile.length, 0)} re-filed under their number; each re-read on a fresh connection and none needs attention.`);
