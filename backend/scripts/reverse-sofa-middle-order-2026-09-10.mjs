#!/usr/bin/env node
/* reverse-sofa-middle-order-2026-09-10 — finish the mirror the code-pairing
 * could not: put the corner back on the side the drawing puts it.
 *
 * Owner, 2026-09-10: 「纠正direction 要根据看TV」, and on this remainder: 「要」.
 *
 * WHAT IS STILL WRONG, AND HOW THAT IS KNOWN. `apply-sofa-compartment-corrections`
 * (production run 34441508244) corrected 20 mirrored sofas. It pairs existing
 * rows to target pieces BY CODE and updates in place — deliberately, so a row id
 * survives and with it the purchase-order dedication that reads it. That is
 * right for the END pieces, whose codes really do change (`L(LHF)` <-> `1A(RHF)`),
 * and it is a no-op for a middle piece whose code appears on both sides of the
 * mirror. Its own dry run said so out loud on HC-SO-012752:
 *
 *     change 1A(LHF) -> L(LHF)
 *     keep   1NA
 *     keep   2NA
 *     keep   CONSOLE          <- the console did not move to the other side
 *     change L(RHF) -> 1A(RHF)
 *
 * So on nine documents the two ENDS are now correct and the CORNER or CONSOLE is
 * still where the un-mirrored reading put it. `1A+1NA+CNR+1A` and
 * `1A+CNR+1NA+1A` are two different sofas: the corner turns the run at a
 * different point, and the factory builds what the sequence says.
 *
 * ── WHY THIS REVERSES THE MIDDLE AND NOTHING ELSE ────────────────────────
 * A mirror is: reverse the whole sequence and swap every hand. The hands and the
 * ends are already done, so what remains is exactly the middle, reversed.
 * Verified against every one of the nine, e.g. HC-SO-012026 now reads
 * `1A(LHF)+1NA+1NA+CNR+1A(RHF)` and wants `1A(LHF)+CNR+1NA+1NA+1A(RHF)` — middle
 * `1NA,1NA,CNR` reversed is `CNR,1NA,1NA`. The script asserts that equality per
 * document and REFUSES the document if it does not hold, rather than writing a
 * sequence nobody checked.
 *
 * ── WHY IT MOVES `line_no` AND NOT `item_code` ───────────────────────────
 * Two ways to reorder, and only one is safe. Permuting the CODES across rows
 * would leave `purchase_order_items.so_item_id` pointing at a row that is now a
 * different compartment — the dedication would silently name the wrong piece.
 * Permuting `line_no` moves the ROW, so its code, its money and everything bound
 * to its id travel with it. Nothing about identity changes; only the order does,
 * and the order is the thing that is wrong.
 *
 * THE FIRST AND LAST ROWS ARE NEVER TOUCHED. That is what keeps the money still:
 * the cutover put the whole build's price on the lead row and 0 on the rest, so
 * leaving row 1 where it is means no price ever changes position. The
 * verification asserts both money columns per document anyway.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing the before and after sequence.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE names the exact line_no being replaced.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: the piece
 *   SEQUENCE now equals the target, the multiset of codes is unchanged, the row
 *   count is unchanged, and both money columns are byte-identical.
 *
 * RE-RUN: idempotent — a second run finds the sequence already correct and
 * reports 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'reverse sofa middle order 2026-09-10';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

/* The nine documents whose ends were corrected and whose middle was not, with
   the sequence each one must end up reading. Both sides are from the applier's
   own production run 34441508244: `now` is what its VERIFY printed, `want` is
   the build the corrections file names. A document whose rows do not match `now`
   is REFUSED — it has moved since, and this script must not write over that. */
const TARGETS = [
  { doc: 'HC-SO-008942', now: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'], want: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'] },
  { doc: 'HC-SO-011159', now: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'], want: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'] },
  { doc: 'HC-SO-011446', now: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'], want: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'] },
  { doc: 'HC-SO-011447', now: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'], want: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'] },
  { doc: 'HC-SO-011601', now: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'], want: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'] },
  { doc: 'HC-SO-012026', now: ['1A(LHF)', '1NA', '1NA', 'CNR', '1A(RHF)'], want: ['1A(LHF)', 'CNR', '1NA', '1NA', '1A(RHF)'] },
  { doc: 'HC-SO-012525', now: ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'], want: ['1A(LHF)', 'CNR', '1NA', '1A(RHF)'] },
  { doc: 'HC-SO-012752', now: ['L(LHF)', 'CONSOLE', '2NA', '1NA', '1A(RHF)'], want: ['L(LHF)', '1NA', '2NA', 'CONSOLE', '1A(RHF)'] },
  { doc: 'HC-SO-012828', now: ['1A(LHF)', 'CNR', '1NA', '1NA', '1A(RHF)'], want: ['1A(LHF)', '1NA', '1NA', 'CNR', '1A(RHF)'] },
];

const suffix = (code) => {
  const s = String(code ?? '');
  const i = s.indexOf('-');
  return (i < 0 ? s : s.slice(i + 1)).toUpperCase();
};
const seq = (rows) => rows.map((r) => suffix(r.item_code));

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`MODE=${MODE}  company ${CO}   ${TARGETS.length} document(s) named`);

  /* Every target's middle must be the reverse of what it reads now. If that is
     not true the pair was derived wrongly and nothing should be written. */
  for (const t of TARGETS) {
    const midNow = t.now.slice(1, -1);
    const midWant = t.want.slice(1, -1);
    const ok = midNow.length === midWant.length
      && midNow.slice().reverse().every((p, i) => p === midWant[i])
      && t.now[0] === t.want[0] && t.now[t.now.length - 1] === t.want[t.want.length - 1];
    if (!ok) {
      console.error(`REFUSED before touching anything: ${t.doc}'s target is not its own middle `
        + `reversed (${t.now.join('+')} -> ${t.want.join('+')}). Nothing was written.`);
      process.exit(1);
    }
  }
  log('every target checked: the ends match and the middle is its own reverse');

  const plan = [];
  const skip = [];
  for (const t of TARGETS) {
    const rows = await sql`
      SELECT i.id, i.line_no, i.item_code, i.unit_price_sen, i.total_sen
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND i.doc_no = ${t.doc}
         AND lower(coalesce(i.item_group, '')) = 'sofa'
         AND coalesce(i.cancelled, false) = false
       ORDER BY i.line_no, i.id`;
    if (!rows.length) { skip.push(`${t.doc}: no sofa row on this document`); continue; }
    const have = seq(rows);
    if (have.join('+') === t.want.join('+')) { skip.push(`${t.doc}: already reads ${t.want.join('+')}`); continue; }
    if (have.join('+') !== t.now.join('+')) {
      skip.push(`${t.doc}: REFUSED — reads ${have.join('+')}, expected ${t.now.join('+')}. It has moved since it was measured.`);
      continue;
    }
    /* Reverse the MIDDLE rows by handing them each other's line_no. The first
       and last rows keep theirs, so the priced lead row never moves. */
    const mid = rows.slice(1, -1);
    const nos = mid.map((r) => r.line_no);
    const moves = mid.map((r, i) => ({ id: r.id, code: r.item_code, from: r.line_no, to: nos[nos.length - 1 - i] }))
      .filter((m) => m.from !== m.to);
    plan.push({ doc: t.doc, rows, have, want: t.want, moves });
  }

  log(`\n=== WOULD REORDER: ${plan.length} document(s), ${plan.reduce((a, p) => a + p.moves.length, 0)} row(s) ===`);
  for (const p of plan) {
    log(`  ${p.doc}   ${p.have.join('+')}  ->  ${p.want.join('+')}`);
    for (const m of p.moves) log(`      ${suffix(m.code).padEnd(10)} line ${m.from} -> ${m.to}`);
  }
  if (skip.length) {
    log('\n  LEFT ALONE:');
    for (const s of skip) log(`    ${s}`);
  }

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  let wrote = 0;
  for (const p of plan) {
    await sql.begin(async (tx) => {
      /* Park the moving rows on negative line numbers first: line_no is unique
         per document, so a direct swap collides with itself half-way through. */
      for (const m of p.moves) {
        await tx`UPDATE scm.mfg_sales_order_items SET line_no = ${-m.to}
                  WHERE id = ${m.id} AND line_no = ${m.from}`;
      }
      for (const m of p.moves) {
        const done = await tx`UPDATE scm.mfg_sales_order_items SET line_no = ${m.to}
                               WHERE id = ${m.id} AND line_no = ${-m.to}
                              RETURNING id`;
        wrote += done.length;
      }
    });
  }
  log(`\nAPPLIED: ${wrote} row(s) renumbered across ${plan.length} document(s).`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  let good = 0;
  const bad = [];
  for (const p of plan) {
    const rows = await check`
      SELECT i.id, i.line_no, i.item_code, i.unit_price_sen, i.total_sen
        FROM scm.mfg_sales_order_items i
       WHERE i.doc_no = ${p.doc} AND lower(coalesce(i.item_group, '')) = 'sofa'
         AND coalesce(i.cancelled, false) = false
       ORDER BY i.line_no, i.id`;
    const nowSeq = seq(rows).join('+');
    const sameSet = [...seq(rows)].sort().join('|') === [...p.have].sort().join('|');
    const money = rows.reduce((a, r) => a + Number(r.unit_price_sen ?? 0), 0)
      === p.rows.reduce((a, r) => a + Number(r.unit_price_sen ?? 0), 0)
      && rows.reduce((a, r) => a + Number(r.total_sen ?? 0), 0)
      === p.rows.reduce((a, r) => a + Number(r.total_sen ?? 0), 0);
    if (nowSeq === p.want.join('+') && sameSet && money && rows.length === p.rows.length) {
      good += 1;
      log(`  OK    ${p.doc}  ${nowSeq}`);
    } else {
      bad.push(`${p.doc}: reads ${nowSeq}, wanted ${p.want.join('+')}, same codes ${sameSet}, money unchanged ${money}, rows ${rows.length}/${p.rows.length}`);
    }
  }
  await check.end();

  log('\n=== VERIFY (fresh connection) ===');
  log(`  ${good} of ${plan.length} document(s) now read the build the drawing says`);
  for (const b of bad) log(`  WRONG ${b}`);
  if (bad.length) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — only the order moved: same rows, same codes, same money.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
