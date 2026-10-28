#!/usr/bin/env node
// repair-delivery-dates-from-book — put the ERP's delivery dates back in step
// with AutoCount's OWN per-line delivery date (SODTL/DODTL.DeliveryDate).
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE do_date REPAIR IT REPLACES.
// The first attempt (repair-do-delivery-dates-to-autocount.mjs, PR #3615) set a
// linked DO's delivery dates to its own `do_date` — AutoCount's DocDate — on the
// assumption that the book's line delivery date equals its document date.
// MEASURED against the live book 2026-09-11: of 235 linked delivery orders the
// two differ on 65 (28%). That repair would have stamped a wrong delivery date
// on 65 live documents. This one reads the real field instead.
//
// ROOT CAUSE it repairs (proven, not inferred). The inbound pull never carries
// the line delivery date — the middleware's /DeliveryOrder/getSince projection
// is nine HEADER columns and the date lives on the LINE. So a delivery date
// changed in AutoCount after import never reaches the ERP, while the ERP's own
// edits DO flow the other way (autocount-outbox.ts maps line_delivery_date ->
// SODTL.DeliveryDate). One-directional sync = drift. HC12445: the committed
// 2026-08-11 snapshot has SO-011302 at 05/09, the live book says 19/09, the ERP
// still held 05/09, and the DO cut from it inherited that stale 05/09.
// Owner 2026-09-11: 「全部要跟 autocount」.
//
// This is a CATCH-UP, not the cure. Until the pull carries the field (needs a
// middleware change on the AutoCount host — outside this repo's deploy path),
// the drift returns. See docs/modules/delivery-order.md.
//
// SOURCE: backend/scripts/data/ac-delivery-dates.json.gz, exported read-only by
// export-ac-delivery-dates.py. A CI runner is not on the AutoCount network, so
// the snapshot is committed and this script reads it — the repo's standing
// pattern (check-stock-vs-autocount.mjs does the same).
//
// SCOPE: company_id = 1 (Houzs Century, = the AED_HOUZS book) AND
// linked_ac_docno IS NOT NULL. 2990 does not sync to AutoCount (owner ruling)
// and Hookka is a different book, so both are untouched by construction.
//
// WHAT IT WILL NOT TOUCH, deliberately:
//   * rows carrying `amended_delivery_date` — that is a deliberate ERP-side
//     amendment, and if it disagrees with the book the fault is the write-back,
//     not a stale pull. Listed, never written.
//   * documents whose book lines disagree among themselves (min != max): no
//     single value can be the header date, so only the LINES are repaired.
//   * blank ERP delivery dates. Filling them changes what MRP sees on thousands
//     of orders (the MRP page gates on delivery date), so it needs the owner.
//     Counted in the plan; written only with INCLUDE_BLANKS=1.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="DELIV-DATES-FROM-BOOK".
// RE-RUN: idempotent — only rows still differing are written, and the
// verification below re-reads on a fresh connection and asserts none remain.
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "DELIV-DATES-FROM-BOOK";
const INCLUDE_BLANKS = process.env.INCLUDE_BLANKS === "1";
const COMPANY = 1;

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const here = dirname(fileURLToPath(import.meta.url));
const book = JSON.parse(gunzipSync(readFileSync(join(here, "data", "ac-delivery-dates.json.gz"))).toString());

/** doc_no -> { docDate, single } for one book document family. */
const docIndex = (rows) => new Map(rows.map((r) => [r.DocNo, {
  docDate: r.DocDate,
  single: r.minDeliveryDate != null && r.minDeliveryDate === r.maxDeliveryDate ? r.minDeliveryDate : null,
}]));
/** DtlKey (as string — that is how linked_ac_dtlkey compares) -> delivery date. */
const lineIndex = (rows) => new Map(rows.map((r) => [String(r.DtlKey), r.DeliveryDate]));

const bookSo = docIndex(book.so);
const bookDo = docIndex(book.do);
const bookSoLines = lineIndex(book.so_lines);
const bookDoLines = lineIndex(book.do_lines);

/** Classify one header against the book. null = nothing to do. */
function headerPlan(erpDate, amended, b) {
  if (b == null) return null;                       // not in the book at all
  if (amended != null) return { skip: "amended" };  // deliberate ERP amendment
  if (b.single == null) return { skip: "book_lines_disagree" };
  if (erpDate == null) return INCLUDE_BLANKS ? { to: b.single, blank: true } : { skip: "erp_blank" };
  return erpDate === b.single ? null : { to: b.single };
}

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  log(`book snapshot exported_at=${book.exported_at}  ${JSON.stringify(book.counts)}`);
  if (INCLUDE_BLANKS) log("INCLUDE_BLANKS=1 — blank ERP delivery dates WILL be filled from the book");

  // ── sales orders ────────────────────────────────────────────────
  const soRows = await sql`
    SELECT doc_no, linked_ac_docno, status,
           to_char(customer_delivery_date,'YYYY-MM-DD') AS cdd,
           to_char(amended_delivery_date,'YYYY-MM-DD')  AS amd
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY} AND linked_ac_docno IS NOT NULL`;
  const soFix = []; const soSkip = {};
  for (const r of soRows) {
    const p = headerPlan(r.cdd, r.amd, bookSo.get(r.linked_ac_docno));
    if (p == null) continue;
    if (p.skip) { soSkip[p.skip] = (soSkip[p.skip] || 0) + 1; continue; }
    soFix.push({ doc: r.doc_no, from: r.cdd, to: p.to, status: r.status });
  }

  // ── delivery orders ─────────────────────────────────────────────
  const doRows = await sql`
    SELECT do_number, linked_ac_docno, status,
           to_char(do_date,'YYYY-MM-DD')                AS do_date,
           to_char(expected_delivery_at,'YYYY-MM-DD')   AS exp,
           to_char(customer_delivery_date,'YYYY-MM-DD') AS cdd
      FROM scm.delivery_orders
     WHERE company_id = ${COMPANY} AND linked_ac_docno IS NOT NULL`;
  const doFix = []; const doSkip = {}; let doDocDateMismatch = 0;
  for (const r of doRows) {
    const b = bookDo.get(r.linked_ac_docno);
    if (b != null && b.docDate != null && r.do_date !== b.docDate) doDocDateMismatch++;
    // A DO's two header date fields are one fact under two names; both follow
    // the book. `cdd ?? exp` so a row holding only one of them still compares.
    const p = headerPlan(r.cdd ?? r.exp, null, b);
    if (p?.skip) { doSkip[p.skip] = (doSkip[p.skip] || 0) + 1; continue; }
    const to = p?.to ?? r.cdd ?? r.exp;
    if (to == null) continue;
    if (r.exp === to && r.cdd === to) continue;   // already in step
    doFix.push({ doc: r.do_number, from: `exp ${r.exp ?? "-"} / cust ${r.cdd ?? "-"}`, to, status: r.status });
  }

  // ── lines, keyed by the book's own DtlKey. NOT by item code: the book keeps
  //    a sofa as ONE line where the ERP keeps one per compartment, so code
  //    matching cannot pair them (memory: sofa-is-one-book-line). ───────────
  //    No parent join is needed: both item tables carry their own `company_id`,
  //    and `linked_ac_dtlkey` only exists on a line that came from the book.
  //    `line_delivery_date_overridden` (0807-do-line-delivery-date) marks a date an operator typed on
  //    purpose — never clobbered, only counted.
  //    BLANKS, per table. A blank DO line date is not a judgement call: it is
  //    the residue of bug 0807-do-line-delivery-date (the payload key mismatch that dropped every DO
  //    line date until 2026-09-11), nothing reads it upstream, and the book has
  //    the value — so those are filled by default. A blank SO line/header date
  //    is different: MRP gates on it, so filling thousands of them changes what
  //    the floor sees and waits for INCLUDE_BLANKS=1.
  const lineFix = async (table, idx, fillBlanks) => {
    const rows = await sql.unsafe(`
      SELECT id, linked_ac_dtlkey, line_delivery_date_overridden AS ovr,
             to_char(line_delivery_date,'YYYY-MM-DD') AS d
        FROM scm.${table}
       WHERE company_id = ${COMPANY} AND linked_ac_dtlkey IS NOT NULL`);
    const out = []; let overridden = 0; let blanks = 0;
    for (const r of rows) {
      const want = idx.get(String(r.linked_ac_dtlkey));
      if (want == null) continue;
      if (r.d === want) continue;
      if (r.ovr === true) { overridden++; continue; }
      if (r.d == null) { blanks++; if (!(fillBlanks || INCLUDE_BLANKS)) continue; }
      out.push({ id: r.id, to: want, from: r.d });
    }
    return { scanned: rows.length, out, overridden, blanks };
  };
  const soL = await lineFix("mfg_sales_order_items", bookSoLines, false);
  const doL = await lineFix("delivery_order_items", bookDoLines, true);

  log("");
  log(`SALES ORDERS     linked=${soRows.length}  to fix=${soFix.length}  skipped=${JSON.stringify(soSkip)}`);
  for (const f of soFix.slice(0, 10)) log(`   ${f.doc} [${f.status}] ${f.from ?? "(blank)"} -> ${f.to}`);
  /* The blank note has to change with the FLAG. It used to read "needs
     INCLUDE_BLANKS=1" unconditionally, so a run WITH the flag printed an
     instruction to set the flag it was already running under - output the owner
     reads, saying the opposite of what happened. */
  const blankNote = (n, fillingText) => (n === 0 ? '' : INCLUDE_BLANKS
    ? `  blank=${n} (${fillingText})`
    : `  blank=${n} (left blank: MRP gates on this - re-run with INCLUDE_BLANKS=1 to fill them)`);
  log(`SO LINES         scanned=${soL.scanned}  to fix=${soL.out.length}${blankNote(soL.blanks, 'filled from the book')}  operator-overridden=${soL.overridden}`);
  log(`DELIVERY ORDERS  linked=${doRows.length}  to fix=${doFix.length}  skipped=${JSON.stringify(doSkip)}`);
  for (const f of doFix.slice(0, 10)) log(`   ${f.doc} [${f.status}] ${f.from} -> both ${f.to}`);
  log(`DO LINES         scanned=${doL.scanned}  to fix=${doL.out.length}${blankNote(doL.blanks, 'filled - bug 0807-do-line-delivery-date residue, filled by default')}  operator-overridden=${doL.overridden}`);
  log(`FYI: linked DOs whose do_date differs from the book's DocDate: ${doDocDateMismatch} — NOT touched here, the document date is a separate fact.`);

  if (MODE !== "apply") {
    log(`PLAN: nothing written. Re-run MODE=apply CONFIRM=${CONFIRM_PHRASE} to apply.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const f of soFix) {
      await tx`UPDATE scm.mfg_sales_orders SET customer_delivery_date = ${f.to}::date
                WHERE doc_no = ${f.doc} AND company_id = ${COMPANY}`; n++;
    }
    for (const f of doFix) {
      await tx`UPDATE scm.delivery_orders
                  SET expected_delivery_at = ${f.to}::date, customer_delivery_date = ${f.to}::date
                WHERE do_number = ${f.doc} AND company_id = ${COMPANY}`; n++;
    }
    for (const f of soL.out) {
      await tx`UPDATE scm.mfg_sales_order_items SET line_delivery_date = ${f.to}::date WHERE id = ${f.id}`; n++;
    }
    for (const f of doL.out) {
      await tx`UPDATE scm.delivery_order_items SET line_delivery_date = ${f.to}::date WHERE id = ${f.id}`; n++;
    }
  });
  log(`APPLIED: ${n} row(s) written.`);
  await sql.end();

  // Verify on a FRESH connection — a read inside the writing session can be
  // served from that session's own snapshot and prove nothing.
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const soWant = new Map(soFix.map((f) => [f.doc, f.to]));
  const doWant = new Map(doFix.map((f) => [f.doc, f.to]));
  const sv = soFix.length === 0 ? [] : await v`
    SELECT doc_no, to_char(customer_delivery_date,'YYYY-MM-DD') AS cdd
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY} AND doc_no = ANY(${[...soWant.keys()]})`;
  const dv = doFix.length === 0 ? [] : await v`
    SELECT do_number, to_char(customer_delivery_date,'YYYY-MM-DD') AS cdd,
           to_char(expected_delivery_at,'YYYY-MM-DD') AS exp
      FROM scm.delivery_orders
     WHERE company_id = ${COMPANY} AND do_number = ANY(${[...doWant.keys()]})`;
  await v.end();
  const bad = sv.filter((r) => r.cdd !== soWant.get(r.doc_no));
  const dbad = dv.filter((r) => r.cdd !== doWant.get(r.do_number) || r.exp !== doWant.get(r.do_number));
  if (bad.length || dbad.length) die(`VERIFY FAILED: ${bad.length} SO + ${dbad.length} DO still wrong`);
  log(`VERIFIED on a fresh connection: ${sv.length} SO + ${dv.length} DO now hold the book's delivery date.`);
}

main().catch((e) => die(e?.message ?? String(e)));
