#!/usr/bin/env node
/* reverse-sofa-build-middle - put the CORNER back on the right side of ONE sofa
 * build, on a document that carries more than one sofa.
 *
 * ── WHY THIS EXISTS BESIDE reverse-sofa-middle-order-2026-09-10.mjs ─────────
 * That script reverses the middle of a document's sofa rows and is right for a
 * document holding ONE sofa. HC-SO-012025 holds two: the account book has line
 * key 829179 (a four-piece sectional) and key 829180 (a loose 1S), and
 * the ERP stores them interleaved -
 *
 *     #1 9050-1A(LHF)  key 829179      #6 9050-1NA       key 829179
 *     #2 9050-1S       key 829180      #7 9050-CNR       key 829179
 *                                      #8 9050-1A(RHF)   key 829179
 *
 * so the document's sofa sequence reads 1A(LHF)+1S+1NA+CNR+1A(RHF) and its
 * "middle" contains a piece belonging to a DIFFERENT SOFA. Reversing that
 * middle would move the loose chair into the sectional. The document-scoped
 * script correctly REFUSES this shape (its pre-flight asserts the target is the
 * middle reversed, and 1S+1NA+CNR reversed is not 1S+CNR+1NA) - which is why
 * HC-SO-012025 was HELD by the TV-direction round rather than applied.
 *
 * The unit that has a direction is the BUILD, not the document. This script
 * takes `linked_ac_dtlkey` as the build's identity - a sofa is ONE line in the
 * book (memory: sofa-is-one-book-line) - and moves only that build's rows.
 *
 * ── WHAT IS BEING CORRECTED ────────────────────────────────────────────────
 * Build 829179 was recorded MIRRORED: the drawing's TV is above the run, and
 * the round that decoded it predates the rule that the TV decides the hand
 * (docs/bugs/0774). Its mirror is
 *
 *     reverse(1A(LHF)+1NA+CNR+1A(RHF)) with the hands swapped
 *       = 1A(LHF)+CNR+1NA+1A(RHF)
 *
 * which is the build the held entry recorded. Both ends are plain arms, so the
 * hands come back to where they already are and ONLY THE MIDDLE MOVES - the
 * same shape as docs/bugs/0777, where a by-code applier fixed nine sofas' ends
 * and left their corners on the wrong side.
 *
 * ── IT MOVES `line_no`, NEVER `item_code` ──────────────────────────────────
 * Permuting codes across rows would leave `purchase_order_items.so_item_id`
 * pointing at a row that is now a different compartment - the dedication would
 * silently name the wrong piece. Moving the ROW takes its code, its money and
 * its id with it. `line_no` is unique per document, so the movers are parked on
 * NEGATIVE numbers inside one transaction before taking their new ones.
 *
 * The build's first and last rows are never touched, which is what keeps the
 * money still: the cutover put the whole build's price on its lead row.
 *
 * ── VERIFICATION ───────────────────────────────────────────────────────────
 * On a FRESH connection: the build's SEQUENCE (not merely its multiset - a
 * reordering does not change a multiset, which is exactly how docs/bugs/0777
 * passed while nine sofas were still wrong), its code multiset, its row count,
 * both money columns, AND that every row on the document OUTSIDE the build kept
 * its line_no to the number. That last assertion is the one this script exists
 * for.
 *
 *   MODE          plan (default) | apply
 *   CONFIRM       on apply, must equal  reverse-sofa-build-middle
 *   DATABASE_URL  required
 *   COMPANY_ID    optional, default 1
 *
 * RE-RUN: idempotent by refusal. A second run reads the build already in its
 * target order, reports "already reads <target>" and writes nothing; it does
 * NOT reverse it back, because the pre-flight compares against `now` and a
 * build that has moved is skipped rather than touched.
 */
import postgres from 'postgres';

const MODE = (process.env.MODE || 'plan').toLowerCase();
const CONFIRM = process.env.CONFIRM || '';
const CO = Number(process.env.COMPANY_ID || 1);
const PHRASE = 'reverse-sofa-build-middle';

if (MODE === 'apply' && CONFIRM !== PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${PHRASE}. Nothing was written.`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('need DATABASE_URL'); process.exit(2); }

/* Each target names the BUILD, not the document. `now` is what it must read
   before anything is written; `want` must be `now`'s middle reversed. */
const TARGETS = [
  {
    doc: 'HC-SO-012025',
    dtlkey: '829179',
    now: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'],
    want: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'],
    why: 'HELD by the TV-direction round because the document carries two sofa '
      + 'lines and nothing recorded which one the drawing belonged to. Settled by '
      + 'reading the ERP: key 829180 is a loose 1S, key 829179 is the four-piece '
      + 'sectional, and only 829179 has the shape the held entry names.',
  },
];

const log = (s = '') => console.log(`::notice::${s}`);
const suffix = (code) => {
  const s = String(code ?? '');
  const i = s.indexOf('-');
  return (i < 0 ? s : s.slice(i + 1)).toUpperCase();
};
const seq = (rows) => rows.map((r) => suffix(r.item_code));

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`MODE=${MODE}  company ${CO}   ${TARGETS.length} build(s) named`);

  /* Every target's `want` must be its own middle reversed with the ends
     untouched. If that is not true the pair was derived wrongly and NOTHING
     should be written - checked before a connection does any work. */
  for (const t of TARGETS) {
    const midNow = t.now.slice(1, -1);
    const midWant = t.want.slice(1, -1);
    const ok = midNow.length === midWant.length
      && midNow.slice().reverse().every((p, i) => p === midWant[i])
      && t.now[0] === t.want[0] && t.now[t.now.length - 1] === t.want[t.want.length - 1];
    if (!ok) {
      console.error(`REFUSED before touching anything: ${t.doc}/${t.dtlkey}'s target is not `
        + `its own middle reversed (${t.now.join('+')} -> ${t.want.join('+')}). Nothing was written.`);
      process.exit(1);
    }
  }
  log('every target checked: the ends match and the middle is its own reverse');

  const plan = [];
  const skip = [];
  for (const t of TARGETS) {
    const build = await sql`
      SELECT i.id, i.line_no, i.item_code, i.unit_price_sen, i.total_sen
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND i.doc_no = ${t.doc}
         AND i.linked_ac_dtlkey::text = ${t.dtlkey}
         AND lower(coalesce(i.item_group, '')) = 'sofa'
         AND coalesce(i.cancelled, false) = false
       ORDER BY i.line_no, i.id`;

    /* Everything else on the document. It must not move, and the verification
       asserts that by line_no, so it is captured BEFORE the write. */
    const others = await sql`
      SELECT i.id, i.line_no, i.item_code
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND i.doc_no = ${t.doc}
         AND (i.linked_ac_dtlkey::text IS DISTINCT FROM ${t.dtlkey}
              OR lower(coalesce(i.item_group, '')) <> 'sofa')
       ORDER BY i.line_no, i.id`;

    if (!build.length) { skip.push(`${t.doc}/${t.dtlkey}: no sofa row carries this book line key`); continue; }
    const have = seq(build);
    if (have.join('+') === t.want.join('+')) { skip.push(`${t.doc}/${t.dtlkey}: already reads ${t.want.join('+')}`); continue; }
    if (have.join('+') !== t.now.join('+')) {
      skip.push(`${t.doc}/${t.dtlkey}: REFUSED - reads ${have.join('+')}, expected ${t.now.join('+')}. `
        + 'It has moved since it was measured.');
      continue;
    }

    const mid = build.slice(1, -1);
    const nos = mid.map((r) => r.line_no);
    const moves = mid
      .map((r, i) => ({ id: r.id, code: r.item_code, from: r.line_no, to: nos[nos.length - 1 - i] }))
      .filter((m) => m.from !== m.to);
    if (!moves.length) { skip.push(`${t.doc}/${t.dtlkey}: middle is one piece, nothing to reverse`); continue; }

    plan.push({ ...t, build, others, moves });
  }

  for (const s of skip) log(`  skip  ${s}`);

  for (const p of plan) {
    log('');
    log(`  ${p.doc}  book line ${p.dtlkey}   ${p.now.join('+')}  ->  ${p.want.join('+')}`);
    for (const r of p.build) {
      const m = p.moves.find((x) => x.id === r.id);
      log(`     ${m ? `move  line ${String(m.from).padStart(3)} -> ${String(m.to).padStart(3)}` : `keep  line ${String(r.line_no).padStart(3)}         `}  ${r.item_code}`);
    }
    log(`     ${p.others.length} row(s) elsewhere on this document must NOT move:`);
    for (const o of p.others) log(`        line ${String(o.line_no).padStart(3)}  ${o.item_code}`);
  }

  if (MODE !== 'apply') {
    log('');
    log(`PLAN ONLY. ${plan.length} build(s) would be renumbered, `
      + `${plan.reduce((a, p) => a + p.moves.length, 0)} row(s). Nothing was written.`);
    log(`Re-run with MODE=apply CONFIRM=${PHRASE} to write.`);
  } else {
    let rows = 0;
    for (const p of plan) {
      await sql.begin(async (tx) => {
        /* Park first: line_no is unique per document, so a direct swap collides
           with the row still holding the number. */
        for (const m of p.moves) {
          await tx`UPDATE scm.mfg_sales_order_items SET line_no = ${-m.to}
                    WHERE id = ${m.id} AND line_no = ${m.from}`;
        }
        for (const m of p.moves) {
          const done = await tx`UPDATE scm.mfg_sales_order_items SET line_no = ${m.to}
                                 WHERE id = ${m.id} AND line_no = ${-m.to}
                                 RETURNING id`;
          if (done.length !== 1) throw new Error(`${p.doc}: row ${m.id} did not take line ${m.to}; the transaction is rolled back`);
        }
      });
      rows += p.moves.length;
      log(`  APPLIED  ${p.doc}/${p.dtlkey}  ${p.moves.length} row(s) renumbered`);
    }
    log('');
    log(`APPLIED: ${rows} row(s) renumbered across ${plan.length} build(s).`);
  }

  await sql.end({ timeout: 5 });

  /* ── VERIFY on a FRESH connection ──────────────────────────────────────── */
  if (MODE === 'apply' && plan.length) {
    const v = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
    try {
      let bad = 0;
      for (const p of plan) {
        const after = await v`
          SELECT i.id, i.line_no, i.item_code, i.unit_price_sen, i.total_sen
            FROM scm.mfg_sales_order_items i
            JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
           WHERE h.company_id = ${CO} AND i.doc_no = ${p.doc}
             AND i.linked_ac_dtlkey::text = ${p.dtlkey}
             AND lower(coalesce(i.item_group, '')) = 'sofa'
             AND coalesce(i.cancelled, false) = false
           ORDER BY i.line_no, i.id`;
        const others = await v`
          SELECT i.id, i.line_no, i.item_code
            FROM scm.mfg_sales_order_items i
            JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
           WHERE h.company_id = ${CO} AND i.doc_no = ${p.doc}
             AND (i.linked_ac_dtlkey::text IS DISTINCT FROM ${p.dtlkey}
                  OR lower(coalesce(i.item_group, '')) <> 'sofa')
           ORDER BY i.line_no, i.id`;

        const fail = (m) => { console.error(`VERIFY FAILED ${p.doc}/${p.dtlkey}: ${m}`); bad += 1; };

        /* THE SEQUENCE, not the multiset. A reordering does not change a
           multiset, which is how docs/bugs/0777 passed on nine wrong sofas. */
        if (seq(after).join('+') !== p.want.join('+')) fail(`reads ${seq(after).join('+')}, wanted ${p.want.join('+')}`);
        if (after.length !== p.build.length) fail(`row count ${p.build.length} -> ${after.length}`);
        const codes = (rs) => rs.map((r) => r.item_code).sort().join('|');
        if (codes(after) !== codes(p.build)) fail('the code multiset changed - a code moved between rows');
        const money = (rs) => rs.map((r) => `${r.id}:${r.unit_price_sen}:${r.total_sen}`).sort().join('|');
        if (money(after) !== money(p.build)) fail('a money column moved with the renumbering');

        /* The whole reason this script exists: the other sofa, and every fee
           line, stayed exactly where it was. */
        const stay = (rs) => rs.map((r) => `${r.id}:${r.line_no}:${r.item_code}`).sort().join('|');
        if (stay(others) !== stay(p.others)) fail('a row OUTSIDE this build moved - that is the failure this script exists to prevent');
        else log(`  verified ${p.doc}/${p.dtlkey}: sequence ${p.want.join('+')}, money unchanged, `
          + `${others.length} row(s) outside the build untouched`);
      }
      if (bad) { console.error(`${bad} verification failure(s).`); process.exitCode = 1; }
      else log('VERIFIED on a fresh connection.');
    } finally {
      await v.end({ timeout: 5 });
    }
  }
} catch (e) {
  console.error(e?.message || e);
  process.exitCode = 1;
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
}
