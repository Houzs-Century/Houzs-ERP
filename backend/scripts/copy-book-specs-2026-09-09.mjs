#!/usr/bin/env node
/* copy-book-specs-2026-09-09 — write the leg height, seat height and headboard
 * special that the ACCOUNT BOOK states and the ERP left blank.
 *
 * THE OWNER'S RULE, and this is the whole of the reasoning: 「一律跟账本」 /
 * 「autocount怎么写我们就怎么写」 — where the book states a value and we hold
 * nothing, copy the book. Nine sales-order rows across five documents are that
 * shape, and every one of them is a BLANK being filled: no value is overwritten,
 * no value is invented, and nothing the ERP already holds is touched.
 *
 * THE FINDINGS ARE THE RECONCILE'S OWN WORDS, not a re-derivation. From
 * `so-tally-verdict` run 34344456950 with the reconcile log printed:
 *
 *   SO-012442 DtlKey 848371 (ERP 5535-2A(LHF)): AutoCount "1"" vs ERP "(blank)"
 *   SO-013310 DtlKey 908744 (ERP 5535-2A(LHF)): AutoCount "2"" vs ERP "(blank)"
 *   SO-012049 DtlKey 830097 (ERP 8050-1A(LHF)): AutoCount "24"" vs ERP "(blank)"
 *   SO-012049 DtlKey 830098 (ERP 8050-L(LHF)):  AutoCount "24"" vs ERP "(blank)"
 *   SO-009373 DtlKey 640588 (ERP TRION (A) (HB STR)-(K)): AutoCount "HB straight | HB Straight" vs ERP "(blank)"
 *   SO-010298 DtlKey 701159 (ERP TRION (A)-(K)):          AutoCount "HB Straight" vs ERP "(blank)"
 *
 * A BOOK LINE IS ONE SOFA AND SEVERAL ERP ROWS, so the value lands on every ERP
 * row behind the book line, not on one of them. 012049's two book lines cover
 * five compartment rows and 012442's and 013310's cover two each — that is why
 * the manifest is keyed by (doc_no, linked_ac_dtlkey) and not by line number.
 *
 * THE FIELD NAMES WERE READ, NOT GUESSED. `variants.legHeight` holds strings
 * like `0"` and `No Leg` on the documents that have one; `variants.seatHeight`
 * holds a bare number string like `30`; `variants.specials` is a string array —
 * and it is `variants.specials` that is canonical, never `custom_specials`,
 * which is derived and self-erasing.
 *
 * WHAT IS DELIBERATELY LEFT ALONE, each for a reason that is not "it was hard":
 *
 *   HC-SO-007678  the book asks for "Front Drawer"; the line carries
 *                 "Left Drawer" + "Right Drawer" and a customer note reading
 *                 "customize the front divan with one drawer on the left and one
 *                 drawer on the right". That is the SAME request in two
 *                 vocabularies, so adding a third special would double-count a
 *                 drawer the factory is already building. It is also NOT
 *                 PROCEEDED.
 *   HC-SO-011725  the book says `DL-CS2 ELEGANCE SUITE (SS)` and the ERP says
 *                 RITZ LUXURY, because Sim approved the amendment "exchange to
 *                 Ritz Luxury SS" at 07:38 on 2026-09-09. The ERP is AHEAD of
 *                 the book; copying the book would undo a change a person made
 *                 today. The book is what needs updating, through the write-back.
 *   HC-SO-009373  DtlKey 640590: the book is BLANK and the ERP holds `0"`. The
 *                 book's own Desc2 reads "Divan:8 inch+No inch leg" — a typo for
 *                 "No leg" that the parser cannot read — so our `0"` is the same
 *                 statement, correctly recorded. Blanking it would lose a fact.
 *   HC-SO-009373  DtlKey 640588 item code: the book's CODE says plain
 *                 `TRION (A)-(K)` while the book's own Desc2 says "HB straight",
 *                 which is the HB-STR product the ERP holds. The book contradicts
 *                 itself and only the owner can settle it — the same shape as
 *                 HC-SO-000870 (docs/bugs/0757).
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, which writes nothing and prints every row.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE is a FILL: it carries a predicate that the field is currently
 *   absent or null (or, for specials, does not already contain the value), so a
 *   row somebody has since filled in is skipped rather than overwritten, and the
 *   run refuses outright if a manifest row's item code or book key has moved.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE — every
 *   named row now holds the expected value, and the document's money and
 *   quantities are unchanged.
 *
 * RE-RUN: idempotent. Second run finds every field already filled, writes
 * nothing, and reports 0.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/copy-book-specs-2026-09-09.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='copy book specs 2026-09-09' \
 *     node backend/scripts/copy-book-specs-2026-09-09.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'copy book specs 2026-09-09';
const APPLY = MODE === 'apply';

/* doc_no, book line key, field, value, the item code every row behind that book
   line must still carry (a guard, not a selector). */
const MANIFEST = [
  ['HC-SO-012442', 848371, 'legHeight', '1"', ['5535-2A(LHF)', '5535-1A(RHF)']],
  ['HC-SO-013310', 908744, 'legHeight', '2"', ['5535-2A(LHF)', '5535-L(RHF)']],
  ['HC-SO-012049', 830097, 'seatHeight', '24', ['8050-1A(LHF)', '8050-1NA', '8050-1A(RHF)']],
  ['HC-SO-012049', 830098, 'seatHeight', '24', ['8050-L(LHF)', '8050-1A(R)(RHF)']],
  ['HC-SO-009373', 640588, 'specials', 'HB Straight', ['TRION (A) (HB STR)-(K)']],
  ['HC-SO-010298', 701159, 'specials', 'HB Straight', ['TRION (A)-(K)']],
];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const moneyShape = async (conn) => (await conn`
  SELECT count(*)::int AS rows,
         coalesce(sum(qty), 0)::text AS qty,
         coalesce(sum(unit_price_sen), 0)::text AS unit_price_sen,
         coalesce(sum(total_sen), 0)::text AS total_sen
    FROM scm.mfg_sales_order_items
   WHERE doc_no = ANY(${[...new Set(MANIFEST.map((m) => m[0]))]})`)[0];

try {
  console.log(`MODE=${MODE}  ${MANIFEST.length} book line(s)`);
  const before = await moneyShape(sql);

  let refuse = 0;
  const todo = [];
  console.log('\n=== THE PLAN ===');
  for (const [doc, key, field, value, codes] of MANIFEST) {
    const rows = await sql`
      SELECT id, line_no, item_code, variants
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${doc} AND linked_ac_dtlkey = ${key}
         AND coalesce(cancelled, false) = false
       ORDER BY line_no`;
    const got = rows.map((r) => r.item_code).sort();
    const want = [...codes].sort();
    if (got.length !== want.length || got.some((x, i) => x !== want[i])) {
      console.log(`  MOVED    ${doc} book ${key} — expected [${want.join(', ')}], found [${got.join(', ')}]`);
      refuse += 1;
      continue;
    }
    for (const r of rows) {
      const v = r.variants ?? {};
      if (field === 'specials') {
        const cur = Array.isArray(v.specials) ? v.specials : [];
        if (cur.some((s) => String(s).toLowerCase() === value.toLowerCase())) {
          console.log(`  ALREADY  ${doc} #${r.line_no} ${r.item_code} — specials already carry "${value}"`);
          continue;
        }
        console.log(`  ADD      ${doc} #${r.line_no} ${String(r.item_code).padEnd(24)} specials += "${value}"`
          + `   (now: ${cur.length ? cur.join(' | ') : '(none)'})`);
        todo.push({ id: r.id, field, value, doc, line: r.line_no });
      } else {
        const cur = v[field];
        if (cur !== undefined && cur !== null && String(cur) !== '') {
          console.log(`  ALREADY  ${doc} #${r.line_no} ${r.item_code} — ${field} = "${cur}"`);
          continue;
        }
        console.log(`  FILL     ${doc} #${r.line_no} ${String(r.item_code).padEnd(24)} ${field} = "${value}"   (was blank)`);
        todo.push({ id: r.id, field, value, doc, line: r.line_no });
      }
    }
  }

  if (refuse > 0) {
    console.error(`\nREFUSED: ${refuse} book line(s) no longer hold the rows this manifest was measured against. `
      + 'Nothing was written.');
    await sql.end();
    process.exit(1);
  }
  if (!APPLY) {
    console.log(`\nPLAN ONLY — nothing was written. ${todo.length} row(s) would change.`);
    await sql.end();
    process.exit(0);
  }

  let wrote = 0;
  for (const t of todo) {
    const done = t.field === 'specials'
      ? await sql`
          UPDATE scm.mfg_sales_order_items
             SET variants = jsonb_set(
                   coalesce(variants, '{}'::jsonb), '{specials}',
                   coalesce(variants->'specials', '[]'::jsonb) || to_jsonb(${t.value}::text), true)
           WHERE id = ${t.id}
             AND NOT (coalesce(variants->'specials', '[]'::jsonb) ? ${t.value})
          RETURNING id`
      : await sql`
          UPDATE scm.mfg_sales_order_items
             SET variants = jsonb_set(coalesce(variants, '{}'::jsonb),
                                      ${`{${t.field}}`}, to_jsonb(${t.value}::text), true)
           WHERE id = ${t.id}
             AND coalesce(variants->>${t.field}, '') = ''
          RETURNING id`;
    wrote += done.length;
  }
  console.log(`\nAPPLIED: ${wrote} row(s) written.`);
  await sql.end();

  /* FRESH CONNECTION, and the SHAPE: every named row now holds the value, and
     the five documents' money and quantities did not move. */
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  let bad = 0;
  console.log('\n=== VERIFY (fresh connection) ===');
  for (const [doc, key, field, value] of MANIFEST) {
    const rows = await check`
      SELECT line_no, item_code, variants
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${doc} AND linked_ac_dtlkey = ${key}
         AND coalesce(cancelled, false) = false
       ORDER BY line_no`;
    for (const r of rows) {
      const v = r.variants ?? {};
      const ok = field === 'specials'
        ? (Array.isArray(v.specials) && v.specials.some((s) => String(s).toLowerCase() === value.toLowerCase()))
        : String(v[field] ?? '') === value;
      if (!ok) bad += 1;
      console.log(`  ${ok ? 'OK   ' : 'WRONG'} ${doc} #${r.line_no} ${String(r.item_code).padEnd(24)} ${field} `
        + `= ${JSON.stringify(field === 'specials' ? v.specials : v[field])}`);
    }
  }
  const after = await moneyShape(check);
  await check.end();
  const moneySame = before.rows === after.rows && before.qty === after.qty
    && before.unit_price_sen === after.unit_price_sen && before.total_sen === after.total_sen;
  console.log(`  money and quantities unchanged : ${moneySame ? 'YES' : 'NO'}`);
  if (bad !== 0 || !moneySame) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  console.log('VERIFY OK — every blank the book had a value for is filled, and nothing else moved.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
