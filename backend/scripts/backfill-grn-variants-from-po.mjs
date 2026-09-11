#!/usr/bin/env node
// Copy the PURCHASE line's variants onto a goods-received line that has none.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// WHAT IS MISSING, AND WHY IT IS NOT A LIVE DEFECT. The document-chain audit
// (run 34587006588, 2026-09-11) reported 91 goods-received lines that "carry no
// variants" — the spec the purchase line states is simply absent on the receipt.
// Measured before writing anything: of the sofa/bedframe ones, **70 of 70 are
// migrated paperwork from 2026-08**, and **70 of 70 have a purchase line that
// DOES carry the spec. The live receiving path copies it** — `grns.ts` writes
// `variants: it.variants` on both create paths (PR #44) — so this is the cutover
// importer's gap, not a hole anything is still falling through.
//
// WHY IT IS SAFE TO WRITE, stated as a check rather than a belief. A GRN's
// variants decide the variant_key of the LOT it creates. These GRNs created no
// lot: they are `migrated_no_stock`, the shape the cutover used for paperwork
// whose stock came in through the opening-balance import instead. The tool
// REFUSES any line whose GRN is not migrated_no_stock, and refuses again if any
// inventory movement names that GRN — so a receipt that actually moved goods is
// never re-specced underneath its own lot (docs/bugs/0722 is that mistake in the
// other direction).
//
// THE VALUE IS COPIED, NEVER REBUILT: `SET variants = p.variants` reads the
// parent column straight across in SQL. Nothing is serialized in JavaScript, so
// the double-encoding trap (docs/bugs/0814, docs/jsonb-double-encoding-coe.md)
// has no way in here.
//
// RE-RUN: inert. A filled line no longer matches `variants IS NULL OR = '{}'`,
// so the second run plans nothing.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: COPY THE SPEC ONTO THE RECEIPT
import postgres from 'postgres';

const CONFIRM_PHRASE = 'COPY THE SPEC ONTO THE RECEIPT';
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
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('GOODS-RECEIVED LINES WITH NO SPEC — copy it from the purchase line');
  line('='.repeat(78));
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  /* The population, and the two guards, in one read so the plan and the write
     can never disagree about what is in scope. */
  const rows = await sql`
    SELECT gi.id, gi.item_code, g.grn_number, g.migrated_no_stock AS migrated,
           (p.variants IS NOT NULL AND p.variants <> '{}'::jsonb) AS parent_has,
           (SELECT count(*)::int FROM scm.inventory_movements m
             WHERE m.company_id = ${CO} AND m.source_doc_no = g.grn_number) AS movements
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items p ON p.id = gi.purchase_order_item_id
     WHERE g.company_id = ${CO}
       AND upper(coalesce(gi.item_group, '')) IN ('SOFA', 'BEDFRAME')
       AND (gi.variants IS NULL OR gi.variants = '{}'::jsonb)
     ORDER BY g.grn_number, gi.id`;

  const writable = rows.filter((r) => r.parent_has && r.migrated === true && Number(r.movements) === 0);
  const held = rows.filter((r) => !writable.includes(r));

  rule();
  line(`   receipt lines with no spec          ${rows.length}`);
  line(`   WRITABLE (migrated paperwork, no stock movement, parent has the spec)  ${writable.length}`
    + `   over ${new Set(writable.map((r) => r.grn_number)).size} receipt(s)`);
  line(`   HELD                                ${held.length}`);
  rule();
  for (const r of held) {
    const why = !r.parent_has ? 'the purchase line has no spec either'
      : r.migrated !== true ? 'this receipt is NOT migrated paperwork — it is somebody\'s own statement about goods that moved'
        : `${r.movements} inventory movement(s) name this receipt`;
    line(`   HELD  ${r.grn_number.padEnd(24)} ${r.item_code.padEnd(20)} ${why}`);
  }

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    const ids = writable.map((r) => r.id);
    let wrote = 0;
    if (ids.length) {
      /* The parent's column, copied across in SQL — not read into JavaScript and
         written back. The guards are repeated in the WHERE so the write cannot
         reach a row the plan did not clear, even if the tree changed between
         the two statements. */
      const res = await sql`
        UPDATE scm.grn_items gi
           SET variants = p.variants
          FROM scm.purchase_order_items p, scm.grns g
         WHERE gi.id = ANY(${ids})
           AND p.id = gi.purchase_order_item_id
           AND g.id = gi.grn_id
           AND g.company_id = ${CO}
           AND g.migrated_no_stock IS TRUE
           AND (gi.variants IS NULL OR gi.variants = '{}'::jsonb)
           AND p.variants IS NOT NULL AND p.variants <> '{}'::jsonb`;
      wrote = Number(res.count ?? 0);
    }
    line(`APPLIED — ${wrote} receipt line(s) took their purchase line's spec.`);

    /* VERIFY on a FRESH connection, asserting the SHAPE: every line planned now
       carries an OBJECT that equals its parent's. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const bad = ids.length
        ? await check`
            SELECT gi.id, gi.item_code, jsonb_typeof(gi.variants) AS shape
              FROM scm.grn_items gi
              JOIN scm.purchase_order_items p ON p.id = gi.purchase_order_item_id
             WHERE gi.id = ANY(${ids})
               AND (gi.variants IS DISTINCT FROM p.variants OR jsonb_typeof(gi.variants) <> 'object')`
        : [];
      if (bad.length) {
        line(`VERIFY FAILED — ${bad.length} line(s) do not match their purchase line: ${bad.slice(0, 6).map((b) => `${b.item_code} (${b.shape})`).join(', ')}`);
        process.exitCode = 1;
      } else {
        line(`VERIFY OK — ${ids.length} receipt line(s) now read exactly what their purchase line states.`);
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
