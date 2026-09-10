#!/usr/bin/env node
/* check-sofa-code-vs-description - sofa lines whose ITEM CODE and DESCRIPTION
 * disagree about the piece. READ-ONLY. SELECTs only, no writes, no DDL, no
 * transaction.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * The owner, 2026-09-10, on HC-SO-012016: 「为什么外面2AR 里面2AL？而且9028 和
 * verano 全部不统一的？什么问题呢这是那2我下PO的时候不是更加危险」 - the sales
 * order list shows one hand and the edit form shows the other, and he is about
 * to raise a purchase order off one of them.
 *
 * Read from production (diag-so-erp-build run 34455923085), the two screens are
 * both right; the ROW is self-contradictory:
 *
 *     #1  item_code 9028-2A(RHF)   description "SOFA VERANO 2A(LHF)"
 *     #2  item_code 9028-CNR       description "SOFA VERANO CNR"
 *     #3  item_code 9028-1A(LHF)   description "SOFA VERANO 1A(RHF)"
 *
 * One surface renders `item_code`, the other the stored description, and on
 * that document they are MIRRORS of each other. A hand was swapped in one
 * column and not in the other. Whichever the factory reads, the other half of
 * the system disagrees with it, and nothing in the ERP says which is right.
 *
 * ── WHAT IT COUNTS ─────────────────────────────────────────────────────────
 *   HAND DISAGREES - the code says (LHF) and the description says (RHF), or the
 *   reverse. This is the dangerous one: it is a different physical sofa.
 *
 *   PIECE DISAGREES - the code says CNR and the description says 1NA. Different
 *   part, same danger, different cause.
 *
 *   CODE SILENT / DESCRIPTION SILENT - one of them states no hand at all. Not a
 *   contradiction, and counted apart so the headline is not inflated by rows
 *   where there is simply nothing to compare.
 *
 *   MODEL NAME - the owner's second question. `9028` is the code and
 *   "SOFA VERANO" is the name, so a description naming a DIFFERENT model is a
 *   separate defect from a description naming a different HAND. The two are
 *   counted apart rather than lumped as "inconsistent".
 *
 * It answers no question about which side is right. On a PROCEEDED order the
 * supplier's listing settles that (owner: 「supplier的肯定对的」); this is the
 * census that says how many need settling.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   LIST_LIMIT     optional, default 60
 *   TABLES         optional: SO,PO,DO. Default all three - the drift matters
 *                  most on the PURCHASE order, which is what the factory reads.
 */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Number(process.env.LIST_LIMIT || 60);
const WANT = new Set(String(process.env.TABLES || 'SO,PO,DO').toUpperCase().split(',').map((s) => s.trim()));

const line = (s = '') => console.log(`::notice::${s}`);
const rule = () => line('-'.repeat(78));
const head = (s) => { line('='.repeat(78)); line(s); line('='.repeat(78)); };

const up = (s) => String(s ?? '').trim().toUpperCase();
/* The compartment a CODE names: 9028-2A(RHF) -> 2A(RHF). */
const pieceOfCode = (code) => { const s = up(code); const i = s.indexOf('-'); return i < 0 ? s : s.slice(i + 1); };
/* The hand a string states, or null when it states none. Read from either
   column with the same reader, so a difference cannot come from two readers. */
const handOf = (s) => {
  const m = up(s).match(/\((LHF|RHF)\)/);
  return m ? m[1] : null;
};
/* The compartment a DESCRIPTION names. "SOFA VERANO 2A(LHF)" -> 2A(LHF). The
   last whitespace-separated token, which is where every sofa description in
   this book puts it. */
const pieceOfDesc = (desc) => {
  const t = up(desc).split(/\s+/).filter(Boolean);
  return t.length ? t[t.length - 1] : '';
};

/* Self-test both readers before reporting. A checker that cannot match reports
   a clean run - three of this repo's checkers have done exactly that. */
{
  const cases = [
    [handOf('9028-2A(RHF)'), 'RHF'],
    [handOf('SOFA VERANO 2A(LHF)'), 'LHF'],
    [handOf('9028-CNR'), null],
    [pieceOfCode('9028-1A(LHF)'), '1A(LHF)'],
    [pieceOfCode('SQUARE PILLOW'), 'SQUARE PILLOW'],
    [pieceOfDesc('SOFA VERANO 1A(RHF)'), '1A(RHF)'],
    [pieceOfDesc('SOFA 9028 CNR'), 'CNR'],
  ];
  for (const [got, want] of cases) {
    if (got !== want) {
      console.error(`SELF-TEST FAILED: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}. `
        + 'Refusing to report from a dead reader.');
      process.exit(1);
    }
  }
}

const SPECS = [
  { key: 'SO', what: 'sales order', table: 'scm.mfg_sales_order_items', desc: 'description',
    join: 'JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no', docCol: 'i.doc_no' },
  { key: 'PO', what: 'PURCHASE order  <- this is what the factory reads', table: 'scm.purchase_order_items', desc: 'material_name',
    join: 'JOIN scm.purchase_orders h ON h.id = i.purchase_order_id', docCol: 'h.po_number' },
  { key: 'DO', what: 'delivery order', table: 'scm.delivery_order_items', desc: 'description',
    join: 'JOIN scm.delivery_orders h ON h.id = i.delivery_order_id', docCol: 'h.do_number' },
];

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  head('SOFA LINES WHOSE CODE AND DESCRIPTION DISAGREE');
  line(`   company ${CO}. One reader is used on both columns, so a difference cannot come`);
  line('   from two readers disagreeing. Cancelled lines excluded.');

  let grandHand = 0;
  for (const spec of SPECS) {
    if (!WANT.has(spec.key)) continue;
    const rows = await sql.unsafe(
      `SELECT ${spec.docCol} AS doc, i.item_code AS code, i.${spec.desc} AS descr
         FROM ${spec.table} i ${spec.join}
        WHERE h.company_id = $1
          AND lower(coalesce(i.item_group, '')) = 'sofa'
          AND coalesce(i.cancelled, false) = false
        ORDER BY 1`, [CO]);

    const handBad = []; const pieceBad = []; let codeSilent = 0; let descSilent = 0; let agree = 0;
    for (const r of rows) {
      const hc = handOf(r.code); const hd = handOf(r.descr);
      if (hc && hd && hc !== hd) { handBad.push(r); continue; }
      if (!hc && hd) { descSilent += 1; continue; }
      if (hc && !hd) { codeSilent += 1; continue; }
      const pc = pieceOfCode(r.code); const pd = pieceOfDesc(r.descr);
      if (pc && pd && pc !== pd) { pieceBad.push(r); continue; }
      agree += 1;
    }

    rule();
    line(`${spec.key} - ${spec.what}   ${rows.length} sofa line(s)`);
    rule();
    line(`   HAND DISAGREES (a different physical sofa)   ${handBad.length}`);
    line(`   piece disagrees (different part)             ${pieceBad.length}`);
    line(`   the code states no hand, the description does ${descSilent}`);
    line(`   the description states no hand, the code does ${codeSilent}`);
    line(`   agree                                        ${agree}`);
    grandHand += handBad.length;

    for (const r of handBad.slice(0, LIMIT)) {
      line(`      ${String(r.doc).padEnd(16)} code ${String(r.code).padEnd(18)} description "${r.descr}"`);
    }
    if (handBad.length > LIMIT) line(`      ... and ${handBad.length - LIMIT} more`);
    for (const r of pieceBad.slice(0, Math.max(0, LIMIT - handBad.length))) {
      line(`      [piece] ${String(r.doc).padEnd(16)} code ${String(r.code).padEnd(18)} description "${r.descr}"`);
    }
  }

  head(`READ-ONLY. Nothing was written. ${grandHand} line(s) state opposite hands.`);
  line('Which side is right is NOT decided here. On a proceeded order the supplier\'s');
  line('listing settles it (owner: 「supplier的肯定对的」); this says how many need it.');
} finally {
  await sql.end({ timeout: 5 });
}
