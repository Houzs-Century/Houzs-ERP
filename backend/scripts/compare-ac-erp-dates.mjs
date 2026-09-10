#!/usr/bin/env node
// compare-ac-erp-dates — READ-ONLY. Are our DO / SO dates the same as
// AutoCount's? Staff reported HC-12445 (Syu): the DO was picked in AutoCount on
// 05/09 with delivery 19/09, and the ERP now shows DO date 19/09 and customer
// delivery 05/09 — the two dates look SWAPPED. This pulls both sides and says
// where they disagree.
//
// The AutoCount side comes from the two mirrors already in our DB, so no host
// access is needed. They live in the PUBLIC schema (migs 0215/0288 created them
// unqualified), while scm.delivery_orders / scm.mfg_sales_orders are in `scm`:
//   * DO  header -> public.autocount_delivery_orders (mig 0215): doc_no, doc_date
//   * SO  header -> public.ac_snapshot_sales_orders   (mig 0288): doc_no, doc_date, raw
// The DO mirror carries NO delivery date (only doc_date); the SO snapshot keeps
// the whole `raw` payload, so its DeliveryDate / ProcessingDate are read from
// there. Our side is scm.delivery_orders / scm.mfg_sales_orders, joined by
// linked_ac_docno.
//
// Strictly read-only: SELECTs only, no writes, exits 0 for every answer.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const NEEDLE = (process.env.DOC || "12445").trim();
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const d = (v) => {
  if (v == null) return "(none)";
  const s = String(v);
  return s.length > 10 ? s.slice(0, 10) : s;
};
const rawDate = (raw, key) => {
  try { const o = typeof raw === "string" ? JSON.parse(raw) : raw; return o?.[key] ?? null; } catch { return null; }
};

async function main() {
  // 1) How fresh is each AutoCount mirror? A stale mirror makes every
  //    comparison below suspect, so it is the first thing on screen.
  const [doFresh] = await sql`SELECT max(synced_at) AS latest, count(*)::int AS n FROM public.autocount_delivery_orders`;
  const [soN] = await sql`SELECT count(*)::int AS n, max(snapshot_at) AS latest FROM public.ac_snapshot_sales_orders`;
  const runs = await sql`SELECT kind, status, stored, finished_at FROM public.ac_snapshot_runs ORDER BY started_at DESC LIMIT 4`;
  log("=== MIRROR FRESHNESS (the AutoCount side is only as current as these) ===");
  log(`AutoCount DO mirror  (autocount_delivery_orders): ${doFresh.n} rows, newest synced_at ${doFresh.latest ?? "(never)"}`);
  log(`AutoCount SO snapshot(ac_snapshot_sales_orders) : ${soN.n} rows, newest snapshot_at ${soN.latest ?? "(never)"}`);
  for (const r of runs) log(`   snapshot run: kind=${r.kind} status=${r.status} stored=${r.stored} finished=${r.finished_at ?? "(running)"}`);

  // 2) The reported document, both sides, every date column.
  log(`\n=== THE REPORTED DOCUMENT: anything matching "${NEEDLE}" ===`);
  const soRows = await sql`
    SELECT doc_no, so_date, amended_delivery_date, linked_ac_docno
      FROM scm.mfg_sales_orders WHERE doc_no ILIKE ${"%" + NEEDLE + "%"} LIMIT 20`;
  if (soRows.length === 0) log(`(no ERP sales order matches "${NEEDLE}")`);
  for (const r of soRows) {
    const [ld] = await sql`
      SELECT min(line_delivery_date) AS min_dd, max(line_delivery_date) AS max_dd
        FROM scm.mfg_sales_order_items WHERE doc_no = ${r.doc_no} AND cancelled = false`;
    log(`ERP SO ${r.doc_no}: so_date(doc)=${d(r.so_date)} line_delivery=${d(ld?.min_dd)}..${d(ld?.max_dd)} amended_delivery=${d(r.amended_delivery_date)} -> book ${r.linked_ac_docno ?? "(unlinked)"}`);
    if (r.linked_ac_docno) {
      const [b] = await sql`SELECT doc_date, raw FROM public.ac_snapshot_sales_orders WHERE doc_no = ${r.linked_ac_docno}`;
      if (b) log(`   AutoCount SO ${r.linked_ac_docno}: doc_date=${d(b.doc_date)} DeliveryDate=${d(rawDate(b.raw, "DeliveryDate"))} ProcessingDate=${d(rawDate(b.raw, "ProcessingDate"))}`);
      else log(`   AutoCount SO ${r.linked_ac_docno}: NOT in the SO snapshot (filtered out, or the snapshot predates it)`);
    }
  }
  const doRows = await sql`
    SELECT do_number, do_date, shipout_date, customer_delivered_date, linked_ac_docno
      FROM scm.delivery_orders WHERE do_number ILIKE ${"%" + NEEDLE + "%"} LIMIT 20`;
  if (doRows.length === 0) log(`(no ERP delivery order matches "${NEEDLE}")`);
  for (const r of doRows) {
    log(`ERP DO ${r.do_number}: do_date(doc)=${d(r.do_date)} shipout=${d(r.shipout_date)} customer_delivered=${d(r.customer_delivered_date)} -> book ${r.linked_ac_docno ?? "(unlinked)"}`);
    if (r.linked_ac_docno) {
      const [b] = await sql`SELECT doc_date, cancelled FROM public.autocount_delivery_orders WHERE doc_no = ${r.linked_ac_docno}`;
      if (b) log(`   AutoCount DO ${r.linked_ac_docno}: doc_date=${d(b.doc_date)} cancelled=${b.cancelled}`);
      else log(`   AutoCount DO ${r.linked_ac_docno}: NOT in the DO mirror`);
    }
  }
  const byRef = await sql`SELECT doc_no, doc_date, ref, debtor_name FROM public.autocount_delivery_orders WHERE doc_no ILIKE ${"%" + NEEDLE + "%"} OR ref ILIKE ${"%" + NEEDLE + "%"} LIMIT 20`;
  for (const b of byRef) log(`AutoCount DO ${b.doc_no}: doc_date=${d(b.doc_date)} ref=${b.ref ?? ""} debtor=${b.debtor_name ?? ""}`);

  // 3) How WIDESPREAD is a document-date disagreement? Count our linked DOs and
  //    SOs whose doc date differs from the book's.
  log(`\n=== DOCUMENT-DATE DISAGREEMENT ACROSS ALL LINKED DOCUMENTS ===`);
  const [doGap] = await sql`
    SELECT count(*)::int AS matched,
           count(*) FILTER (WHERE left(d.do_date::text,10) <> left(a.doc_date,10))::int AS differ
      FROM scm.delivery_orders d
      JOIN public.autocount_delivery_orders a ON a.doc_no = d.linked_ac_docno
     WHERE d.do_date IS NOT NULL AND a.doc_date IS NOT NULL`;
  log(`DO: ${doGap.differ} of ${doGap.matched} linked delivery orders have do_date != AutoCount doc_date`);
  const doSamples = await sql`
    SELECT d.do_number, left(d.do_date::text,10) AS ours, left(a.doc_date,10) AS book
      FROM scm.delivery_orders d
      JOIN public.autocount_delivery_orders a ON a.doc_no = d.linked_ac_docno
     WHERE d.do_date IS NOT NULL AND a.doc_date IS NOT NULL
       AND left(d.do_date::text,10) <> left(a.doc_date,10)
     ORDER BY d.do_date DESC LIMIT 15`;
  for (const r of doSamples) log(`   DO ${r.do_number}: ours ${r.ours} vs book ${r.book}`);

  const [soGap] = await sql`
    SELECT count(*)::int AS matched,
           count(*) FILTER (WHERE left(s.so_date::text,10) <> left(a.doc_date,10))::int AS differ
      FROM scm.mfg_sales_orders s
      JOIN public.ac_snapshot_sales_orders a ON a.doc_no = s.linked_ac_docno
     WHERE s.so_date IS NOT NULL AND a.doc_date IS NOT NULL`;
  log(`SO: ${soGap.differ} of ${soGap.matched} linked sales orders have so_date != AutoCount doc_date`);
  const soSamples = await sql`
    SELECT s.doc_no, left(s.so_date::text,10) AS ours, left(a.doc_date,10) AS book
      FROM scm.mfg_sales_orders s
      JOIN public.ac_snapshot_sales_orders a ON a.doc_no = s.linked_ac_docno
     WHERE s.so_date IS NOT NULL AND a.doc_date IS NOT NULL
       AND left(s.so_date::text,10) <> left(a.doc_date,10)
     ORDER BY s.so_date DESC LIMIT 15`;
  for (const r of soSamples) log(`   SO ${r.doc_no}: ours ${r.ours} vs book ${r.book}`);

  await sql.end();
  log("\nDONE (read-only).");
}
main().catch((e) => { console.error(e); process.exit(1); });
