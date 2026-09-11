#!/usr/bin/env node
// The printed NAME of a sofa line must state the piece its ITEM CODE states.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE OWNER FOUND IT, 2026-09-11: 「为什么我们改了全部 SO PO 等等 exportPDF 出来
// 不一样？…正常来说我的 sku 是什么就显示什么啊？」 He is right, and the PDF proves
// him right: every document print puts the code and the name side by side —
// `sales-order-pdf.ts:572` prints `description ?? item_code`, `grn-pdf.ts:133`
// prints `description ?? material_name` beside `item_code`, and the customer-
// facing fold composes its "1B(LHF) + CNR + 2A(RHF)" line from the codes
// (`so-line-display.ts`). So a line whose code was corrected while its text kept
// the old piece prints two different sofas on one row.
//
// WHAT WENT STALE. The compartment corrections applier rewrites `item_code` and
// the line's own label, and the in-place rename tool rewrites `item_code` only —
// neither reaches a SIBLING text column. Measured on production 2026-09-11:
//   purchase lines   6 · goods-received lines 11 · sales 0 · delivery 0
// e.g. HC-PO-2609-053 holds `8030-L(RHF)` and prints "SOFA SOFFIO 1A(RHF)" —
// the lounger correction purchasing asked for that morning, half-landed.
//
// WHAT IT WILL NOT TOUCH, and this is most of the corpus. A name that states NO
// piece is the SUPPLIER'S OWN product name — "AMN SOFA - SF9058", "HOK SOFA -
// 5536", "DSL SOFA - 8030" — and on a purchase document that is what belongs
// there (a PO item code is the supplier's model: 373 purchase lines and 47
// receipt lines read this way by design). Only a name that NAMES A PIECE and
// names a DIFFERENT one is rewritten, and only the piece token moves: the model
// word keeps whatever it says.
//
// THE MATCHER SELF-TESTS BEFORE IT REPORTS. A first version's `\b` after `)`
// could not match `2A(LHF)` at all, so it reported 0 findings on 17 real ones —
// the "a checker that cannot match reports a clean run" trap this repo names in
// CLAUDE.md. The fixtures below run every time and refuse the script on failure.
//
// RE-RUN: convergent. A rewritten line states its own piece, so the next run
// does not select it.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: NAME THE PIECE THE CODE STATES
import postgres from 'postgres';

const CONFIRM_PHRASE = 'NAME THE PIECE THE CODE STATES';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
// The refusal lives AT the comparison, its exit adjacent.
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

/** `9058-2A(RHF)` -> `2A(RHF)`. The FIRST dash: a sofa code is model-piece. */
const pieceOf = (code) => {
  const s = String(code ?? '').trim().toUpperCase();
  const i = s.indexOf('-');
  return i < 0 ? s : s.slice(i + 1);
};
/* A piece token inside free text. No trailing \b — a token ending in `)` has no
   word boundary after it, which is exactly what broke the first matcher. */
const PIECE_RX = /(\d?[ABL]?\d?[A-Z]{0,3}\((?:LHF|RHF)\)|\bCNR\b|\bCONSOLE\b|\bSTOOL\b|\b\dS\b|\b\dNA\b)/i;
const squash = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');

{
  const names = ['SOFA VERANO 2A(LHF)', 'SOFA SOFFIO 1S', 'SOFA MAYBATCH 1NA', 'SOFA NOVA L(RHF)'];
  const products = ['AMN SOFA - SF9058', 'HOK SOFA - 5536', 'DSL SOFA - 8030'];
  const ok = names.every((s) => PIECE_RX.test(s)) && !products.some((s) => PIECE_RX.test(s))
    && pieceOf('9058-2A(RHF)') === '2A(RHF)'
    && 'SOFA VERANO 2A(LHF)'.replace(PIECE_RX, 'L(RHF)') === 'SOFA VERANO L(RHF)';
  if (!ok) { console.error('SELF-TEST FAILED on the piece matcher. Refusing to report.'); process.exit(1); }
}

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

/* The four line tables and the column each one PRINTS. `description` wins where
   both exist (that is the coalesce every PDF does), so that is the column to
   correct; a receipt line whose description is null prints material_name. */
const ARMS = [
  {
    name: 'sales order', table: 'mfg_sales_order_items', col: 'description',
    read: () => sql`SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.description AS shown
                      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
                     WHERE s.company_id = ${CO} AND upper(coalesce(i.item_group, '')) = 'SOFA'`,
  },
  {
    name: 'purchase order', table: 'purchase_order_items', col: null,   // resolved per row
    read: () => sql`SELECT i.id, p.po_number AS doc, i.item_code AS code,
                           i.description AS d, i.material_name AS m
                      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                     WHERE p.company_id = ${CO} AND upper(coalesce(i.item_group, '')) = 'SOFA'`,
  },
  {
    name: 'goods received', table: 'grn_items', col: null,
    read: () => sql`SELECT i.id, g.grn_number AS doc, i.item_code AS code,
                           i.description AS d, i.material_name AS m
                      FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
                     WHERE g.company_id = ${CO} AND upper(coalesce(i.item_group, '')) = 'SOFA'`,
  },
  {
    name: 'delivery order', table: 'delivery_order_items', col: 'description',
    read: () => sql`SELECT i.id, d.do_number AS doc, i.item_code AS code, i.description AS shown
                      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
                     WHERE d.company_id = ${CO} AND upper(coalesce(i.item_group, '')) = 'SOFA'`,
  },
];

try {
  line('='.repeat(78));
  line('THE PRINTED NAME MUST STATE THE PIECE THE CODE STATES');
  line('='.repeat(78));
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  const writes = [];
  const stats = [];
  for (const arm of ARMS) {
    const rows = await arm.read();
    let productName = 0;
    let agree = 0;
    const mine = [];
    for (const r of rows) {
      /* Which column this row PRINTS: description when it has one, else the
         material name — the coalesce every PDF performs. */
      const col = arm.col ?? (r.d !== null && r.d !== undefined && String(r.d).trim() !== '' ? 'description' : 'material_name');
      const shown = arm.col ? r.shown : (col === 'description' ? r.d : r.m);
      const want = pieceOf(r.code);
      if (squash(shown).includes(squash(want))) { agree += 1; continue; }
      if (!PIECE_RX.test(String(shown ?? ''))) { productName += 1; continue; }  // the supplier's own name
      const next = String(shown).replace(PIECE_RX, want);
      mine.push({ arm: arm.name, table: arm.table, col, id: r.id, doc: r.doc, code: r.code, from: shown, to: next });
    }
    stats.push({ arm: arm.name, rows: rows.length, agree, productName, fix: mine.length });
    writes.push(...mine);
  }

  rule();
  for (const s of stats) {
    line(`   ${s.arm.padEnd(15)} lines ${String(s.rows).padStart(5)} · already agree ${String(s.agree).padStart(5)}`
      + ` · supplier's own product name ${String(s.productName).padStart(4)} · TO CORRECT ${s.fix}`);
  }
  rule();
  for (const w of writes) line(`   FIX ${w.doc.padEnd(24)} ${w.code.padEnd(14)} ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`);

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let wrote = 0;
    for (const w of writes) {
      /* One row at a time, and the OLD text is in the WHERE: a row somebody
         edited between the plan and the write is left alone rather than
         overwritten from a stale reading. */
      const res = await sql.unsafe(
        `UPDATE scm.${w.table} SET ${w.col} = $1 WHERE id = $2 AND ${w.col} = $3`,
        [w.to, w.id, w.from],
      );
      if (Number(res.count ?? 0) === 1) wrote += 1;
      else line(`   SKIPPED ${w.doc} ${w.code}: the text changed since the plan was read`);
    }
    line(`APPLIED — ${wrote} of ${writes.length} line(s) now name the piece their code states.`);

    /* VERIFY on a FRESH connection: re-read every corrected row and assert the
       printed text contains its own piece. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const bad = [];
      for (const w of writes) {
        const rows = await check.unsafe(
          `SELECT ${w.col} AS shown, item_code AS code FROM scm.${w.table} WHERE id = $1`, [w.id],
        );
        const r = rows[0];
        if (!r || !squash(r.shown).includes(squash(pieceOf(r.code)))) bad.push(`${w.doc} ${w.code}`);
      }
      if (bad.length) {
        line(`VERIFY FAILED — ${bad.length} line(s) still disagree: ${bad.slice(0, 8).join(', ')}`);
        process.exitCode = 1;
      } else {
        line(`VERIFY OK — ${writes.length} line(s) print the piece their code states.`);
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
