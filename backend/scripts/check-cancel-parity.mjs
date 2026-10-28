#!/usr/bin/env node
// CANCEL PARITY — the owner's third go-live rule, made testable.
//
// His rule: "cancel 一边，另一边还开着" must never happen. A cancel applied on
// one side only splits the outstanding set, and his acceptance test is that his
// own outstanding rule — NOT converted to DO and NOT to IV, cancelled excluded —
// computes IDENTICALLY on both sides. This check computes it on both sides and
// prints every document that is outstanding on ONE side only, with the reason.
//
// It is deliberately a DIFF, not a score. "97% agreement" is not an answer to
// "does a cancel diverge"; the names of the documents that disagree are.
//
// ── The two halves and why they arrive differently ─────────────────────────
// The AutoCount side is a COMMITTED SNAPSHOT (data/ac-cancel-parity.json.gz).
// The account book is reachable only over ZeroTier from the shop's network;
// production Postgres is reachable only from a GitHub runner. No one machine
// sees both, so the AutoCount half is exported on that network by
// backend/scripts/export-ac-cancel-parity.py and committed. This check prints
// the snapshot's age on every run and marks it STALE past AC_SNAPSHOT_MAX_AGE_DAYS,
// so a disagreement caused by the days in between can never be mistaken for a
// cancel divergence.
//
// ── What the outstanding rule is, on each side ─────────────────────────────
// AutoCount: Cancelled='F' AND EXISTS a SODTL line with Qty-TransferedQty > 0.
//   TransferedQty counts a transfer to a Delivery Order AND a direct transfer to
//   an Invoice alike, so "not to DO and not to IV" is that one predicate.
// ERP:       status <> 'CANCELLED' AND EXISTS a live line whose qty exceeds what
//   live delivery-order lines and live invoice lines have taken from it.
//   The ERP has no TransferedQty column; delivered/invoiced quantity is derived
//   from delivery_order_items.so_item_id and sales_invoice_items.so_item_id, and
//   lines belonging to a CANCELLED DO or invoice do not count — which is exactly
//   what makes this check sensitive to a cancel on either side.
//
// ── STRICTLY READ-ONLY ─────────────────────────────────────────────────────
// SELECT only. No DDL, no writes, no transaction. Manual trigger only.
// Exit 0 for every legitimate answer, including "they disagree" — a red job
// reads as "the check broke", and the answer is the output. Non-zero is reserved
// for an unreachable database or a missing snapshot.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const CO = Number(process.env.COMPANY ?? 1);
const SAMPLE = Number(process.env.SAMPLE ?? 25);
const MAX_AGE = Number(process.env.AC_SNAPSHOT_MAX_AGE_DAYS ?? 2);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const SNAP = path.join(here, "data", "ac-cancel-parity.json.gz");
if (!fs.existsSync(SNAP)) {
  console.error(`missing ${SNAP} — run backend/scripts/export-ac-cancel-parity.py on the ZeroTier network first`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8").replace(/^﻿/, ""));

/* The six ERP tables, and how each names the two things this check needs: the
   human document number and the AutoCount document it is linked to. They do NOT
   share a key column — the SO is keyed by its number, the other five by a uuid —
   which is why this is a table rather than a loop over one shape. */
const ERP = {
  SO: { table: "scm.mfg_sales_orders",   docCol: "doc_no" },
  PO: { table: "scm.purchase_orders",    docCol: "po_number" },
  DO: { table: "scm.delivery_orders",    docCol: "do_number" },
  GR: { table: "scm.grns",               docCol: "grn_number" },
  IV: { table: "scm.sales_invoices",     docCol: "invoice_number" },
  PI: { table: "scm.purchase_invoices",  docCol: "invoice_number" },
};

async function main() {
  // ── snapshot age ─────────────────────────────────────────────────────────
  const ageDays = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  log("═══ CANCEL PARITY — ERP vs the live AutoCount book ═══");
  log(`AutoCount snapshot: ${snap.book} exported ${snap.exported_at} (${ageDays.toFixed(2)} days old)`
    + `${ageDays > MAX_AGE ? "  ** STALE — refresh before trusting a disagreement **" : ""}`);
  log(`ERP company: ${CO}`);
  log("");

  const acSo = new Map();          // AutoCount DocNo -> {cancelled, outstanding, hasDo, hasIv}
  for (const [DocNo, c, o, hd, hi] of snap.so) {
    acSo.set(DocNo, { cancelled: !!c, outstanding: !!o, hasDo: !!hd, hasIv: !!hi });
  }

  // ── ERP outstanding set, by the same rule ────────────────────────────────
  /* ONE statement. The subqueries are deliberately correlated on so_item_id
     rather than joined: a line can be split across several delivery orders and
     several invoices, and a JOIN would multiply the SO line by their product
     before the aggregate ever ran. COALESCE(i.cancelled,false) mirrors the
     column the SO detail routes filter on; a cancelled LINE is not outstanding
     any more than a cancelled document is. */
  const erpRows = await sql`
    SELECT h.doc_no,
           h.linked_ac_docno,
           h.status,
           BOOL_OR( (i.qty
                     - COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                                   JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
                                  WHERE d.so_item_id = i.id AND dh.status <> 'CANCELLED'), 0)
                     - COALESCE((SELECT SUM(s.qty) FROM scm.sales_invoice_items s
                                   JOIN scm.sales_invoices sh ON sh.id = s.sales_invoice_id
                                  WHERE s.so_item_id = i.id AND sh.status <> 'CANCELLED'), 0)
                    ) > 0 ) AS has_open_line
      FROM scm.mfg_sales_orders h
      JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
     WHERE h.company_id = ${CO}
       AND COALESCE(i.cancelled, false) = false
     GROUP BY h.doc_no, h.linked_ac_docno, h.status`;

  const erpBySo = new Map();       // ERP doc_no -> row
  const erpByAc = new Map();       // AutoCount DocNo -> ERP row
  for (const r of erpRows) {
    const row = {
      docNo: r.doc_no,
      ac: r.linked_ac_docno,
      status: r.status,
      cancelled: r.status === "CANCELLED",
      outstanding: r.status !== "CANCELLED" && r.has_open_line === true,
    };
    erpBySo.set(r.doc_no, row);
    if (r.linked_ac_docno) erpByAc.set(r.linked_ac_docno, row);
  }

  const acOutstanding = [...acSo.entries()].filter(([, v]) => !v.cancelled && v.outstanding);
  const erpOutstanding = [...erpBySo.values()].filter((r) => r.outstanding);
  log("─── 1. THE OWNER'S OUTSTANDING RULE, COMPUTED ON BOTH SIDES ───");
  log(`AutoCount: ${acSo.size} sales orders, ${[...acSo.values()].filter((v) => v.cancelled).length} cancelled, `
    + `${acOutstanding.length} OUTSTANDING (not cancelled, some line not transferred to a DO or an IV)`);
  log(`ERP:       ${erpBySo.size} sales orders in company ${CO}, `
    + `${[...erpBySo.values()].filter((r) => r.cancelled).length} cancelled, `
    + `${erpOutstanding.length} OUTSTANDING (same rule, delivered+invoiced derived from live DO / SI lines)`);
  const linked = [...erpBySo.values()].filter((r) => r.ac).length;
  log(`Comparable: ${linked} ERP orders carry a linked_ac_docno; `
    + `${erpBySo.size - linked} are ERP-native and have no AutoCount counterpart to disagree with.`);
  log("");

  // ── one-sided outstanding, with the reason ───────────────────────────────
  /* THE REASON IS THE POINT. "Outstanding on one side only" is a symptom with
     several distinct causes, and only ONE of them is the cancel divergence the
     owner's rule is about. Reporting them in one undifferentiated pile would
     bury the four documents that matter under three hundred that never left the
     ERP. */
  const acOnly = { erpCancelled: [], erpClosed: [], erpMissing: [] };
  for (const [docNo, v] of acOutstanding) {
    const e = erpByAc.get(docNo);
    if (!e) { acOnly.erpMissing.push({ docNo, ...v }); continue; }
    if (e.cancelled) { acOnly.erpCancelled.push({ docNo, erp: e.docNo, status: e.status }); continue; }
    if (!e.outstanding) acOnly.erpClosed.push({ docNo, erp: e.docNo, status: e.status });
  }
  const erpOnly = { acCancelled: [], acClosed: [], acMissing: [], erpNative: [] };
  for (const e of erpOutstanding) {
    if (!e.ac) { erpOnly.erpNative.push(e); continue; }
    const v = acSo.get(e.ac);
    if (!v) { erpOnly.acMissing.push({ docNo: e.docNo, ac: e.ac }); continue; }
    if (v.cancelled) { erpOnly.acCancelled.push({ docNo: e.docNo, ac: e.ac }); continue; }
    if (!v.outstanding) erpOnly.acClosed.push({ docNo: e.docNo, ac: e.ac, hasDo: v.hasDo, hasIv: v.hasIv });
  }

  const show = (label, rows, fmt) => {
    log(`${label}: ${rows.length}`);
    for (const r of rows.slice(0, SAMPLE)) log("      " + fmt(r));
    if (rows.length > SAMPLE) log(`      ... ${rows.length - SAMPLE} more`);
  };

  log("─── 2. OUTSTANDING IN AUTOCOUNT ONLY ───");
  show("   CANCEL DIVERGENCE — the ERP cancelled it, AutoCount still holds it open",
    acOnly.erpCancelled, (r) => `${r.docNo}  (ERP ${r.erp}, ${r.status})`);
  show("   CONVERSION NOT MIRRORED — the ERP delivered or invoiced it, AutoCount did not",
    acOnly.erpClosed, (r) => `${r.docNo}  (ERP ${r.erp}, ${r.status})`);
  show("   NOT IN THE ERP AT ALL — never imported, or imported and deleted",
    acOnly.erpMissing, (r) => `${r.docNo}  (AutoCount: hasDo=${r.hasDo} hasIv=${r.hasIv})`);
  log("");

  log("─── 3. OUTSTANDING IN THE ERP ONLY ───");
  show("   REVERSE CANCEL DIVERGENCE — AutoCount cancelled it, the ERP still holds it open",
    erpOnly.acCancelled, (r) => `${r.docNo} -> ${r.ac}`);
  show("   DRIFT — AutoCount transferred it downstream, the ERP did not (someone worked in AutoCount)",
    erpOnly.acClosed, (r) => `${r.docNo} -> ${r.ac}  (AutoCount hasDo=${r.hasDo} hasIv=${r.hasIv})`);
  show("   LINK BROKEN — the ERP names an AutoCount document that is not in the book",
    erpOnly.acMissing, (r) => `${r.docNo} -> ${r.ac}`);
  log(`   ERP-NATIVE — raised in the ERP, no AutoCount counterpart expected: ${erpOnly.erpNative.length}`);
  log("");

  // ── cancel parity across all six document types ──────────────────────────
  /* Section 1 is the owner's rule and it is about sales orders. This section is
     the same question asked of every document type the two systems share,
     because a cancelled INVOICE that is still live in the account book keeps
     consuming its delivery order there — which moves the outstanding set by
     exactly that document, one step further down the chain. */
  log("─── 4. CANCELLED ON ONE SIDE ONLY, EVERY DOCUMENT TYPE ───");
  const acDocs = { SO: acSo };
  for (const t of ["PO", "DO", "GR", "IV", "PI"]) {
    acDocs[t] = new Map((snap.docs[t] ?? []).map(([d, c]) => [d, { cancelled: !!c }]));
  }
  let divergent = 0;
  for (const [t, spec] of Object.entries(ERP)) {
    const rows = await sql.unsafe(
      `SELECT ${spec.docCol} AS doc_no, status, linked_ac_docno
         FROM ${spec.table}
        WHERE company_id = $1 AND linked_ac_docno IS NOT NULL`, [CO]);
    const erpCancelledAcLive = [];
    const acCancelledErpLive = [];
    const notInBook = [];
    for (const r of rows) {
      const v = acDocs[t].get(r.linked_ac_docno);
      if (!v) { notInBook.push(r); continue; }
      const erpCancelled = r.status === "CANCELLED";
      if (erpCancelled && !v.cancelled) erpCancelledAcLive.push(r);
      if (!erpCancelled && v.cancelled) acCancelledErpLive.push(r);
    }
    divergent += erpCancelledAcLive.length + acCancelledErpLive.length;
    log(`   ${t}: ${rows.length} linked  |  ERP-cancelled but LIVE in AutoCount: ${erpCancelledAcLive.length}`
      + `  |  AutoCount-cancelled but LIVE in the ERP: ${acCancelledErpLive.length}`
      + `  |  linked to a document not in the book: ${notInBook.length}`);
    for (const r of erpCancelledAcLive.slice(0, SAMPLE)) log(`      ERP-cancelled, AC live: ${r.doc_no} -> ${r.linked_ac_docno}`);
    for (const r of acCancelledErpLive.slice(0, SAMPLE)) log(`      AC-cancelled, ERP live: ${r.doc_no} -> ${r.linked_ac_docno} (${r.status})`);
    for (const r of notInBook.slice(0, 5)) log(`      link not in book:       ${r.doc_no} -> ${r.linked_ac_docno}`);
  }
  log("");

  // ── the outbox's own evidence ────────────────────────────────────────────
  /* A cancel that never reached AutoCount has two possible explanations and they
     need different fixes: the ERP asked and the ask failed (a row exists, in
     'failed' or stuck 'pending'), or the ERP never asked at all (no row). The
     second is the one that used to be invisible, and it is what section 5 finds. */
  log("─── 5. THE OUTBOX — DID THE ERP EVEN ASK? ───");
  /* A MISSING TABLE IS AN ANSWER, NOT A CRASH. scm.autocount_outbox arrives with
     migration 0277; against a database that has not run it yet the honest report
     is "there is no outbox", and this check must still exit 0 and still have
     printed sections 1-4, which do not depend on it. */
  const [{ present }] = await sql`SELECT to_regclass('scm.autocount_outbox') IS NOT NULL AS present`;
  if (!present) {
    log("   scm.autocount_outbox does not exist on this database (migration 0277 has not run).");
    log("   Sections 1-4 above stand on their own; there is simply nothing to ask about the queue.");
    log("");
    log("─── VERDICT ───");
    const split0 = acOnly.erpCancelled.length + erpOnly.acCancelled.length;
    log(`   Sales orders whose OUTSTANDING answer differs because of a one-sided cancel: ${split0}`);
    log(`   Documents of any type cancelled on one side only: ${divergent}`);
    log("   ERP cancels never asked for: NOT MEASURABLE — no outbox on this database.");
    await sql.end();
    return;
  }
  const outbox = await sql`
    SELECT op, doc_type, status, COUNT(*)::int n
      FROM scm.autocount_outbox WHERE company_id = ${CO}
     GROUP BY op, doc_type, status ORDER BY op, doc_type, status`;
  if (!outbox.length) {
    log("   the outbox is EMPTY for this company — nothing has ever been queued.");
    log("   (scm.app_config 'scm.autocount_writeback' ships seeded 'off'; while it is off,");
    log("    every enqueue is a no-op, so an empty outbox is the expected state, not a fault.)");
  } else {
    for (const r of outbox) log(`   ${r.op.padEnd(10)} ${r.doc_type.padEnd(3)} ${r.status.padEnd(8)} ${r.n}`);
  }
  const noAsk = await sql`
    SELECT h.doc_no, h.linked_ac_docno
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO} AND h.status = 'CANCELLED' AND h.linked_ac_docno IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scm.autocount_outbox o
                        WHERE o.company_id = h.company_id AND o.op = 'cancel'
                          AND o.doc_type = 'SO' AND o.doc_no = h.doc_no)`;
  log(`   Sales orders CANCELLED in the ERP, linked to AutoCount, with NO cancel row queued: ${noAsk.length}`);
  for (const r of noAsk.slice(0, SAMPLE)) log(`      ${r.doc_no} -> ${r.linked_ac_docno}`);
  log("");

  // ── verdict ──────────────────────────────────────────────────────────────
  /* The verdict counts ONLY the classes a cancel can cause. Drift (someone
     working in AutoCount) and ERP-native documents are reported above and are
     real findings, but they are not what rule 3 is about, and folding them in
     would make the verdict move for reasons that have nothing to do with a
     cancel. */
  const cancelSplit = acOnly.erpCancelled.length + erpOnly.acCancelled.length;
  log("─── VERDICT ───");
  log(`   Sales orders whose OUTSTANDING answer differs because of a one-sided cancel: ${cancelSplit}`);
  log(`   Documents of any type cancelled on one side only: ${divergent}`);
  log(`   ERP cancels never asked for: ${noAsk.length}`);
  log(cancelSplit === 0 && divergent === 0 && noAsk.length === 0
    ? "   PASS — a cancel does not diverge: both sides compute the same outstanding set."
    : "   ATTENTION — the documents named above are open on one side and closed on the other.");
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(2);
});
