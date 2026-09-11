#!/usr/bin/env node
// EVERY column that states a sofa piece must state the piece the ITEM CODE
// states - on every document, not just the four that were swept first.
//
// THE OWNER, 2026-09-11, on HC-PO-2609-053: 「我说的是 PDF 跟里面内容不一样，你看
// 为什么那么奇怪？」 and then 「你查看一下全套系统，看有没有类似的问题，都要同一
// 时间解决掉」. He is right that it is odd: the screen shows our
// `8030-1A(LHF)`, and the PDF's Supplier Code column - the one the factory
// builds from - says `5540-L(LHF)`. The build's two end pieces are exchanged.
//
// ROOT CAUSE, traced not guessed. Nothing crossed them at convert time: the
// master binding is CORRECT (`8030-1A(LHF)` -> `5540-1A(LHF)` for Hookka
// Industries), and `scm.entity_audit_log` holds exactly ONE entry for that PO -
// CREATE, 2026-09-10 02:53, never edited. So the convert copied the supplier
// code from the SALES ORDER line's code as it stood then, and the code was
// corrected afterwards. `repair-sofa-line-name-to-code.mjs` [gone] (2026-09-11)
// taught the corrections applier and the in-place rename tool to move the
// printed NAME with the code - and no writer has ever moved `supplier_sku`.
//
// MEASURED ACROSS THE WHOLE SYSTEM, production 2026-09-11 - 14 line tables,
// every column a surface shows:
//
//   sales order      name          0   (swept 2026-09-11)
//   delivery order   name          0   (swept)
//   goods received   name          0   (swept, 11 corrected)
//   purchase order   supplier code 24  <- never swept, and the factory reads it
//   goods received   supplier code 13  <- never swept
//   purchase invoice name          7   <- this table had no arm at all
//   purchase order   material_name 4   (its `description` holds the supplier's
//                                       own model name, so the earlier sweep
//                                       looked at that column and left this one)
//   sales invoice, purchase return, delivery return, and all six consignment
//   tables                         0
//
// WHY IT SUPERSEDES THE EARLIER SCRIPT rather than sitting beside it: that one
// examines ONE column per row (`description` when present, else
// `material_name`), which is right for what PRINTS and wrong for what is
// STORED - it is how the 4 purchase-order rows above were classified as "the
// supplier's own product name" while a stale piece sat in the column next to
// it. Two overlapping repairs over the same rows is the hazard this repo keeps
// paying for, so the old one is deleted in the same change.
//
// ONLY THE PIECE TOKEN MOVES. A supplier code keeps the supplier's own spelling
// (`HOK-5540 SOFA 2A(LHF)` -> `HOK-5540 SOFA 1A(LHF)`) rather than being
// replaced from a master row whose spelling has since changed - a document is a
// snapshot of what was sent. The rule and its self-test live in
// `backend/scripts/lib/sofa-piece-token.mjs`.
//
// A text that states NO piece is LEFT ALONE: that is the supplier's own product
// name ("HOK SOFA - 5536", "AMN SOFA - SF9058") and on a purchase document it is
// what belongs there - 373 purchase lines and 47 receipt lines read that way by
// design.
//
// CLOSED DOCUMENTS ARE CORRECTED TOO, by the owner's decision 2026-09-11 (he
// chose 甲 over leaving them listed): a received purchase order and a posted
// invoice are still read back and reconciled against, so a wrong piece left on
// them misleads a second time. It writes no money, no quantity, no status - one
// text column per row.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and
// CONFIRM="NAME THE PIECE THE CODE STATES".
// RE-RUN: convergent. A corrected column states its own piece, so the next run
// does not select it; the fresh-connection check asserts that SHAPE.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply
import postgres from 'postgres';
import { assertMatcherSane, disagrees, movePieceTo, pieceOf } from './lib/sofa-piece-token.mjs';

const CONFIRM_PHRASE = 'NAME THE PIECE THE CODE STATES';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}

/* The matcher answers before any row is read. */
try { assertMatcherSane(); } catch (e) { console.error(String(e.message)); process.exit(1); }

/* Every line table that a person or a supplier reads, the document number to
   print it under, and EVERY column on it that can state a piece. `item_group`
   scopes to sofas; `company_id` is on every one of these tables. */
const ARMS = [
  ['sales order', 'mfg_sales_order_items',
    'JOIN scm.mfg_sales_orders d ON d.doc_no = i.doc_no', 'd.doc_no',
    ['description']],
  ['purchase order', 'purchase_order_items',
    'JOIN scm.purchase_orders d ON d.id = i.purchase_order_id', 'd.po_number',
    ['description', 'material_name', 'supplier_sku']],
  ['goods received', 'grn_items',
    'JOIN scm.grns d ON d.id = i.grn_id', 'd.grn_number',
    ['description', 'material_name', 'supplier_sku']],
  ['delivery order', 'delivery_order_items',
    'JOIN scm.delivery_orders d ON d.id = i.delivery_order_id', 'd.do_number',
    ['description']],
  ['purchase invoice', 'purchase_invoice_items',
    'JOIN scm.purchase_invoices d ON d.id = i.purchase_invoice_id', 'd.invoice_number',
    ['description', 'material_name']],
  ['sales invoice', 'sales_invoice_items',
    'JOIN scm.sales_invoices d ON d.id = i.sales_invoice_id', 'd.invoice_number',
    ['description']],
  ['purchase return', 'purchase_return_items',
    'JOIN scm.purchase_returns d ON d.id = i.purchase_return_id', 'd.return_number',
    ['description', 'material_name']],
  ['delivery return', 'delivery_return_items',
    'JOIN scm.delivery_returns d ON d.id = i.delivery_return_id', 'd.return_number',
    ['description']],
  ['consignment SO', 'consignment_sales_order_items',
    '', 'i.doc_no', ['description']],
  ['consignment DO', 'consignment_delivery_order_items',
    'JOIN scm.consignment_delivery_orders d ON d.id = i.consignment_delivery_order_id', 'd.do_number',
    ['description']],
  ['consignment DO return', 'consignment_delivery_return_items',
    'JOIN scm.consignment_delivery_returns d ON d.id = i.consignment_delivery_return_id', 'd.return_number',
    ['description']],
  ['purch. consignment PO', 'purchase_consignment_order_items',
    'JOIN scm.purchase_consignment_orders d ON d.id = i.purchase_consignment_order_id', 'd.pc_number',
    ['description', 'material_name', 'supplier_sku']],
  ['purch. consignment recv', 'purchase_consignment_receive_items',
    'JOIN scm.purchase_consignment_receives d ON d.id = i.pc_receive_id', 'd.receive_number',
    ['description', 'material_name', 'supplier_sku']],
  ['purch. consignment ret', 'purchase_consignment_return_items',
    'JOIN scm.purchase_consignment_returns d ON d.id = i.purchase_consignment_return_id', 'd.return_number',
    ['description', 'material_name']],
];

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('EVERY COLUMN MUST STATE THE PIECE THE CODE STATES');
  line('='.repeat(78));
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN (no writes)'}`);

  const writes = [];
  const stats = [];
  for (const [name, table, join, docExpr, cols] of ARMS) {
    const sel = cols.map((c) => `i.${c} AS "${c}"`).join(', ');
    const rows = await sql.unsafe(`
      SELECT i.id, ${docExpr} AS doc, i.item_code AS code, ${sel}
        FROM scm.${table} i ${join}
       WHERE i.company_id = $1
         AND upper(coalesce(i.item_group, '')) = 'SOFA'`, [CO]);
    const per = {};
    for (const col of cols) {
      per[col] = 0;
      for (const r of rows) {
        if (!disagrees(r.code, r[col])) continue;
        per[col] += 1;
        writes.push({
          name, table, col, id: r.id, doc: r.doc, code: r.code,
          from: r[col], to: movePieceTo(r[col], pieceOf(r.code)),
        });
      }
    }
    stats.push({ name, rows: rows.length, per });
  }

  rule();
  for (const s of stats) {
    const bits = Object.entries(s.per).map(([c, n]) => `${c}=${n}`).join(' ');
    line(`   ${s.name.padEnd(24)} sofa lines ${String(s.rows).padStart(5)}   disagreeing: ${bits}`);
  }
  rule();
  line(`TO CORRECT: ${writes.length} column value(s) on ${new Set(writes.map((w) => w.doc)).size} document(s)`);
  for (const w of writes) {
    line(`   ${w.doc.padEnd(24)} ${w.code.padEnd(16)} ${w.col.padEnd(14)} ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`);
  }

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let wrote = 0;
    for (const w of writes) {
      /* One row at a time, with the OLD value in the WHERE: a row somebody
         edited between the plan and the write is left alone rather than
         overwritten from a stale reading. */
      const res = await sql.unsafe(
        `UPDATE scm.${w.table} SET ${w.col} = $1 WHERE id = $2 AND ${w.col} = $3`,
        [w.to, w.id, w.from],
      );
      if (Number(res.count ?? 0) === 1) wrote += 1;
      else line(`   SKIPPED ${w.doc} ${w.code} ${w.col}: the value changed since the plan was read`);
    }
    line(`APPLIED — ${wrote} of ${writes.length} column value(s) now state the piece their code states.`);

    /* VERIFY on a FRESH connection, and assert the SHAPE: re-read every row we
       touched and ask the same question again. A count of updates would be true
       even if the replacement had put the wrong piece in. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const bad = [];
      for (const w of writes) {
        const rows = await check.unsafe(
          `SELECT ${w.col} AS shown, item_code AS code FROM scm.${w.table} WHERE id = $1`, [w.id],
        );
        const r = rows[0];
        if (!r) { bad.push(`${w.doc} ${w.code} ${w.col}: row is gone`); continue; }
        if (disagrees(r.code, r.shown)) bad.push(`${w.doc} ${w.code} ${w.col}`);
      }
      if (bad.length) {
        line(`VERIFY FAILED — ${bad.length} value(s) still disagree: ${bad.slice(0, 8).join(', ')}`);
        process.exitCode = 1;
      } else {
        line(`VERIFY OK on a fresh connection — all ${writes.length} value(s) state the piece their code states.`);
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
