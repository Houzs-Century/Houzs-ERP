#!/usr/bin/env node
/* probe-so-differ-provenance — for the sales orders the tally still counts as
 * DIFFER, print BOTH sides of the axis and say where the document came from.
 * READ-ONLY, BOUNDED, and it decides nothing.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * `check-so-tally.mjs` names the documents and the axis. It does not print the
 * two values, and on 2026-09-09 four of the nineteen were adjudicated from
 * guesses about which document they were — the brief for that lane named
 * `HC-SO-009735` and `HC-SO-011657`, and by the time it ran neither was on the
 * list. A name without its two values is not evidence.
 *
 * ── THE QUESTION IT ADDS, WHICH THE TALLY DOES NOT ASK ─────────────────────
 * WHO RAISED THE DOCUMENT. The reconcile exists to prove the CUTOVER carried
 * AutoCount's own sales orders across faithfully. A migrated order carries the
 * book's number in `linked_ac_docno` (`SO-013503`) beside its own
 * (`HC-SO-013503`), and the two are never equal. An order the ERP RAISED after
 * go-live reaches the account book only because our own write-back put it
 * there, and it carries its OWN number on both sides — so `linked_ac_docno`
 * EQUALS `doc_no`, which a migrated document can never do.
 *
 * That is the whole test, and it is structural rather than a heuristic: it
 * cannot be widened to cover a migrated document however much one would like
 * the count to fall. Comparing such a document against the book compares the
 * ERP against a copy of itself, and any difference is a fidelity gap in the
 * write-back — 「写回autocount的你不需要理了」, the owner, 2026-09-08.
 *
 * NOTHING IS RECLASSIFIED HERE. This file prints; the tally still counts every
 * one of them. A bucket needs its own red test and its own entry, and inventing
 * one inside a probe is how a real difference gets swallowed quietly.
 *
 * DOCS="HC-SO-010284,HC-SO-2609-002" node scripts/probe-so-differ-provenance.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
import { ERP_RAISED, provenanceOf, runSelfTest } from "./lib/so-document-provenance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-reconcile-truth.json.gz");

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const DOCS = String(process.env.DOCS || "")
  .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error('need DOCS="HC-SO-010284,..."'); process.exit(2); }

const out = (m) => console.log(m);

/* The book cut, refused when stale for the same reason the reconcile refuses
   one: an answer against an old book reads as coverage we do not have. */
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE)) {
  console.error(`the book cut is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE})`);
  process.exit(3);
}
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
const D = Object.fromEntries(snap.desc2_fields.map((n, i) => [n, i]));
const desc2 = new Map(snap.types.SO.desc2.map((r) => [String(r[D.dtlKey]), r[D.desc2]]));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

async function main() {
  /* A classifier that cannot classify must not go on reporting confidently. */
  const selfTest = runSelfTest();
  if (selfTest.length) { console.error(`the provenance classifier failed its own self-test: ${selfTest.join("; ")}`); process.exit(5); }

  const PDATE = soProcessingDateFragment(sql);

  /* THE SHAPE IS ASSERTED BEFORE ANYTHING IS READ. A column that has moved
     makes a join match nothing, and nothing reads exactly like a clean run. */
  const need = { mfg_sales_orders: ["doc_no", "linked_ac_docno", "created_at", "company_id"],
                 mfg_sales_order_items: ["doc_no", "item_code", "linked_ac_dtlkey", "variants", "custom_specials", "item_group", "qty"] };
  const cols = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${Object.keys(need)})`;
  const have = new Map();
  for (const r of cols) {
    if (!have.has(r.table_name)) have.set(r.table_name, new Set());
    have.get(r.table_name).add(r.column_name);
  }
  const missing = [];
  for (const [t, cs] of Object.entries(need)) for (const c of cs) if (!have.get(t)?.has(c)) missing.push(`scm.${t}.${c}`);
  if (missing.length) { console.error(`scm no longer carries ${missing.join(", ")}`); process.exit(4); }

  out(`book cut ${snap.exported_at} (${ageDays.toFixed(2)} days old) · company ${CO} · ${DOCS.length} document(s)\n`);

  let erpRaised = 0;
  for (const doc of DOCS) {
    const hdr = await sql`
      SELECT doc_no, linked_ac_docno, created_at, (${PDATE} IS NOT NULL) AS proceeded
        FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${doc}`;
    out("=".repeat(78));
    if (!hdr.length) { out(`${doc} — the ERP holds no such sales order`); continue; }
    const h = hdr[0];
    const ac = String(h.linked_ac_docno ?? "");

    /* THE PROVENANCE TEST, from lib/so-document-provenance.mjs. A second
       implementation of it here would be a second opinion about the same
       question, which is the failure lib/transfer-chain-verdict.mjs's header
       says this repo has paid for three times. */
    const selfNumbered = provenanceOf({ docNo: h.doc_no, linkedAcDocNo: h.linked_ac_docno }) === ERP_RAISED;
    if (selfNumbered) erpRaised += 1;
    out(`${doc}  book number ${ac || "(none)"}  created ${h.created_at?.toISOString?.() ?? h.created_at}  ${h.proceeded ? "PROCEEDED" : "not proceeded"}`);
    out(selfNumbered
      ? "   PROVENANCE: ERP-RAISED — it carries its OWN number on both sides, which a migrated order cannot do. "
        + "The book holds it only because our write-back put it there, so this compares the ERP against a copy of itself."
      : "   PROVENANCE: MIGRATED — the book's number and ours differ, so AutoCount is the independent source.");

    const bookHdr = snap.types.SO.headers.find((r) => String(r[H.docNo]) === ac);
    out(`   book header: ${bookHdr ? JSON.stringify(bookHdr) : "ABSENT FROM THE BOOK CUT (phantom)"}`);

    const erp = await sql`
      SELECT i.item_code, i.qty::float8 AS qty, i.linked_ac_dtlkey AS dtl, i.item_group,
             i.variants::text AS variants, i.custom_specials::text AS custom_specials
        FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO} AND i.doc_no = ${doc}
       ORDER BY i.linked_ac_dtlkey NULLS LAST, i.item_code`;
    const bookLines = snap.types.SO.lines.filter((r) => String(r[L.docNo]) === ac);

    out(`   --- the BOOK's ${bookLines.length} line(s) ---`);
    for (const r of bookLines) {
      out(`     dtl ${r[L.dtlKey]}  ${r[L.itemKey]}  qty ${r[L.qty]}  unit ${r[L.unitPrice]}`);
      const d = desc2.get(String(r[L.dtlKey]));
      if (d) out(`         desc2: ${JSON.stringify(d)}`);
    }
    out(`   --- the ERP's ${erp.length} line(s) ---`);
    for (const r of erp) {
      out(`     dtl ${r.dtl ?? "(none)"}  ${r.item_code}  qty ${r.qty}  group ${r.item_group ?? "(none)"}`);
      out(`         variants: ${r.variants ?? "(null)"}`);
      if (r.custom_specials && r.custom_specials !== "null") out(`         custom_specials: ${r.custom_specials}`);
    }
  }
  out("=".repeat(78));
  out(`\n${erpRaised} of ${DOCS.length} document(s) are ERP-RAISED. NOTHING WAS RECLASSIFIED BY THIS RUN — `
    + "the tally still counts every one of them; this file only says which side the number came from.");
  await sql.end({ timeout: 5 });
}

main().catch((e) => { console.error(e); process.exit(1); });
