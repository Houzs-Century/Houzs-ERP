#!/usr/bin/env node
/* probe-do-code-changed-after-conversion — READ-ONLY.  THE POPULATION, not the
 * two documents.
 *
 * WHY.  `DO-001953` and `DO-004903` were found because their LINE COUNT differs
 * from the book's.  A delivery order whose item code was changed but whose line
 * count stayed the same does not show on that axis at all, so the reconcile's
 * "DO line-count: 2" is not the size of this class — it is the size of the part
 * of it that happens to be visible from another angle.  This probe measures the
 * class directly.
 *
 * THE TEST, and it is the book against itself.  AutoCount stamps a delivery
 * line with the document it was converted FROM (`DODTL.FromDocType='SO'` +
 * `FromDocNo`) and, in this book, NEVER with the LINE (`FromDocDtlKey` is empty
 * on all 48,772 DO lines, while 10,792 of 18,890 PO lines carry it — the column
 * exists and is populated elsewhere, so its emptiness here is AutoCount's DO
 * conversion not recording it).  A delivery line whose own source sales order
 * contains no line with that item code is therefore a line whose code was
 * CHANGED after the conversion: nothing in the book objected, because nothing
 * in the book was watching the line.
 *
 * TWO CLASSES ARE EXCLUDED, and neither is a judgement call:
 *   - a row the book states NO ItemCode for (`hasCode = 0`).  Those are
 *     annotations and free-text charges — "* DISPOSE 1 QUEEN MATTRESS",
 *     "COL: PC151-13", "* AFTER 5PM".  They are the class of docs/bugs/0695 and
 *     section G of the SO/DO remainder, and they are counted separately here so
 *     the exclusion is visible rather than silent.
 *   - a line whose source sales order is not in this snapshot at all.  There is
 *     nothing to compare it against and saying so is the answer.
 *
 * AND THEN THE HALF THAT NEEDS THE DATABASE: of the delivery orders the book
 * flags, WHICH ONES DOES THE ERP HOLD?  The migration carried the OUTSTANDING
 * population, so most of them are correctly absent and there is nothing to
 * repair; only a document the ERP holds can be short a line.  Per document the
 * probe prints whether the ERP has it, how many rows it holds, and whether a
 * row already answers each flagged book line — by AutoCount's own line key.
 *
 * READ-ONLY BY CONSTRUCTION: every statement is a SELECT and there is no APPLY
 * path through this file.
 *
 * RE-RUN: safe and idempotent — it writes nothing.  The answer moves only when
 * the snapshot is re-cut or another lane creates a delivery order.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildScope, decodeSnapshot } from "./lib/ac-scope.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 200);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUTH = path.join(HERE, "data", "ac-reconcile-truth.json.gz");

const note = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m = "") => console.log(m);
const keyOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(/\.0+$/, "");
  return /^-?\d+$/.test(s) ? s : null;
};

async function main() {
  if (!fs.existsSync(TRUTH)) { console.error(`missing ${TRUTH}`); process.exit(2); }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(TRUTH)).toString("utf8").replace(/^﻿/, ""));
  note(`AutoCount snapshot exported_at=${snap.exported_at}; source=${snap.source}`);
  const book = decodeSnapshot(snap);
  const scope = buildScope(book);

  /* ── A — the book against itself ──────────────────────────────────────── */
  const soCodes = new Map();
  for (const [docNo, ls] of book.SO.lines) soCodes.set(docNo, new Set(ls.map((l) => String(l.itemKey ?? "").trim())));

  const offenders = new Map();
  let doLines = 0; let converted = 0; let noSource = 0; let annotation = 0; let codeless = 0;
  let withFromLineKey = 0;
  for (const [doNo, ls] of book.DO.lines) {
    for (const l of ls) {
      doLines++;
      if (String(l.fromSoDtlKey ?? "").trim()) withFromLineKey++;
      if (l.fromDocType !== "SO" || !l.fromDocNo) continue;
      converted++;
      if (!soCodes.has(l.fromDocNo)) { noSource++; continue; }
      const code = String(l.itemKey ?? "").trim();
      if (!code) { codeless++; continue; }
      if (soCodes.get(l.fromDocNo).has(code)) continue;
      if (!l.hasCode) { annotation++; continue; }
      if (!offenders.has(doNo)) offenders.set(doNo, []);
      offenders.get(doNo).push(l);
    }
  }
  const offenderLines = [...offenders.values()].reduce((s, v) => s + v.length, 0);

  plain("");
  note("═══════════ A — THE BOOK AGAINST ITSELF ═══════════");
  plain(`delivery lines in the book: ${doLines}; converted from a sales order the snapshot holds: ${converted - noSource}`);
  plain(`  the source sales order is not in this snapshot: ${noSource}; the row carries no text at all: ${codeless}`);
  plain(`  DO lines carrying AutoCount's own SOURCE LINE key (FromDocDtlKey): ${withFromLineKey} of ${doLines}` +
    ` — this is why nothing objected when a code was changed after the conversion`);
  plain(`EXCLUDED, annotation / free-text rows the source order does not carry (the book states no ItemCode): ${annotation}` +
    " — the docs/bugs/0695 class, counted here so the exclusion is visible");
  note(`THE CLASS: ${offenderLines} delivery line(s) on ${offenders.size} delivery order(s) carry a real item code that the` +
    " sales order they were converted from does not contain.");

  /* ── B — which of them the ERP holds ──────────────────────────────────── */
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const docNos = [...offenders.keys()].sort();
  const erpDocs = docNos.length
    ? await sql`SELECT linked_ac_docno, id::text AS id, do_number, status
          FROM scm.delivery_orders
         WHERE company_id = ${CO} AND linked_ac_docno = ANY(${docNos})`
    : [];
  const erpByAc = new Map(erpDocs.map((d) => [d.linked_ac_docno, d]));
  const erpRows = erpDocs.length
    ? await sql`SELECT delivery_order_id::text AS doc_id, item_code, qty::float8 AS qty,
            linked_ac_dtlkey, ac_substituted
          FROM scm.delivery_order_items
         WHERE delivery_order_id = ANY(${erpDocs.map((d) => d.id)})`
    : [];
  const rowsByDoc = new Map();
  for (const r of erpRows) {
    if (!rowsByDoc.has(r.doc_id)) rowsByDoc.set(r.doc_id, []);
    rowsByDoc.get(r.doc_id).push(r);
  }

  let held = 0; let shortDocs = 0; let shortLines = 0; let completeDocs = 0; const shortList = [];
  plain("");
  note("═══════════ B — WHICH OF THEM THE ERP HOLDS, AND WHETHER THE LINE IS THERE ═══════════");
  plain("The migration carried the OUTSTANDING population, so a delivery order the ERP does not hold is the rule working,");
  plain("not a gap. Only a document the ERP HOLDS can be short a line, and 'short' is decided on AutoCount's own line key.");
  let shown = 0;
  for (const doNo of docNos) {
    const ls = offenders.get(doNo);
    const erp = erpByAc.get(doNo);
    if (!erp) continue;
    held++;
    const rows = rowsByDoc.get(erp.id) ?? [];
    const claimed = new Set(rows.map((r) => keyOf(r.linked_ac_dtlkey)).filter(Boolean));
    const missing = ls.filter((l) => !claimed.has(keyOf(l.dtlKey)));
    if (missing.length) { shortDocs++; shortLines += missing.length; shortList.push({ doNo, erp, ls, rows, missing }); }
    else completeDocs++;
    if (shown++ < TOP) {
      plain("");
      plain(`${doNo} -> ${erp.do_number} (${erp.status})  in the migration scope: ${scope.DO.has(doNo) ? "yes" : "no"}` +
        `  ERP rows ${rows.length} (${claimed.size} carry an AutoCount line key)`);
      for (const l of ls) {
        const there = claimed.has(keyOf(l.dtlKey));
        plain(`   book key=${l.dtlKey} "${l.itemKey}" x${Math.round(l.qty)} <- ${l.fromDocNo}` +
          `   ${there ? "the ERP holds it" : "NO ERP ROW CLAIMS THIS KEY  <-- SHORT"}`);
      }
      for (const r of rows) {
        plain(`   have  ${String(r.item_code).slice(0, 34).padEnd(34)} x${r.qty}  key ${keyOf(r.linked_ac_dtlkey) ?? "(none)"}` +
          `${r.ac_substituted ? "  ac_substituted" : ""}`);
      }
    }
  }
  plain("");
  note(`OF THE ${offenders.size} delivery order(s) the book flags, the ERP HOLDS ${held}` +
    ` and does not hold ${offenders.size - held} (correctly — outstanding means not yet delivered).`);
  note(`Of the ${held} it holds: ${completeDocs} already carry every flagged line; ${shortDocs} are SHORT, ` +
    `${shortLines} line(s) in total.`);
  if (shortList.length) {
    plain("");
    plain("SHORT, by name:");
    for (const s of shortList) {
      plain(`   ${s.doNo} (${s.erp.do_number}): ${s.missing.map((l) => `${l.itemKey} x${Math.round(l.qty)} key ${l.dtlKey}`).join("; ")}`);
    }
  }
  await sql.end({ timeout: 5 });
  plain("");
  note("probe-do-code-changed-after-conversion: read-only, nothing was written.");
}

main().catch(async (e) => { console.error(e); process.exit(1); });
