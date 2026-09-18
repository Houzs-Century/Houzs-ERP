#!/usr/bin/env node
/* repair-ac-po-doc-no — put our purchase order numbers back in AutoCount's
 * "PO Doc No." and name the source orders on our purchase orders.
 *
 * 白话. ERP 之前把 SO 的参考号写进了 AutoCount SO 上的「PO Doc No.」栏：盖掉了 92 个 PO 号，
 * 另外 376 张原本空的也被写了参考号；ERP 开的新单 Ref 是空的；ERP 开的 PO 没写 SO 单号。
 * 这个脚本照 ERP 的记录把它们改回来。先预演（不送），确认后才送。
 *
 * ── WHY (docs/bugs/0926) ───────────────────────────────────────────────────
 * SO.UDF_ToPONo is the book's "PO Doc No.": the purchase orders made from the
 * order, ", "-joined. The write-back put the order's reference there. #3934
 * stopped that. This fills the field from the ERP's own links, which on
 * 2026-09-15 matched the book's earlier PO numbers on 102 of 103 orders and
 * added one on the last.
 *
 * ── WHICH DOCUMENTS ────────────────────────────────────────────────────────
 * Only fields the ERP itself wrote:
 *   SO  an order AutoCount holds, not cancelled, with a SENT create_so / edit
 *       row whose payload carried UDF.ToPONo.
 *   PO  a purchase order made in the ERP (HC-PO-26...), in the book, not
 *       cancelled, whose create_po / so_to_po went before the fix.
 *
 * ── WHAT IT QUEUES ─────────────────────────────────────────────────────────
 * One header-only /edit per document through the Worker's own enqueueAcOp:
 *   SO  UDF.ToPONo = the order's purchase orders in the book, or "" when it has
 *       none. Ref = the order's reference on an order made in the ERP, whose
 *       book Ref is blank; a carried-over order keeps the book's own Ref.
 *   PO  UDF.SONo = the source orders. Ref = the one source order's reference,
 *       or "" where a create wrote our own SO numbers into Ref and there is no
 *       single reference to put back.
 *
 * ── PACE ───────────────────────────────────────────────────────────────────
 * The drain sends 20 rows a sweep in queue order, so a run queues at most LIMIT
 * documents (default 40, at most 200) and staff documents are not held up long.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan, which reads and prints and writes nothing. MODE=apply
 * needs CONFIRM. After apply a FRESH connection re-reads each queued row and
 * asserts its shape: pending or sent, no lines, the field it was queued for.
 * References are customer text and are never printed.
 *
 * RE-RUN: a document already given this edit — a pending or sent header-only
 * edit carrying ToPONo (SO) or SONo (PO), queued since TOOL_SINCE, which also
 * covers the drain's own post-purchase-order edits — is skipped, so a second run
 * continues where the first stopped.
 *
 * Env: DATABASE_URL (required)  MODE=plan|apply (default plan)  CONFIRM (apply)
 *      COMPANY_ID (default 1)  LIMIT (default 40, at most 200)
 */
import postgres from "postgres";
import { enqueueAcOp } from "../src/scm/lib/autocount-outbox.ts";
import { joinPoDocNos, readSoPoDocNos, composeSoPoDocNoEdit } from "../src/scm/lib/autocount-so-po-doc-no.ts";
import { readPoSourceSo } from "../src/scm/lib/autocount-po-source-so.ts";
import { soReference } from "../src/services/autocount-writeback.ts";
import { resetWritebackFlagCache } from "../src/scm/lib/autocount-writeback-flag.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").trim().toLowerCase() === "apply";
const CONFIRM_PHRASE = "put our purchase order numbers back in AutoCount";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Math.min(200, Math.max(1, Number(process.env.LIMIT || 40)));
/* After #3934 deployed (08:40Z): an edit queued since then is this fix's own. */
const TOOL_SINCE = "2026-09-15T08:45:00Z";
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const sos = await pg`
  SELECT s.doc_no, s.linked_ac_docno, s.ref, s.customer_so_no
    FROM scm.mfg_sales_orders s
   WHERE s.company_id = ${CO} AND s.linked_ac_docno IS NOT NULL AND s.status::text <> 'CANCELLED'
     AND EXISTS (SELECT 1 FROM scm.autocount_outbox o
                  WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.doc_no = s.doc_no
                    AND o.status = 'sent' AND o.op IN ('create_so', 'edit') AND o.created_at < ${TOOL_SINCE}
                    AND coalesce(o.payload #> '{body,UDF,ToPONo}', o.payload #> '{body,Header,UDF,ToPONo}') IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM scm.autocount_outbox o
                  WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.doc_no = s.doc_no AND o.op = 'edit'
                    AND o.status IN ('pending', 'sent') AND o.created_at >= ${TOOL_SINCE}
                    AND o.payload #> '{body,Lines}' = '[]'::jsonb AND o.payload #> '{body,Header,UDF,ToPONo}' IS NOT NULL)
   ORDER BY s.doc_no`;

const pos = await pg`
  SELECT p.id::text AS id, p.po_number, p.linked_ac_docno,
         bool_or(o.op = 'create_po' AND nullif(o.payload #>> '{body,Ref}', '') IS NOT NULL) AS create_wrote_ref
    FROM scm.purchase_orders p
    JOIN scm.autocount_outbox o ON o.company_id = p.company_id AND o.doc_type = 'PO' AND (o.doc_id = p.id::text OR o.doc_no = p.po_number)
   WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND p.status::text <> 'CANCELLED' AND p.po_number LIKE 'HC-PO-26%'
     AND o.status = 'sent' AND o.op IN ('create_po', 'so_to_po') AND o.created_at < ${TOOL_SINCE}
     AND NOT EXISTS (SELECT 1 FROM scm.autocount_outbox r
                  WHERE r.company_id = ${CO} AND r.doc_type = 'PO' AND r.doc_id = p.id::text AND r.op = 'edit'
                    AND r.status IN ('pending', 'sent') AND r.created_at >= ${TOOL_SINCE}
                    AND r.payload #> '{body,Lines}' = '[]'::jsonb AND r.payload #> '{body,Header,UDF,SONo}' IS NOT NULL)
   GROUP BY p.id, p.po_number, p.linked_ac_docno
   ORDER BY p.po_number`;

const reader = pgrestShim(pg, "scm");
const plan = [];
for (const s of sos) {
  const toPoNo = joinPoDocNos(await readSoPoDocNos(reader, CO, s.doc_no));
  const madeInErp = s.doc_no.startsWith("HC-SO-26");
  const ref = madeInErp ? soReference(s) : null;
  const body = composeSoPoDocNoEdit(s.linked_ac_docno, toPoNo);
  if (ref) body.Header.Ref = ref;
  plan.push({ docType: "SO", docNo: s.doc_no, docId: null, acNo: s.linked_ac_docno, body, toPoNo, refSet: !!ref });
}
for (const p of pos) {
  const src = await readPoSourceSo(reader, p.id);
  const header = {};
  if (src.ref) header.Ref = src.ref;
  else if (p.create_wrote_ref) header.Ref = "";
  if (src.source_so_no) header.UDF = { SONo: src.source_so_no };
  if (!header.UDF && header.Ref === undefined) continue;
  plan.push({
    docType: "PO", docNo: p.po_number, docId: p.id, acNo: p.linked_ac_docno,
    body: { DocType: "PO", DocNo: p.linked_ac_docno, Header: header, Lines: [] },
    soNo: src.source_so_no, refSet: !!src.ref, refCleared: header.Ref === "",
  });
}

const soPlan = plan.filter((x) => x.docType === "SO");
const poPlan = plan.filter((x) => x.docType === "PO");
notice(`${APPLY ? "APPLY" : "PLAN"}: ${soPlan.length} sales order(s) and ${poPlan.length} purchase order(s) the ERP wrote these fields on; this run takes ${Math.min(LIMIT, plan.length)}`);
console.log(`  SO  PO Doc No. becomes our purchase order numbers: ${soPlan.filter((x) => x.toPoNo).length} | cleared (no purchase order): ${soPlan.filter((x) => !x.toPoNo).length} | Ref filled on orders made in the ERP: ${soPlan.filter((x) => x.refSet).length}`);
console.log(`  PO  SO Doc No. named: ${poPlan.filter((x) => x.soNo).length} | Ref set to the order's reference: ${poPlan.filter((x) => x.refSet).length} | our SO numbers cleared from Ref: ${poPlan.filter((x) => x.refCleared).length}`);
for (const x of soPlan.slice(0, 12)) console.log(`    SO ${x.docNo} (AutoCount ${x.acNo}) -> PO Doc No. '${x.toPoNo}'${x.refSet ? " + Ref" : ""}`);
for (const x of poPlan.slice(0, 8)) console.log(`    PO ${x.docNo} -> SO Doc No. '${x.soNo ?? ""}'${x.refSet ? " + Ref" : x.refCleared ? " + Ref cleared" : ""}`);

if (!APPLY) {
  await pg.end();
  notice(`PLAN: nothing queued. Apply with MODE=apply CONFIRM='${CONFIRM_PHRASE}' (LIMIT ${LIMIT} per run)`);
  process.exit(0);
}

const batch = plan.slice(0, LIMIT);
const queued = [];
for (const x of batch) {
  const rowId = await pg.begin(async (tx) => {
    resetWritebackFlagCache();
    const sb = pgrestShim(tx, "scm", { writeback: "enqueue" });
    const ok = await enqueueAcOp(sb, {
      companyId: CO, op: "edit", docType: x.docType, docNo: x.docNo, docId: x.docId,
      payload: {
        body: x.body,
        selfDoc: x.docType === "SO"
          ? { table: "mfg_sales_orders", keyCol: "doc_no", key: x.docNo }
          : { table: "purchase_orders", keyCol: "id", key: x.docId },
      },
      dedupeKey: null,
      createdBy: null,
    });
    if (!ok) return null;
    const [row] = await tx`
      SELECT id::text AS id FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_type = ${x.docType} AND doc_no = ${x.docNo} AND op = 'edit' AND created_at >= now()
       ORDER BY created_at DESC LIMIT 1`;
    return row?.id ?? null;
  });
  if (rowId) queued.push({ ...x, rowId });
  else console.log(`  not queued: ${x.docType} ${x.docNo}`);
}
await pg.end();

const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const rows = queued.length ? await verify`
  SELECT id::text AS id, status, payload->'body' AS body FROM scm.autocount_outbox WHERE id = ANY(${queued.map((q) => q.rowId)}::uuid[])` : [];
await verify.end();
const byId = new Map(rows.map((r) => [r.id, r]));
const failures = [];
for (const q of queued) {
  const r = byId.get(q.rowId);
  const b = r?.body ?? {};
  const shape = !r ? "row not found"
    : !["pending", "sent"].includes(r.status) ? `status ${r.status}`
    : !(Array.isArray(b.Lines) && b.Lines.length === 0) ? "carries lines"
    : q.docType === "SO" && typeof b.Header?.UDF?.ToPONo !== "string" ? "no ToPONo"
    : q.docType === "PO" && typeof b.Header?.UDF?.SONo !== "string" && typeof b.Header?.Ref !== "string" ? "neither SONo nor Ref"
    : null;
  if (shape) failures.push(`${q.docType} ${q.docNo}: ${shape}`);
}
if (failures.length) {
  console.error(`verify FAILED on a fresh connection: ${failures.join("; ")}`);
  process.exit(1);
}
notice(`APPLIED: ${queued.length} header-only edit(s) queued and re-read on a fresh connection (${queued.filter((q) => q.docType === "SO").length} SO, ${queued.filter((q) => q.docType === "PO").length} PO); ${plan.length - queued.length} left for the next run.`);
