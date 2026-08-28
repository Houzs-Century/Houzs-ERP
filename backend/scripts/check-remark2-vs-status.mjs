#!/usr/bin/env node
// The owner's closing question of the 2026-08-28 re-import round: once the
// data is aligned, the system's COMPUTED stock status should agree with what
// staff hand-wrote in the book's Remark2 (READY / MATTRESS/ACC / ...). This
// check MEASURES that agreement instead of asserting it.
//
// Read-only. For every imported company-1 order it compares:
//   the staff CLAIM  — remark2 (imported byte-for-byte from the book), classed
//                      READY / READY-PARTIAL / CATEGORY (MATTRESS/ACC/BEDFRAME
//                      combos = "that part is ready") / OTHER free text
//   the system VIEW  — its non-service lines' computed stock_status rollup:
//                      ALL-READY / SOME-READY / NONE-READY
// and prints the matrix plus the actionable list: orders where staff wrote
// READY but the system covers nothing — either a real stock discrepancy or a
// matching gap, and each doc number is checkable by hand.
//
// A disagreement is a FINDING to read, not an error: staff notes age, stock
// moves, and the computed side only lit up after the allocation recompute.
// Exit 0 for every verdict; non-zero only for an unreachable DB.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

function classifyClaim(r) {
  const s = (r || "").trim().toUpperCase();
  if (!s) return null;
  if (s === "READY") return "READY";
  if (/^READY\s*\(PARTIAL\)/.test(s)) return "READY-PARTIAL";
  if (/^(MATTRESS|BEDFRAME|ACC)([/ ]+(MATTRESS|BEDFRAME|ACC))*$/.test(s.replace(/\s+/g, ""))) return "CATEGORY";
  return "OTHER";
}

async function main() {
  const rows = await sql`
    SELECT h.doc_no, h.remark2,
           COUNT(*) FILTER (WHERE i.item_group NOT IN ('service')) AS stock_lines,
           COUNT(*) FILTER (WHERE i.item_group NOT IN ('service') AND i.stock_status = 'READY') AS ready_lines
    FROM scm.mfg_sales_orders h
    JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no AND i.cancelled = false
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
      AND UPPER(h.status::text) NOT IN ('CANCELLED', 'COMPLETED')
    GROUP BY h.doc_no, h.remark2`;
  log(`imported live orders measured: ${rows.length}`);

  const matrix = new Map();
  const staffReadySystemNone = [];
  let claimed = 0;
  for (const r of rows) {
    const claim = classifyClaim(r.remark2);
    if (!claim) continue;
    claimed++;
    const nStock = Number(r.stock_lines), nReady = Number(r.ready_lines);
    const view = nStock === 0 ? "NO-STOCK-LINES" : nReady === 0 ? "NONE-READY" : nReady === nStock ? "ALL-READY" : "SOME-READY";
    const k = `${claim} | ${view}`;
    matrix.set(k, (matrix.get(k) || 0) + 1);
    if (claim === "READY" && view === "NONE-READY") staffReadySystemNone.push(r.doc_no);
  }
  log(`orders where staff wrote a status: ${claimed}`);
  for (const [k, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) log(`  ${k.padEnd(34)} ${n}`);
  log(`ACTIONABLE — staff wrote READY, system covers no line: ${staffReadySystemNone.length}`);
  for (const d of staffReadySystemNone.slice(0, 20)) log(`   ${d}`);
  if (staffReadySystemNone.length > 20) log(`   ... and ${staffReadySystemNone.length - 20} more`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
