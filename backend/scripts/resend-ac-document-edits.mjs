#!/usr/bin/env node
/* resend-ac-document-edits — send named documents to AutoCount again, as they
 * are in the ERP now.
 *
 * 白话. 有些单已经在 AutoCount 里，但里面的数量或价钱跟 ERP 不一样（例如之前行对调送进去的采购单），
 * 或者上一次修改被 AutoCount 拒收、原因已经修好了。这个脚本按单号，用系统自己的送单程序，
 * 把 ERP 现在的样子重新送一次修改过去。先预演（不送），确认后才真的送。
 *
 * ── WHY (docs/bugs/0903) ───────────────────────────────────────────────────
 * Nothing else sends a document's current state by name. The re-queue ladder
 * takes no edits ("fix the cause, save the document again", autocount-requeue.ts);
 * requeue-amendment-ac-edits.mjs sends only documents with an approved
 * amendment; requeue-keyed-conversion-edits.mjs only DO / GR edits refused for a
 * keyless line; rebuild-ac-document.mjs clears the document's lines, which a
 * transferred document refuses. Purchase orders sent with their lines' values
 * swapped (0889), and sales orders whose refusal has since been fixed (a
 * photograph too large, 0899; a line moved to another delivery order, 0902),
 * could only be corrected by someone opening and saving each one.
 *
 * ── WHAT IT CALLS ──────────────────────────────────────────────────────────
 * The Worker's own `enqueueEdit`, under `tsx` over `pgrest-shim`: a KEYED edit
 * composed from the document as it is now, with every guard the save route has.
 * A composer refusal (a keyless line, a sofa it cannot spell) is written as the
 * route would write it and reported verbatim. No rebuild is ever asked for.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * DOC_NOS is required: this sends the documents it is given, never a sweep.
 * MODE defaults to plan, and the plan is not a prediction: each document is
 * composed inside its own transaction, the row it wrote is read back, and the
 * transaction is ROLLED BACK. MODE=apply needs CONFIRM. A cancelled document,
 * or one AutoCount does not hold, is refused before anything is composed. After
 * apply a FRESH connection re-reads each row this run wrote: a queued edit must
 * be pending or sent, with Lines that name each line by a numeric DtlKey or
 * declare it new.
 *
 * INVOICES (docs/bugs/0914). A sales or purchase invoice is looked up by its
 * number like the others. HC-SI-2609-001's edit was dropped because it was saved
 * before its conversion drained, and nothing could send it again by name.
 *
 * RE-RUN: a second apply queues one more edit per document, composed from the
 * document as it is then. An edit carries the whole current state, so the book
 * ends the same; the outbox gains one row per document.
 *
 * Env: DATABASE_URL (required)  DOC_NOS (required, comma separated, at most 30)
 *      MODE=plan|apply (default plan)  CONFIRM (apply)  COMPANY_ID (default 1)
 */
import postgres from "postgres";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";
import { resetWritebackFlagCache } from "../src/scm/lib/autocount-writeback-flag.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").trim().toLowerCase() === "apply";
const CONFIRM_PHRASE = "send these documents to AutoCount as they are now";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const DOC_NOS = [...new Set((process.env.DOC_NOS || "").split(",").map((s) => s.trim()).filter(Boolean))];
const MAX_DOCS = 30;
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!DOC_NOS.length) { console.error("DOC_NOS is required — this sends the documents it is given, never a sweep"); process.exit(2); }
if (DOC_NOS.length > MAX_DOCS) { console.error(`DOC_NOS names ${DOC_NOS.length} documents; at most ${MAX_DOCS} per run`); process.exit(2); }
if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const found = await pg`
  SELECT 'SO' AS doc_type, doc_no, NULL::text AS doc_id, status::text AS status, linked_ac_docno
    FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${pg(DOC_NOS)}
  UNION ALL
  SELECT 'PO', po_number, id::text, status::text, linked_ac_docno
    FROM scm.purchase_orders WHERE company_id = ${CO} AND po_number IN ${pg(DOC_NOS)}
  UNION ALL
  SELECT 'DO', do_number, id::text, status::text, linked_ac_docno
    FROM scm.delivery_orders WHERE company_id = ${CO} AND do_number IN ${pg(DOC_NOS)}
  UNION ALL
  SELECT 'GR', grn_number, id::text, status::text, linked_ac_docno
    FROM scm.grns WHERE company_id = ${CO} AND grn_number IN ${pg(DOC_NOS)}
  UNION ALL
  SELECT 'IV', invoice_number, id::text, status::text, linked_ac_docno
    FROM scm.sales_invoices WHERE company_id = ${CO} AND invoice_number IN ${pg(DOC_NOS)}
  UNION ALL
  SELECT 'PI', invoice_number, id::text, status::text, linked_ac_docno
    FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number IN ${pg(DOC_NOS)}`;

const targets = [];
const refused = [];
for (const docNo of DOC_NOS) {
  const hits = found.filter((f) => f.doc_no === docNo);
  if (hits.length !== 1) { refused.push(`${docNo}: ${hits.length === 0 ? "no such document in this company" : `${hits.length} documents carry this number`}`); continue; }
  const [d] = hits;
  if (String(d.status ?? "").toUpperCase() === "CANCELLED") { refused.push(`${d.doc_type} ${docNo}: cancelled`); continue; }
  if (!d.linked_ac_docno) { refused.push(`${d.doc_type} ${docNo}: AutoCount does not hold it (no linked_ac_docno)`); continue; }
  targets.push(d);
}
notice(`${APPLY ? "APPLY" : "PLAN (rolled back)"}: ${targets.length} document(s) to compose, ${refused.length} refused before composing`);
for (const r of refused) console.log(`  refused: ${r}`);

class PlanRollback extends Error { constructor(rows) { super("plan: rolled back"); this.rows = rows; } }

async function composeOne(t) {
  const run = async (tx) => {
    resetWritebackFlagCache();
    const sb = pgrestShim(tx, "scm", { writeback: "enqueue" });
    const returned = await enqueueEdit(sb, {
      companyId: CO, docType: t.doc_type, docNo: t.doc_no, docId: t.doc_id, createdBy: null,
    });
    const written = await tx`
      SELECT id::text AS id, op, status, last_error, payload->'body'->'Lines' AS lines
        FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_type = ${t.doc_type} AND created_at >= now()
         AND (doc_no = ${t.doc_no} OR (${t.doc_id}::text IS NOT NULL AND doc_id = ${t.doc_id}::text))`;
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

const linesProblem = (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) return "no Lines";
  const bad = lines.filter((l) => typeof l.DtlKey !== "number" && l.IsNewLine !== true);
  return bad.length ? `${bad.length} line(s) with neither a DtlKey nor IsNewLine` : null;
};

const queued = [];
let declined = 0;
for (const t of targets) {
  let res;
  try {
    res = await composeOne(t);
  } catch (e) {
    console.log(`  ERROR ${t.doc_type} ${t.doc_no}: ${e?.message ?? e}`);
    declined += 1;
    continue;
  }
  const pending = res.written.find((w) => w.op === "edit" && w.status === "pending");
  const skipped = res.written.find((w) => w.status === "skipped");
  if (pending) {
    const lines = Array.isArray(pending.lines) ? pending.lines : [];
    const problem = linesProblem(pending.lines);
    console.log(`  ${APPLY ? "queued" : "composes"}: ${t.doc_type} ${t.doc_no} (AutoCount ${t.linked_ac_docno}) — ${lines.length} line(s)`
      + `${lines.some((l) => l.IsNewLine) ? `, ${lines.filter((l) => l.IsNewLine).length} new` : ""}`
      + `${lines.some((l) => l.Retire) ? `, ${lines.filter((l) => l.Retire).length} retired` : ""}`
      + `${problem ? ` — SHAPE WRONG: ${problem}` : ""}`);
    if (APPLY) queued.push({ ...t, rowId: pending.id });
  } else {
    declined += 1;
    console.log(`  ${APPLY ? "not queued" : "would be refused"}: ${t.doc_type} ${t.doc_no} — ${skipped?.last_error ?? `enqueueEdit returned ${res.returned} and wrote no row`}`);
  }
}
await pg.end();

if (!APPLY) {
  notice(`PLAN: every transaction was rolled back, nothing queued. Apply with MODE=apply CONFIRM='${CONFIRM_PHRASE}'`);
  process.exit(0);
}

const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const rows = queued.length ? await verify`
  SELECT id::text AS id, status, payload->'body'->'Lines' AS lines
    FROM scm.autocount_outbox WHERE id = ANY(${queued.map((q) => q.rowId)}::uuid[])` : [];
await verify.end();
const byId = new Map(rows.map((r) => [r.id, r]));
const failures = [];
for (const q of queued) {
  const r = byId.get(q.rowId);
  const problem = !r ? "row not found" : !["pending", "sent"].includes(r.status) ? `status ${r.status}` : linesProblem(r.lines);
  if (problem) failures.push(`${q.doc_type} ${q.doc_no}: ${problem}`);
}
if (failures.length) {
  console.error(`verify FAILED on a fresh connection: ${failures.join("; ")}`);
  process.exit(1);
}
notice(`APPLIED: ${queued.length} edit(s) queued and re-read on a fresh connection with every line keyed or declared new; ${declined} refused by the composer; ${refused.length} refused before composing.`);
