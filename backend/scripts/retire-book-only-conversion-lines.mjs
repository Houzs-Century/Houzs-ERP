#!/usr/bin/env node
/* retire-book-only-conversion-lines — zero, in AutoCount, a delivery order or
 * goods receipt line the ERP no longer holds.
 *
 * 白话. 同事把送货单上的一行搬去新开的送货单，旧单那边的修改被系统拦下了（那时行还没对上号），
 * 所以 AutoCount 的旧送货单还留着那一行，新单又送了一次 —— 账本里等于送了两次货。
 * 这个脚本找出「账本有、ERP 已经没有」的行，用系统自己的送单程序把它在 AutoCount 归零，
 * 跟 ERP 删除一行时本来就会送的指令一模一样。
 *
 * ── WHY (docs/bugs/0902) ───────────────────────────────────────────────────
 * On 2026-09-14 the bolster lines of HC-DO-2609-044 and HC-DO-2609-058 were moved
 * onto new delivery orders HC-DO-2609-102 / -103. Both edits of the old documents
 * were refused for keyless lines, and a deleted row with no key is not named in
 * any later edit (`retiredLineOf` returns nothing for it). The book kept both
 * lines; DO-102's transfer took HC-SO-008447's bolster a second time (the sales
 * order's next edit is now refused, "less than the quantity it was partially
 * transferred"), and DO-103's transfer was refused because HC-SO-003434's line
 * was already fully transferred.
 *
 * ── WHAT IT DECIDES ────────────────────────────────────────────────────────
 * From the committed book snapshot (data/ac-conversion-line-keys.json.gz, written
 * by export-ac-conversion-line-keys.py, at most MAX_AGE_DAYS old and carrying
 * `qty` + `transferredOn`) and the ERP as it is now, `planBookOnlyLines`
 * (scripts/lib/book-only-line-plan.mjs) retires a book line only when no ERP row
 * of the document claims its key, EVERY ERP row of the document carries a key,
 * the line still has a quantity, and nothing downstream holds it. Everything
 * else is printed as held, with the reason.
 *
 * ── WHAT IT SENDS ──────────────────────────────────────────────────────────
 * The Worker's own `enqueueEdit` with `retire: [{ DtlKey, ItemCode, Gone:
 * 'deleted' }]`, the instruction the line-delete routes send when the row had a
 * key. A delivery order or goods receipt is never rebuilt, so the host zeroes
 * the line's quantity, marks it not transferable and prefixes its Description 2
 * with [ERP-CANCELLED]. The edit also carries every other line, keyed, as any
 * save of the document would.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan. The plan is not a prediction: each document is composed
 * by the real `enqueueEdit` inside its own transaction, the row it wrote is read
 * back, and the transaction is ROLLED BACK. MODE=apply needs CONFIRM. After
 * apply a FRESH connection re-reads each document's new row and asserts the
 * shape: a pending (or already sent) edit whose Lines name every line by a
 * numeric DtlKey and carry each planned key with Retire: true; a composer
 * refusal is reported as such.
 *
 * RE-RUN: a second apply against the SAME snapshot plans the same lines and
 * sends one more identical edit, which zeroes a line already at zero. A fresh
 * export shows those lines at quantity 0, and the plan then skips them.
 *
 * Env: DATABASE_URL (required)  MODE=plan|apply (default plan)  CONFIRM (apply)
 *      COMPANY_ID (default 1)   DOC_NOS (optional, comma separated)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";
import { resetWritebackFlagCache } from "../src/scm/lib/autocount-writeback-flag.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";
import { planBookOnlyLines } from "./lib/book-only-line-plan.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").trim().toLowerCase() === "apply";
const CONFIRM_PHRASE = "zero the lines the ERP removed from these delivery orders and receipts";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const DOC_NOS = (process.env.DOC_NOS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_AGE_DAYS = 2;
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-conversion-line-keys.json.gz"))).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
const F = Object.fromEntries(snap.fields.map((f, i) => [f, i]));
if (!("qty" in F) || !("transferredOn" in F)) {
  console.error("the book snapshot has no qty / transferredOn — re-run export-ac-conversion-line-keys.py");
  process.exit(2);
}
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`the book snapshot is ${ageDays.toFixed(1)} day(s) old (exported ${snap.exported_at}); `
    + `a line the book changed since cannot be judged from it. Re-export first.`);
  process.exit(2);
}

/* A delivery order or goods receipt only. A sales or purchase order that loses a
   line is rebuilt (`shouldRebuild`), so a retirement there is not this lane. */
const bookByDoc = new Map();
for (const r of snap.rows) {
  if (r[F.docType] !== "DO" && r[F.docType] !== "GR") continue;
  const k = `${r[F.docType]}|${r[F.docNo]}`;
  (bookByDoc.get(k) ?? bookByDoc.set(k, []).get(k)).push({
    toDtlKey: Number(r[F.toDtlKey]), itemCode: r[F.itemCode], qty: Number(r[F.qty]),
    transferredOn: Number(r[F.transferredOn]), cancelled: Boolean(r[F.cancelled]),
  });
}

const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const erpRows = await pg`
  SELECT 'DO' AS doc_type, h.id::text AS doc_id, h.do_number AS doc_no, h.status::text AS status,
         i.id IS NOT NULL AS has_row, i.linked_ac_dtlkey
    FROM scm.delivery_orders h LEFT JOIN scm.delivery_order_items i ON i.delivery_order_id = h.id AND i.company_id = h.company_id
   WHERE h.company_id = ${CO} AND h.do_number LIKE 'HC-DO-%'
  UNION ALL
  SELECT 'GR', h.id::text, h.grn_number, h.status::text, i.id IS NOT NULL, i.linked_ac_dtlkey
    FROM scm.grns h LEFT JOIN scm.grn_items i ON i.grn_id = h.id AND i.company_id = h.company_id
   WHERE h.company_id = ${CO} AND h.grn_number LIKE 'HC-GRN-%'`;
const erpByDoc = new Map();
for (const r of erpRows) {
  const k = `${r.doc_type}|${r.doc_no}`;
  const d = erpByDoc.get(k) ?? erpByDoc.set(k, { docId: r.doc_id, status: r.status, rowKeys: [] }).get(k);
  if (r.has_row) d.rowKeys.push(r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey));
}

const planned = [];
const heldAll = [];
let alreadyZero = 0;
for (const [k, lines] of bookByDoc) {
  const [docType, docNo] = k.split("|");
  if (DOC_NOS.length && !DOC_NOS.includes(docNo)) continue;
  const erp = erpByDoc.get(k);
  const plan = planBookOnlyLines(lines, {
    exists: Boolean(erp),
    cancelled: String(erp?.status ?? "").toUpperCase() === "CANCELLED",
    rowKeys: erp?.rowKeys ?? [],
  });
  alreadyZero += plan.alreadyZero;
  for (const h of plan.held) heldAll.push({ docType, docNo, ...h });
  if (plan.retire.length) planned.push({ docType, docNo, docId: erp.docId, retire: plan.retire });
}

notice(`book snapshot ${snap.exported_at} (${ageDays.toFixed(2)} day(s) old); ${DOC_NOS.length ? `documents ${DOC_NOS.join(", ")}` : "every HC-DO / HC-GRN document"}`);
notice(`book lines no ERP row holds: ${planned.reduce((n, p) => n + p.retire.length, 0)} to zero on ${planned.length} document(s), ${heldAll.length} held, ${alreadyZero} already at zero`);
for (const p of planned) {
  console.log(`  ${APPLY ? "zeroing" : "would zero"}: ${p.docType} ${p.docNo} — ${p.retire.map((l) => `${l.dtlKey} ${l.itemCode} x${l.qty}`).join("; ")}`);
}
for (const h of heldAll) console.log(`  held: ${h.docType} ${h.docNo} ${h.dtlKey} ${h.itemCode} x${h.qty} — ${h.reason}`);

class PlanRollback extends Error { constructor(rows) { super("plan: rolled back"); this.rows = rows; } }

async function composeOne(p) {
  const run = async (tx) => {
    resetWritebackFlagCache();
    const sb = pgrestShim(tx, "scm", { writeback: "enqueue" });
    const returned = await enqueueEdit(sb, {
      companyId: CO, docType: p.docType, docId: p.docId, createdBy: null,
      retire: p.retire.map((l) => ({ DtlKey: l.dtlKey, ItemCode: l.itemCode, Gone: "deleted" })),
    });
    const written = await tx`
      SELECT id::text AS id, op, status, last_error, payload->'body'->'Lines' AS lines
        FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_type = ${p.docType} AND doc_id = ${p.docId} AND created_at >= now()`;
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

const shapeOf = (lines, retire) => {
  if (!Array.isArray(lines) || lines.length === 0) return "no Lines";
  if (!lines.every((l) => typeof l.DtlKey === "number")) return "a line without a numeric DtlKey";
  const retired = new Set(lines.filter((l) => l.Retire === true).map((l) => l.DtlKey));
  const missing = retire.filter((l) => !retired.has(l.dtlKey));
  return missing.length ? `not retired: ${missing.map((l) => l.dtlKey).join(", ")}` : null;
};

const sentDocs = [];
for (const p of planned) {
  const res = await composeOne(p);
  const pending = res.written.find((w) => w.op === "edit" && w.status === "pending");
  const skipped = res.written.find((w) => w.status === "skipped");
  if (pending) {
    const bad = shapeOf(pending.lines, p.retire);
    console.log(`  ${APPLY ? "queued" : "composes"}: ${p.docType} ${p.docNo} — ${pending.lines.length} line(s), `
      + `${pending.lines.filter((l) => l.Retire === true).length} retired${bad ? ` — SHAPE WRONG: ${bad}` : ""}`);
    if (APPLY) sentDocs.push({ ...p, rowId: pending.id });
  } else {
    console.log(`  ${APPLY ? "not queued" : "would be refused"}: ${p.docType} ${p.docNo} — ${skipped?.last_error ?? `enqueueEdit returned ${res.returned} and wrote no row`}`);
  }
}
await pg.end();

if (!APPLY) {
  notice(`PLAN: every transaction was rolled back, nothing queued. Apply with MODE=apply CONFIRM='${CONFIRM_PHRASE}'`);
  process.exit(0);
}

const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const rows = sentDocs.length ? await verify`
  SELECT id::text AS id, status, payload->'body'->'Lines' AS lines
    FROM scm.autocount_outbox WHERE id = ANY(${sentDocs.map((d) => d.rowId)}::uuid[])` : [];
await verify.end();
const byId = new Map(rows.map((r) => [r.id, r]));
const failures = [];
for (const d of sentDocs) {
  const r = byId.get(d.rowId);
  const bad = !r ? "row not found" : !["pending", "sent"].includes(r.status) ? `status ${r.status}` : shapeOf(r.lines, d.retire);
  if (bad) failures.push(`${d.docType} ${d.docNo}: ${bad}`);
}
if (failures.length) {
  console.error(`verify FAILED on a fresh connection: ${failures.join("; ")}`);
  process.exit(1);
}
notice(`APPLIED: ${sentDocs.length} edit(s) queued, each re-read on a fresh connection with every planned line retired and every line keyed; ${planned.length - sentDocs.length} refused by the composer.`);
