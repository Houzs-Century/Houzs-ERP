#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-delivered-but-open — the orders AutoCount considers DELIVERED that are
// still open demand in the ERP.
//
// THE QUESTION (owner, 2026-08-31): 「那么久了的单确定没有 DO？没有出货？」 The
// first answer counted DO lines that carry the LINK back to the sales line, and
// unlinked delivery lines exist in this system — so that count answered a
// different question. This one asks the BOOK: `ac-fidelity-so-lines.json.gz`
// carries `TransferedQty` per AutoCount line, which is the account book's own
// record of how much of that line has gone out.
//
// Measured 2026-08-31 on company 1: of 4,186 lines on orders older than 12
// months, **123 are FULLY delivered per the book and still open here** (plus 10
// partly). Those are ours to close.
//
// IT WRITES NOTHING, AND IT DELIBERATELY DOES NOT CLOSE THEM. Marking an order
// delivered in the ERP without the stock movements that delivery makes would put
// the warehouse figure wrong -- the goods left in AutoCount, not here, so there
// is no OUT movement to point at. Closing these is a decision with a stock
// consequence, and it belongs to a person.
//
// THE LIST GOES TO A CSV ARTIFACT, not to the log: this repository is public and
// its Actions logs are readable, so the log gets counts and the artifact gets
// document numbers and line counts (and nothing else — no customer, no amount).
//
//   DATABASE_URL   required
//   COMPANY_ID     default 1
//   OUT            csv path (default delivered-but-open.csv)
//
// RE-RUN: idempotent and side-effect free.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const OUT = process.env.OUT ?? 'delivered-but-open.csv';
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });
const DONE = ['CANCELLED', 'COMPLETED', 'CLOSED', 'DELIVERED', 'FULLY_DELIVERED'];

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const snap = JSON.parse(zlib.gunzipSync(
    fs.readFileSync(path.join(here, 'data', 'ac-fidelity-so-lines.json.gz'))).toString('utf8'));
  const rows = Array.isArray(snap) ? snap : Object.values(snap);
  const byKey = new Map(rows.map((r) => [String(r.DtlKey), r]));
  const man = JSON.parse(fs.readFileSync(path.join(here, 'data', 'ac-fidelity-manifest.json'), 'utf8'));
  log(`company ${CO}; account-book snapshot ${man.exported_at}, ${rows.length} lines`);

  const live = await sql`
    SELECT i.id, i.doc_no, i.linked_ac_dtlkey AS k, COALESCE(i.qty, 0)::numeric AS qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.cancelled = false
       AND upper(h.status::text) <> ALL(${DONE})`;

  const full = [], part = [];
  for (const r of live) {
    if (r.k == null) continue;
    const b = byKey.get(String(r.k));
    if (!b) continue;
    const q = Number(b.Qty ?? 0);
    const t = Number(b.TransferedQty ?? 0);
    if (t <= 0) continue;
    (t >= q ? full : part).push({ doc: r.doc_no, qty: Number(r.qty), bookQty: q, transferred: t });
  }

  const docsOf = (list) => [...new Set(list.map((x) => x.doc))];
  log(`live SO lines examined: ${live.length}`);
  log(`  the book says FULLY delivered:  ${full.length} line(s) on ${docsOf(full).length} order(s)`);
  log(`  the book says PARTLY delivered: ${part.length} line(s) on ${docsOf(part).length} order(s)`);
  log('');
  log('NOTHING WAS CHANGED. These are not closed automatically: marking an order');
  log('delivered here without the stock movements that a delivery makes would put the');
  log('warehouse figure wrong — the goods left in AutoCount, not here. Closing them is');
  log('a decision with a stock consequence, and it belongs to a person.');

  const lines = ['doc_no,state,erp_qty,book_qty,book_transferred'];
  for (const x of full) lines.push(`${x.doc},fully_delivered,${x.qty},${x.bookQty},${x.transferred}`);
  for (const x of part) lines.push(`${x.doc},partly_delivered,${x.qty},${x.bookQty},${x.transferred}`);
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  log(`wrote ${OUT} — ${lines.length - 1} row(s). Document numbers and quantities only.`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
