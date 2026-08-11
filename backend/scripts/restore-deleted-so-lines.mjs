#!/usr/bin/env node
// Put back the two sales-order lines that production run 31393696809 DELETED,
// as CANCELLED rows — not as live ones.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Owner rule, 2026-08-10: "不可以删只可以 cancel" — nothing may be deleted, only
// cancelled. apply-sofa-compartment-corrections.mjs has a DELETE branch for a
// surplus piece, and on 2026-08-10 13:37Z it used it twice:
//
//   HC-SO-012624  9050  1S+2S+2S -> 1A(LHF)+2A(RHF)   one 9050-2S deleted
//   HC-SO-013167  8030  2S+2S+1S -> 2A(LHF)+1A(RHF)   one 8030-1S deleted
//
// Confirmed against the DATABASE, not the log (diag-sofa-cutover-residue.mjs
// section E, run 31415710647): each document now holds exactly 2 live sofa
// lines and NO cancelled third. The rows are gone.
//
// The rule postdates the run, so this is not the script's fault; it is still
// the owner's data missing from his own order history.
//
// ── WHY RESTORING IS SAFE, AND HOW THAT IS PROVED RATHER THAN ASSERTED ──────
// The importer puts the whole build's price on the FIRST piece and 0 on every
// other, and apply-sofa-compartment-corrections.mjs aborts a build outright if
// the total would move (:149). Both deletions went through, so both deleted
// rows carried total_centi = 0. Restoring them at 0, CANCELLED, therefore
// changes no total in either direction.
//
// That is the argument. This script does not rely on it:
//
//   1. It snapshots the ENTIRE sales-order header row as jsonb before the
//      insert and again after it, inside the same transaction, and compares
//      every key. Not just a total column someone remembered — every key.
//   2. It also compares SUM(total_centi) and SUM(balance_centi) over all lines
//      and over non-cancelled lines only, so it cannot be fooled by a rollup
//      that filters cancelled rows.
//   3. If ANYTHING moved, it ROLLS THE TRANSACTION BACK and reports. The
//      brief's instruction is to stop, not to reconcile.
//
// The row is inserted CANCELLED so the piece set and every readiness / board /
// allocation query — all of which filter cancelled = false — see exactly what
// they see today. The document gains history and nothing else.
//
// DRY-RUN by default; APPLY=1 writes. Idempotent: a build that already holds a
// row with the restored code, live or cancelled, is skipped.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/* Reconstructed from run 31393696809's own log lines plus the surviving sibling
   rows on each document. `before` is what the log printed the build held; the
   correction paired target pieces to rows in line_no order and deleted what was
   left over, so the deleted piece is the trailing duplicate named in `piece`. */
const DELETED = [
  {
    doc: "HC-SO-012624", model: "9050", piece: "2S",
    before: "1S+2S+2S", target: "1A(LHF)+2A(RHF)",
    run: "31393696809", at: "2026-08-10T13:37:26Z",
  },
  {
    doc: "HC-SO-013167", model: "8030", piece: "1S",
    before: "2S+2S+1S", target: "2A(LHF)+1A(RHF)",
    run: "31393696809", at: "2026-08-10T13:37:31Z",
  },
];

const REMARK = (d) => `restored 2026-08-11 as CANCELLED: this ${d.model}-${d.piece} was on the order as part of ` +
  `${d.model} ${d.before} and was hard-DELETED by apply-sofa-compartment-corrections.mjs in run ${d.run} ` +
  `(${d.at}) when the build was corrected to ${d.target}. It carried 0 price then and carries 0 now, so no ` +
  `total moves. Reinstated CANCELLED, never live, under the owner's rule 不可以删只可以 cancel.`;

/* Every key of both jsonb snapshots, so a column nobody thought of cannot move
   silently. Timestamps that the write itself is expected to bump are named and
   excluded rather than quietly ignored. */
const IGNORE = new Set(["updated_at", "version", "edited_at", "last_edited_at"]);
function diffJson(before, after) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const moved = [];
  for (const k of keys) {
    if (IGNORE.has(k)) continue;
    const a = JSON.stringify(before?.[k] ?? null), b = JSON.stringify(after?.[k] ?? null);
    if (a !== b) moved.push(`${k}: ${a} -> ${b}`);
  }
  return moved;
}

async function totals(tx, doc) {
  const [h] = await tx`SELECT to_jsonb(h) AS h FROM scm.mfg_sales_orders h WHERE h.doc_no = ${doc} AND h.company_id = ${CO}`;
  const [t] = await tx`SELECT
        COUNT(*)::int                                                     AS lines_all,
        COUNT(*) FILTER (WHERE NOT cancelled)::int                        AS lines_live,
        COALESCE(SUM(total_centi), 0)::bigint                             AS total_all,
        COALESCE(SUM(total_centi) FILTER (WHERE NOT cancelled), 0)::bigint AS total_live,
        COALESCE(SUM(balance_centi), 0)::bigint                            AS balance_all,
        COALESCE(SUM(balance_centi) FILTER (WHERE NOT cancelled), 0)::bigint AS balance_live
      FROM scm.mfg_sales_order_items WHERE doc_no = ${doc} AND company_id = ${CO}`;
  return { header: h?.h ?? null, sums: t };
}

const sumLine = (s) => `lines ${s.lines_all} (live ${s.lines_live}) · total_centi all ${s.total_all} / live ${s.total_live}` +
  ` · balance_centi all ${s.balance_all} / live ${s.balance_live}`;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  /* Assume nothing about symmetry — scm.purchase_order_items has no `cancelled`
     column at all, so this check is the difference between a restore and a
     42703 halfway through one. */
  const [{ n: hasCancelled }] = await sql`SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_items' AND column_name = 'cancelled'`;
  if (!hasCancelled) {
    log("scm.mfg_sales_order_items has NO `cancelled` column. A restore would have to insert a LIVE row,");
    log("which changes the piece set. REFUSING — add the column in a migration first.");
    await sql.end(); return;
  }
  log("scm.mfg_sales_order_items.cancelled exists — a row can be reinstated cancelled, with no schema change.");

  let restored = 0, skipped = 0, refused = 0;
  for (const d of DELETED) {
    const code = `${d.model}-${d.piece}`;
    log("");
    log(`── ${d.doc}  ${d.model}  ${d.before} -> ${d.target}   restoring ${code}`);

    const rows = await sql`SELECT id::text AS id, item_code, line_no, qty, cancelled, total_centi,
                                  description2, variants, uom, location, photo_urls, item_group
                             FROM scm.mfg_sales_order_items
                            WHERE doc_no = ${d.doc} AND company_id = ${CO} AND item_group = 'sofa'
                            ORDER BY line_no`;
    if (!rows.length) { log("   REFUSED — the document holds no sofa lines at all."); refused++; continue; }
    for (const r of rows) log(`   now: line ${r.line_no}  ${r.item_code}  qty=${r.qty}  total_centi=${r.total_centi}  cancelled=${r.cancelled}`);

    if (rows.some((r) => norm(r.item_code) === norm(code))) {
      log(`   SKIP — a ${code} row is already on this document. Nothing to restore (idempotent).`);
      skipped++; continue;
    }
    /* Copy the shape from a SIBLING of the same build rather than inventing it:
       uom, location, photo_urls and the AutoCount text belong to the build, not
       to the piece. The variants copied are the build's CURRENT ones and the
       remark says so — reconstructing pre-correction variants would be
       fabrication, and this row's job is to record that the piece existed. */
    const sib = rows[0];
    const [prod] = await sql`SELECT name FROM scm.mfg_products WHERE company_id = ${CO} AND upper(code) = ${norm(code)} LIMIT 1`;
    if (!prod) log(`   note: ${code} is not in scm.mfg_products; the description falls back to the code itself.`);
    const desc = prod?.name ?? code;

    const before = await totals(sql, d.doc);
    log(`   BEFORE  ${sumLine(before.sums)}`);
    log(`   plan: INSERT ${code} qty=${sib.qty} unit_price_centi=0 total_centi=0 balance_centi=0 cancelled=TRUE` +
        ` line_no=MAX+1 description="${desc}"`);
    if (!APPLY) { log("   DRY-RUN — not written."); continue; }

    let outcome = null;
    try {
      await sql.begin(async (tx) => {
        const [ins] = await tx`INSERT INTO scm.mfg_sales_order_items
            (doc_no, line_no, item_group, item_code, description, description2, uom, location, qty,
             unit_price_centi, total_centi, balance_centi, company_id, variants, remark, photo_urls, cancelled)
          SELECT i.doc_no,
                 (SELECT COALESCE(MAX(line_no), 0) + 1 FROM scm.mfg_sales_order_items WHERE doc_no = i.doc_no AND company_id = ${CO}),
                 'sofa', ${code}, ${desc}, i.description2, i.uom, i.location, i.qty,
                 0, 0, 0, ${CO}, i.variants, ${REMARK(d)}, i.photo_urls, true
            FROM scm.mfg_sales_order_items i WHERE i.id = ${sib.id}::uuid
          RETURNING id::text AS id, line_no`;
        const after = await totals(tx, d.doc);
        const hdrMoved = diffJson(before.header, after.header);
        const sumMoved = Object.keys(before.sums)
          .filter((k) => k !== "lines_all")
          .filter((k) => String(before.sums[k]) !== String(after.sums[k]))
          .map((k) => `${k}: ${before.sums[k]} -> ${after.sums[k]}`);
        outcome = { id: ins.id, line_no: ins.line_no, after, hdrMoved, sumMoved };
        if (hdrMoved.length || sumMoved.length) {
          outcome.rolledBack = true;
          throw new Error("MONEY_MOVED");
        }
      });
    } catch (e) {
      if (e.message === "MONEY_MOVED") {
        log("   ROLLED BACK — restoring this row would have moved something. Nothing was written.");
        for (const m of outcome.hdrMoved) log(`     header ${m}`);
        for (const m of outcome.sumMoved) log(`     line sums ${m}`);
        log("   STOPPING on this document per the brief: a restore that moves a total is not a restore.");
        refused++; continue;
      }
      throw e;
    }
    log(`   APPLIED — row ${outcome.id} at line ${outcome.line_no}, CANCELLED.`);
    log(`   AFTER   ${sumLine(outcome.after.sums)}`);
    log("   header row: every key identical apart from the ignored edit timestamps.");
    restored++;
  }

  /* A log line is not evidence. refresh-sofa-colours.mjs printed APPLIED three
     times while writing nothing, so read the rows back on a fresh statement. */
  log("");
  log("── INDEPENDENT READ-BACK (a fresh SELECT, not the writer's own return value)");
  for (const d of DELETED) {
    const rows = await sql`SELECT line_no, item_code, qty, unit_price_centi, total_centi, balance_centi, cancelled
                             FROM scm.mfg_sales_order_items
                            WHERE doc_no = ${d.doc} AND company_id = ${CO} AND item_group = 'sofa'
                            ORDER BY line_no`;
    const t = await totals(sql, d.doc);
    log(`   ${d.doc}: ${rows.length} sofa line(s)`);
    for (const r of rows) log(`     line ${r.line_no}  ${r.item_code}  qty=${r.qty}  unit=${r.unit_price_centi}  total=${r.total_centi}  balance=${r.balance_centi}  cancelled=${r.cancelled}`);
    log(`     ${sumLine(t.sums)}`);
    const live = rows.filter((r) => !r.cancelled).length;
    log(`     live ${live} / cancelled ${rows.length - live} — the live piece set is unchanged if live is still 2.`);
  }

  log("");
  log(`restored ${restored} · already present ${skipped} · refused ${refused}`);
  if (!APPLY) log("DRY-RUN — nothing was written. Set APPLY=1 to restore.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
