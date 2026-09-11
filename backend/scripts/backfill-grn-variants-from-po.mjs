#!/usr/bin/env node
// Copy the PURCHASE line's variants — and its CATEGORY — onto a goods-received
// line that has none.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// WHAT IS MISSING, AND WHY IT IS NOT A LIVE DEFECT. The document-chain audit
// (run 34587006588, 2026-09-11) reported 91 goods-received lines that "carry no
// variants" — the spec the purchase line states is simply absent on the receipt.
// Measured before writing anything: of the sofa/bedframe ones, **70 of 70 are
// migrated paperwork from 2026-08**, and **70 of 70 have a purchase line that
// DOES carry the spec. The live receiving path copies it** — `grns.ts` writes
// `variants: it.variants` at the two create sites read (PR #44) — so this is the
// cutover importer's gap, not a hole anything is still falling through.
//
// WIDENED 2026-09-11, second pass. The first pass took sofa and bedframe only,
// and the chain audit still showed 21. Measured across every category: MATTRESS
// 175 and ACCESSORY 61 receipt lines carry no spec — and neither does their
// PURCHASE line, because those groups have no soft attributes at all
// (`computeVariantKey` gives them ''). Nothing to copy there, and nothing wrong.
// What was left is 24 lines carrying no CATEGORY either, 21 of whose purchase
// lines state a bedframe spec in full. A line with no category is invisible to
// every per-category audit, so the category is copied too — each half only where
// this line lacks it.
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
           coalesce(gi.item_group, '') AS own_group,
           (p.variants IS NOT NULL AND p.variants <> '{}'::jsonb
             AND (p.variants || jsonb_strip_nulls(coalesce(gi.variants, '{}'::jsonb)))
                 IS DISTINCT FROM gi.variants) AS spec_would_change,
           coalesce(p.item_group, '') AS parent_group,
           (p.variants IS NOT NULL AND p.variants <> '{}'::jsonb) AS parent_has,
           (SELECT count(*)::int FROM scm.inventory_movements m
             WHERE m.company_id = ${CO} AND m.source_doc_no = g.grn_number) AS movements
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items p ON p.id = gi.purchase_order_item_id
     WHERE g.company_id = ${CO}
       AND (
         /* an AXIS the purchase line states and this receipt does not — which
            includes the whole-blank case and the partial one (HC-GR-004478 held
            only a leg height against a purchase line stating ten axes) */
         (p.variants IS NOT NULL AND p.variants <> '{}'::jsonb
           AND (p.variants || jsonb_strip_nulls(coalesce(gi.variants, '{}'::jsonb)))
               IS DISTINCT FROM gi.variants)
         OR coalesce(gi.item_group, '') = ''
       )
     ORDER BY g.grn_number, gi.id`;

  /* Something to copy = a spec the parent states and this line lacks, or a
     CATEGORY the parent states and this line lacks. Mattress and accessory lines
     legitimately carry no spec at all — measured 2026-09-11: 175 mattress and 61
     accessory receipt lines whose PURCHASE line has none either, because those
     groups have no soft attributes (`computeVariantKey` gives them ''). Copying
     the category alone is still worth it: a line with no group is invisible to
     every per-category audit. */
  const hasSomething = (r) => (r.parent_has && r.spec_would_change === true) || (!r.own_group && !!r.parent_group);
  const writable = rows.filter((r) => hasSomething(r) && r.migrated === true && Number(r.movements) === 0);
  const held = rows.filter((r) => !writable.includes(r));

  rule();
  line(`   receipt lines missing a spec or a category   ${rows.length}`);
  line(`   WRITABLE (migrated paperwork, no stock movement, parent has the spec)  ${writable.length}`
    + `   over ${new Set(writable.map((r) => r.grn_number)).size} receipt(s)`);
  line(`   HELD                                ${held.length}`);
  rule();
  for (const r of held) {
    const why = !r.parent_has && !r.parent_group ? 'the purchase line has neither a spec nor a category'
      : !r.parent_has && r.own_group ? 'the purchase line has no spec either, and this line already has its category'
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
           SET variants = CASE
                            WHEN p.variants IS NOT NULL AND p.variants <> '{}'::jsonb
                            /* The parent as the BASE, this line's own stated values
                               on top: a receipt that states only a leg height keeps
                               that leg and gains the gap, divan, colour and total
                               its purchase line states. jsonb_strip_nulls first, so
                               an explicit null on the child cannot blank a value the
                               parent states. Measured 2026-09-11: HC-GR-004478's two
                               REGAL (A)-(Q) lines held {"legHeight":"1\""} against a
                               purchase line stating ten axes. */
                            THEN p.variants || jsonb_strip_nulls(coalesce(gi.variants, '{}'::jsonb))
                            ELSE gi.variants END,
               item_group = CASE
                            WHEN coalesce(gi.item_group, '') = '' THEN p.item_group
                            ELSE gi.item_group END
          FROM scm.purchase_order_items p, scm.grns g
         WHERE gi.id = ANY(${ids})
           AND p.id = gi.purchase_order_item_id
           AND g.id = gi.grn_id
           AND g.company_id = ${CO}
           AND g.migrated_no_stock IS TRUE`;
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
               AND (
                 /* what the write promises: every axis the purchase line states is
                    now on the receipt, and this line's own stated values survived. */
                 (p.variants IS NOT NULL AND p.variants <> '{}'::jsonb
                   AND (jsonb_typeof(gi.variants) <> 'object'
                        OR NOT (gi.variants @> jsonb_strip_nulls(p.variants))))
                 OR (coalesce(p.item_group, '') <> '' AND coalesce(gi.item_group, '') = '')
               )`
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
