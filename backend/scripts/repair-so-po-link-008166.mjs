// Repair the ONE order where the purchase order carries the goods but both
// pieces of a two-piece line were linked to the same sales-order line, so its
// twin reads a false SHORT on the MRP page.
//
// THE OWNER, 2026-09-10, on HC-SO-008166: 「这个PO 都开了 你说没有order到？确定？」
// He was right. `check-so-po-coverage.mjs` (run 34484832417) and the CENSUS
// (run 34485530501) proved it: HC-PO-009974 carries 2x `9058-1NA`, exactly what
// the order needs, but BOTH `purchase_order_items.so_item_id` point at SO line
// `edada633`, leaving its twin `8d59fff0` with zero links -> MRP SHORT. It is
// the ONLY order in company 1 with this shape (1 of 2,900 SHORT lines; the rest
// are the normal not-yet-ordered backlog, world (a)).
//
// WHAT THIS DOES: moves ONE of the two `9058-1NA` PO lines from `edada633` to
// `8d59fff0`. No quantity, no money, no goods move — one foreign-key column on
// one purchase_order_items row. After it, each of the two 1NA SO lines has
// exactly one PO line, and the false SHORT is gone.
//
// It is scoped by IDENTITY, not by document, so it can only ever touch this one
// known row set — the pre-checks REFUSE if production does not match the shape
// the diagnosis proved, rather than "repairing" something else.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: REDISTRIBUTE-008166-1NA
//   COMPANY_ID     default 1
//
// RE-RUN: idempotent. Once one PO line points at 8d59fff0 the shape check sees
// the split is already correct and reports 0 to change.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'REDISTRIBUTE-008166-1NA';
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

const SO = 'HC-SO-008166';
const ITEM = '9058-1NA';
const PO = 'HC-PO-009974';

async function shape(sql) {
  // The two 1NA sales-order lines of this order.
  const soLines = await sql`
    SELECT i.id FROM scm.mfg_sales_order_items i
     WHERE i.company_id = ${CO} AND i.doc_no = ${SO}
       AND i.item_code = ${ITEM} AND i.cancelled = false
     ORDER BY i.id`;
  // The PO lines of that item on that PO, and where each points.
  const poLines = await sql`
    SELECT p.id, p.so_item_id
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders o ON o.id = p.purchase_order_id
     WHERE o.company_id = ${CO} AND o.po_number = ${PO} AND p.item_code = ${ITEM}
     ORDER BY p.id`;
  return { soLines: soLines.map((r) => r.id), poLines };
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}  ${SO} / ${ITEM} / ${PO}`);

  const { soLines, poLines } = await shape(sql);
  log(`  ${ITEM} sales-order lines on ${SO}: ${soLines.length}  (${soLines.map((s) => s.slice(0, 8)).join(', ')})`);
  for (const p of poLines) {
    log(`  PO line ${p.id.slice(0, 8)} -> SO ${p.so_item_id ? p.so_item_id.slice(0, 8) : 'NULL'}`);
  }

  // The shape the diagnosis proved: exactly 2 SO lines, exactly 2 PO lines, both
  // PO lines pointing at ONE of the SO lines. Refuse anything else.
  if (soLines.length !== 2 || poLines.length !== 2) {
    log(`SHAPE CHANGED — expected 2 SO lines and 2 PO lines, saw ${soLines.length}/${poLines.length}. `
      + `Refusing; the diagnosis no longer describes production.`);
    await sql.end();
    process.exit(APPLY ? 1 : 0);
  }
  const targets = new Set(poLines.map((p) => p.so_item_id));
  const [lineA, lineB] = soLines;
  const aCount = poLines.filter((p) => p.so_item_id === lineA).length;
  const bCount = poLines.filter((p) => p.so_item_id === lineB).length;

  if (targets.size === 2 && aCount === 1 && bCount === 1) {
    log('ALREADY SPLIT — each 1NA line has exactly one PO line. Nothing to change.');
    await sql.end();
    return;
  }
  // The overloaded line (2 links) and the starved line (0 links).
  const overloaded = aCount === 2 ? lineA : lineB;
  const starved = aCount === 2 ? lineB : lineA;
  if (poLines.filter((p) => p.so_item_id === overloaded).length !== 2) {
    log('UNEXPECTED — not the both-on-one-line shape. Refusing.');
    await sql.end();
    process.exit(APPLY ? 1 : 0);
  }
  const moveLine = poLines.find((p) => p.so_item_id === overloaded);
  log('');
  log(`PLAN: move PO line ${moveLine.id.slice(0, 8)} from SO ${overloaded.slice(0, 8)} (has 2) `
    + `to SO ${starved.slice(0, 8)} (has 0). One column, one row.`);

  if (!APPLY) {
    log('');
    log(`PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    await sql.end();
    return;
  }

  const res = await sql`
    UPDATE scm.purchase_order_items
       SET so_item_id = ${starved}, updated_at = NOW()
     WHERE id = ${moveLine.id} AND so_item_id = ${overloaded}
     RETURNING id`;
  log('');
  log(`rows updated: ${res.length}`);
  await sql.end();

  // Verify on a FRESH connection, and assert the SHAPE — one PO line per SO line.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = await shape(check);
  const a2 = after.poLines.filter((p) => p.so_item_id === lineA).length;
  const b2 = after.poLines.filter((p) => p.so_item_id === lineB).length;
  await check.end();
  log(`VERIFY (fresh connection): SO ${lineA.slice(0, 8)} now has ${a2} PO line(s), `
    + `SO ${lineB.slice(0, 8)} now has ${b2}.`);
  if (a2 === 1 && b2 === 1) {
    log('SHAPE OK — each 1NA sales-order line now carries exactly one PO line. The false SHORT is gone.');
  } else {
    log('SHAPE WRONG — investigate; the split did not land 1/1.');
    process.exit(1);
  }
}

await main();
