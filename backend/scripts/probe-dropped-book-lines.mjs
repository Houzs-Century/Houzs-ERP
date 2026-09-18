#!/usr/bin/env node
/* probe-dropped-book-lines — READ-ONLY.  What the owner's blank-line rule
 * actually caught, and what the ERP holds for each one.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * `import-ac-outstanding-so.mjs` applies the owner's 2026-08-09 rule to a sales
 * line it cannot resolve to a product: PRICED -> it is a charge and becomes
 * TRANSPORTATION CHARGES; ZERO-PRICED -> it is dropped.  The rule is HIS and it
 * is not in question.  What was never measured is what it caught, and the owner
 * answered 「这些都要」 before anyone had put the list in front of him.
 *
 * The list is not one thing.  It is three, and they want three different
 * answers:
 *
 *   NAMED        a real product, fully named, that the free-text resolver
 *                failed on — so the drop fired on a MATCHER failure, not on a
 *                blank line.  These belong in the ERP.
 *
 * AND THE RESOLVER RUNS FIRST, which reading the export alone gets backwards.
 * "code-less and unpriced" is the CANDIDATE set, not the dropped set: a line in
 * it that the pick list can answer was imported as GOODS and the owner's rule
 * never saw it.  Section A asks the LIVE pick list before it calls anything
 * dropped, because the pick list has grown since the import and the honest
 * answer is today's, not a reconstruction of that run's.
 *   INSTRUCTION  a build note somebody typed on a line of its own
 *                ("COLOUR : 885-4", "LEG: FOLLOW DISPLAY").  Creating a product
 *                line for one invents goods the customer never ordered.  The
 *                question for these is whether the instruction reached the ERP
 *                by its proper route — the colour field on the line it belongs
 *                to, or the order's remarks.
 *   UNDESCRIBED  the book states nothing at all: no code, no description, no
 *                Desc2, no money.  Nothing can be recovered from the book, and
 *                inventing a product is forbidden.  Where such a row also
 *                carries a QUANTITY it is a finding for the owner, not a bug.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 * A: the committed import cut `data/ac-outstanding-so.json.gz` — the exact file
 *    the importer read.
 * B: the purchase-order and delivery-order cuts, so the owner's question
 *    「其他order也是这样?」 gets a number per document type.
 * C: the LIVE company-1 pick list, run through the importer's OWN resolver
 *    (`lib/ac-name-resolver.mjs`, traced), so a failure is REPORTED with the
 *    rule it fell out of instead of being guessed at.  No product is chosen by
 *    eye here, and nothing downstream reads the near-miss list it prints.
 * D: what the ERP holds for each affected document — every line with its
 *    AutoCount key, and the header's status, totals and remarks.
 * E: whether each instruction's text reached the ERP anywhere on its document.
 * F: PROVENANCE — how many of each document's rows still carry an AutoCount line
 *    key, and what its audit log records. A document whose rows carry no key did
 *    not get them from the import, and a repair that "adds the missing line" to
 *    one of those duplicates goods it already holds.
 * G: the movement control — a migrated document must carry none.
 *
 * READ-ONLY BY CONSTRUCTION: every statement is a SELECT, there is no APPLY
 * flag, and there is no path through this file that writes.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildTracedNameResolver } from "./lib/ac-name-resolver.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const rm = (sen) => `RM ${((Number(sen) || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

const rd = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const blankS = (v) => !String(v ?? "").trim();
const flat = (s) => norm(s).replace(/[^A-Z0-9]/g, "");

/* The importer's rule, restated as a CLASSIFIER and nothing else — it decides
   no outcome here, it only names which of the three populations a row is in. */
const INSTRUCTION_RE = /^(COLOUR|COLOR|CLR|COL|LEG|LEGS|GAP|DIVAN|FABRIC|SIZE|REMARK|NOTE)\b\s*[:：]/i;
function classify(l) {
  const desc = String(l.Description ?? l.LineDesc ?? "").trim();
  const d2 = String(l.Desc2 ?? "").trim();
  if (!desc && !d2) return num(l.Qty) > 0 ? "UNDESCRIBED-BUT-ORDERED" : "UNDESCRIBED";
  if (num(l.Qty) === 0 && INSTRUCTION_RE.test(desc || d2)) return "INSTRUCTION";
  return "NAMED";
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  plain("");
  plain("=".repeat(78));
  plain("A — WHAT THE OWNER'S BLANK-LINE RULE CAUGHT, in the file the importer read");
  plain("=".repeat(78));

  const so = rd("ac-outstanding-so.json.gz");
  const codeless = so.filter((r) => blankS(r.ItemCode));
  const priced = codeless.filter((r) => num(r.UnitPrice) > 0);
  const unpriced = codeless.filter((r) => !(num(r.UnitPrice) > 0));
  log(`data/ac-outstanding-so.json.gz: ${so.length} line(s) over ${new Set(so.map((r) => r.DocNo)).size} document(s)`);
  log(`code-less line(s): ${codeless.length} — PRICED ${priced.length}; ZERO-PRICED ${unpriced.length}`);

  /* THE ORDER OF THE TWO RULES IS THE WHOLE POINT, and reading the file alone
     gets it backwards. The importer resolves the free text against the LIVE
     pick list FIRST; the owner's rule only sees what the resolver could not
     answer. So "code-less and unpriced" is NOT the dropped set — it is the
     candidate set, and a line in it that resolves was imported as GOODS. The
     pick list is a live table that has grown since the import, so this is the
     answer TODAY and not a reconstruction of that run. */
  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  log(`scm.mfg_products (company ${CO}): ${products.length}`);
  const traced = buildTracedNameResolver(products);
  const resolves = (r) => traced(String(r.Description ?? "").trim()).code;

  const wouldDrop = unpriced.filter((r) => !resolves(r));
  const rescued = unpriced.filter((r) => resolves(r));
  log(`of the ${unpriced.length} zero-priced code-less line(s), the resolver answers ${rescued.length} TODAY — only ${wouldDrop.length} reach the owner's drop rule`);

  plain("");
  plain(`  RESOLVED BY NAME, so the drop rule never saw them: ${rescued.length}`);
  for (const r of rescued) plain(`     ${r.DocNo} dtl ${r.DtlKey} qty ${r.Qty ?? "-"} ${JSON.stringify(r.Description ?? "")} -> ${resolves(r)}`);

  const groups = new Map();
  for (const r of wouldDrop) { const c = classify(r); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(r); }
  for (const [c, rs] of [...groups].sort()) {
    plain("");
    plain(`  DROPPED — ${c}: ${rs.length}`);
    for (const r of rs) plain(`     ${r.DocNo} dtl ${r.DtlKey} qty ${r.Qty ?? "-"} price ${r.UnitPrice ?? "-"} desc ${JSON.stringify(r.Description ?? "")} desc2 ${JSON.stringify(r.Desc2 ?? "")}`);
  }
  plain("");
  plain("  PRICED code-less lines — the resolver ran first here too, then the charge rule:");
  for (const r of priced) {
    const code = resolves(r);
    plain(`     ${r.DocNo} dtl ${r.DtlKey} qty ${r.Qty} price ${r.UnitPrice} ${JSON.stringify(r.Description ?? "")} -> ${code ? `RESOLVED ${code}` : "the charge rule: TRANSPORTATION CHARGES"}`);
  }

  plain("");
  plain("=".repeat(78));
  plain("B — THE SAME COUNT FOR EVERY OTHER DOCUMENT TYPE");
  plain("=".repeat(78));
  /* Each cut names its description column differently — `ac-partial-dos` says
     LineDesc — and reading the wrong one reports a line that says something as
     a line that says nothing. It did, on DO-001604's RM 150.00 dispose row. */
  const descOf = (r) => String(r.Description ?? r.LineDesc ?? "");
  const census = (label, rows, docKey, dtlKey) => {
    const cl = rows.filter((r) => blankS(r.ItemCode));
    const named = cl.filter((r) => !blankS(descOf(r)) || !blankS(r.Desc2));
    const mute = cl.filter((r) => blankS(descOf(r)) && blankS(r.Desc2));
    const muteOrdered = mute.filter((r) => num(r.Qty) > 0);
    plain(`  ${label}: ${rows.length} line(s) / ${new Set(rows.map((r) => r[docKey])).size} document(s)`);
    plain(`     code-less ${cl.length} — carrying text ${named.length} (priced ${named.filter((r) => num(r.UnitPrice) > 0).length}), stating nothing ${mute.length} (with a quantity ${muteOrdered.length})`);
    for (const r of muteOrdered) plain(`        STATES NOTHING YET ORDERS ${r.Qty}: ${r[docKey]} dtl ${r[dtlKey]}`);
  };
  census("SALES ORDERS, the cutover import cut (ac-outstanding-so)", so, "DocNo", "DtlKey");
  census("PURCHASE ORDERS, the cutover import cut (ac-outstanding-po)", rd("ac-outstanding-po.json.gz"), "DocNo", "DtlKey");
  census("DELIVERY ORDERS, the migration cut (ac-partial-dos)", rd("ac-partial-dos.json.gz"), "DoNo", "DoDtlKey");

  plain("");
  plain("=".repeat(78));
  plain("C — EVERY CODE-LESS LINE'S VERDICT, WITH THE RULE IT FELL OUT OF");
  plain("=".repeat(78));
  const stripDim = (s) => norm(s).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  for (const r of codeless) {
    const d = String(r.Description ?? "").trim();
    if (!d) continue;
    const v = traced(d);
    plain("");
    plain(`  ${r.DocNo} dtl ${r.DtlKey} ${JSON.stringify(d)} qty ${r.Qty ?? "-"} price ${r.UnitPrice ?? "-"}`);
    plain(`     verdict: ${v.code ? `RESOLVES to ${v.code}` : "NO MATCH"}  (${v.via})`);
    if (v.words) plain(`     it looked for [${v.words.join(", ")}] among codes ending ${v.size}; best was ${v.best ?? "(none)"} scoring ${v.bestScore}`);
    /* What the pick list DOES hold that shares the description's words, so the
       gap is visible without anyone choosing a product by eye. A REPORT only:
       nothing downstream reads it and no repair takes its answer. */
    const words = stripDim(d).split(" ").filter((w) => w.length > 2);
    const near = products
      .map((p) => ({ p, s: words.filter((w) => stripDim(p.name).includes(w) || p.code.toUpperCase().includes(w)).length }))
      .filter((x) => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, 6);
    if (near.length) { plain("     the pick list holds, sharing 2+ of its words:"); for (const x of near) plain(`        [${x.s}] ${x.p.code}  ${JSON.stringify(x.p.name)}`); }
    else plain("     the pick list holds NOTHING sharing 2 or more of its words");
  }

  plain("");
  plain("=".repeat(78));
  plain("D — WHAT THE ERP HOLDS FOR EACH AFFECTED DOCUMENT");
  plain("=".repeat(78));
  const acDocs = [...new Set(codeless.map((r) => r.DocNo))].sort();
  const erpDocs = acDocs.map((d) => "HC-" + d);
  const heads = await sql`
    SELECT doc_no, linked_ac_docno, status, debtor_name, so_date, processing_date,
           local_total_sen, paid_sen, balance_sen, line_count,
           remark2, remark3, remark4, note, venue, branding
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${erpDocs})`;
  const byDoc = new Map(heads.map((h) => [h.doc_no, h]));
  const items = await sql`
    SELECT doc_no, line_no, item_group, item_code, description, description2, qty,
           unit_price_sen, total_sen, linked_ac_dtlkey, variants, custom_specials, remark
      FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND doc_no = ANY(${erpDocs})
     ORDER BY doc_no, line_no`;
  for (const d of acDocs) {
    const erpNo = "HC-" + d;
    const h = byDoc.get(erpNo);
    const bookLines = so.filter((r) => r.DocNo === d);
    plain("");
    plain(`  ${erpNo}  (book ${d}, ${bookLines.length} book line(s))`);
    if (!h) { plain("     THE ERP DOES NOT HOLD THIS DOCUMENT AT ALL."); continue; }
    plain(`     ${h.debtor_name} | ${h.status} | so_date ${h.so_date} | processing_date ${h.processing_date ?? "(none)"} | line_count ${h.line_count}`);
    plain(`     total ${rm(h.local_total_sen)}  paid ${rm(h.paid_sen)}  balance ${rm(h.balance_sen)}`);
    plain(`     remark2=${JSON.stringify(h.remark2)} remark3=${JSON.stringify(h.remark3)} remark4=${JSON.stringify(h.remark4)} note=${JSON.stringify(h.note)}`);
    const rows = items.filter((i) => i.doc_no === erpNo);
    for (const i of rows) plain(`       line ${i.line_no} [${i.item_group}] ${i.item_code} qty ${i.qty} @ ${rm(i.unit_price_sen)} = ${rm(i.total_sen)} ackey=${i.linked_ac_dtlkey ?? "NULL"} desc=${JSON.stringify(i.description)} desc2=${JSON.stringify(i.description2)} variants=${JSON.stringify(i.variants)}`);
    const claimed = new Set(rows.map((r) => String(r.linked_ac_dtlkey)).filter((k) => k !== "null"));
    const missing = bookLines.filter((b) => !claimed.has(String(b.DtlKey)));
    plain(`     book lines NO ERP row claims: ${missing.length}${missing.length ? " — " + missing.map((m) => `${m.DtlKey} ${JSON.stringify(m.Description ?? "")}`).join("; ") : ""}`);
  }

  plain("");
  plain("=".repeat(78));
  plain("E — DID EACH INSTRUCTION REACH THE ERP BY ITS PROPER ROUTE?");
  plain("=".repeat(78));
  /* An instruction line is NOT to become a product line. What matters is
     whether its text is carried anywhere on the document it belongs to. The
     search is over the WHOLE document — every line's description2, remark,
     variants and specials, and the header's remark fields — because the ERP's
     proper home for it differs by kind (a colour is a variant; a leg note is a
     build text). Compared with punctuation and spacing removed from BOTH
     sides: the book writes "885-4" and a library row may write "885 - 4". */
  const instructions = wouldDrop.filter((r) => classify(r) === "INSTRUCTION")
    .map((r) => ({ doc: r.DocNo, dtl: r.DtlKey, text: String(r.Description || r.Desc2 || "").trim() }));
  for (const ins of instructions) {
    const erpNo = "HC-" + ins.doc;
    const needle = ins.text.replace(/^[A-Z ]+\s*[:：]\s*/i, "").trim();
    plain("");
    plain(`  ${erpNo} dtl ${ins.dtl}: ${JSON.stringify(ins.text)}  -> looking for ${JSON.stringify(needle)}`);
    const h = byDoc.get(erpNo);
    if (!h) { plain("     the ERP does not hold this document."); continue; }
    const hay = [];
    for (const f of ["remark2", "remark3", "remark4", "note", "venue", "branding"]) if (h[f]) hay.push([`header.${f}`, String(h[f])]);
    for (const i of items.filter((x) => x.doc_no === erpNo)) {
      if (i.description2) hay.push([`line ${i.line_no}.description2`, String(i.description2)]);
      if (i.remark) hay.push([`line ${i.line_no}.remark`, String(i.remark)]);
      if (i.variants) hay.push([`line ${i.line_no}.variants`, JSON.stringify(i.variants)]);
      if (i.custom_specials) hay.push([`line ${i.line_no}.custom_specials`, JSON.stringify(i.custom_specials)]);
    }
    const want = flat(needle);
    const hits = hay.filter(([, v]) => want && flat(v).includes(want));
    if (hits.length) for (const [w, v] of hits) plain(`     FOUND on ${w}: ${JSON.stringify(v.slice(0, 160))}`);
    else {
      plain("     NOT ANYWHERE ON THE DOCUMENT. Every field that could have carried it:");
      for (const [w, v] of hay) plain(`        ${w} = ${JSON.stringify(v.slice(0, 120))}`);
      if (!hay.length) plain("        (the document carries no remark, no build text and no variants at all)");
    }
    /* A colour the fabric library does not hold cannot be written to a colour
       field at all, and that changes who owns the finding. */
    const fc = await sql`
      SELECT fabric_id, colour_id, label FROM scm.fabric_colours
       WHERE company_id = ${CO}
         AND regexp_replace(upper(colour_id), '[^A-Z0-9]', '', 'g') = ${want}`;
    plain(`     fabric library rows whose colour code is ${JSON.stringify(needle)}: ${fc.length}${fc.length ? " — " + fc.map((x) => `${x.fabric_id}/${x.colour_id} ${JSON.stringify(x.label)}`).join("; ") : ""}`);
  }

  plain("");
  plain("=".repeat(78));
  plain("F — PROVENANCE: who wrote the rows these documents hold?");
  plain("=".repeat(78));
  /* THE QUESTION THAT DECIDES WHETHER THERE IS ANYTHING TO REPAIR. The importer
     stamps `linked_ac_dtlkey` on EVERY line it inserts, so a document whose
     rows carry no key did not get those rows from the import — somebody edited
     the order afterwards, and the ERP's own save path rewrites the whole line
     set without keys. A repair that adds a "missing" line to such a document
     duplicates goods that are already on it. Read, never assumed. */
  for (const d of acDocs) {
    const erpNo = "HC-" + d;
    const rows = items.filter((i) => i.doc_no === erpNo);
    if (!rows.length) continue;
    const keyed = rows.filter((r) => r.linked_ac_dtlkey != null).length;
    plain("");
    plain(`  ${erpNo}: ${keyed} of ${rows.length} row(s) carry an AutoCount line key`);
    const audit = await sql`
      SELECT action, actor_name_snapshot, created_at
        FROM scm.mfg_so_audit_log WHERE so_doc_no = ${erpNo}
       ORDER BY created_at LIMIT 20`;
    if (!audit.length) plain("     mfg_so_audit_log: ZERO rows — nothing recorded a change to this order");
    for (const a of audit) plain(`     ${a.created_at} ${a.action} by ${a.actor_name_snapshot ?? "?"}`);
  }

  plain("");
  plain("=".repeat(78));
  plain("G — CONTROL: are the affected documents carrying inventory movements?");
  plain("=".repeat(78));
  /* A migrated document must have NO movements behind it (migration 0276): the
     units came in once, through the AutoCount balance snapshot. Measured here
     so any repair's before/after has a baseline that was READ, not quoted.
     A sales order never writes a movement itself — its DELIVERY does — so both
     are asked, and the delivery side asks for the ADJUSTMENT source type too
     because that is what a reversal writes (check-migrated-cancel-exposure). */
  /* A sales order writes NO movement of its own — `source_doc_type` is only
     ever DO / GRN / ADJUSTMENT / AC_CUTOVER / PC_RECEIVE — so the control is
     the DELIVERY leg, asked for ADJUSTMENT too because that is what a reversal
     writes (check-migrated-cancel-exposure). */
  const mvDo = await sql`
    SELECT d.do_number, d.so_doc_no, d.migrated_no_stock, COUNT(m.id)::int AS movements
      FROM scm.delivery_orders d
      LEFT JOIN scm.inventory_movements m
             ON m.source_doc_id::text = d.id::text
            AND m.source_doc_type IN ('DO', 'ADJUSTMENT') AND m.company_id = ${CO}
     WHERE d.company_id = ${CO} AND d.so_doc_no = ANY(${erpDocs})
     GROUP BY d.do_number, d.so_doc_no, d.migrated_no_stock ORDER BY d.do_number`;
  if (!mvDo.length) plain("  none of these sales orders has a delivery order in the ERP");
  for (const r of mvDo) plain(`  ${r.do_number} (of ${r.so_doc_no}, migrated_no_stock=${r.migrated_no_stock}): ${r.movements} movement(s)`);

  await sql.end();
  plain("");
  log("PROBE COMPLETE — nothing was written.");
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch { /* already closed */ } process.exit(1); });
