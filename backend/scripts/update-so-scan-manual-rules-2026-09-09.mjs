#!/usr/bin/env node
/* update-so-scan-manual-rules-2026-09-09 — teach the sales-order scanner four
 * reading techniques this cutover paid for, and finish the one rule that was
 * stated as a principle without its consequence.
 *
 * WHERE THIS WRITES, AND WHY IT IS NOT CODE. `scm.so_scan_rules` row
 * `__GLOBAL_MANUAL__` is the HAND-WRITTEN layer of the scanner's prompt. Its own
 * comment in `scm/routes/scan-so.ts` says why it exists: the distiller learns by
 * diffing extracted JSON against corrected JSON, and that "can never teach a
 * reading TECHNIQUE — that a hatched strip on a box edge in the slip's drawing
 * IS the armrest". `distillGlobalRules` never regenerates this row, so what is
 * written here survives. Editing the prompt in TypeScript would need a deploy
 * and would bust the 1-hour prompt cache for every rep; this does neither.
 *
 * ── 1. THE TV RULE, FINISHED ───────────────────────────────────────────────
 * The row already says "'TV' MARKS THE VIEWING DIRECTION. Left and right are as
 * seen facing the sofa from the TV." That is the principle and it is right, but
 * it never says what the two cases DO, so a reader still has to derive it — and
 * two of this project's own notes derived it in OPPOSITE directions and sat
 * contradicting each other for days. HC-SO-012014 was read as arm-at-drawing-left
 * = LHF; HC-SO-010955 read as its exact mirror. Neither note recorded where the
 * TV was, which is the only thing that could have reconciled them.
 *
 * Owner, 2026-09-09, 「主要是看TV的 要看TV在上还是下」, confirming the geometry
 * with 「是的」:
 *     TV drawn BELOW the run -> you look from below; your left IS the drawing's
 *                               left, so a hatched arm on the LEFT edge is (LHF)
 *     TV drawn ABOVE the run -> you look from above; your left is the drawing's
 *                               RIGHT, so that same arm is (RHF). Mirrored.
 * Getting this backwards hands every sofa on the order the wrong way round and
 * looks completely normal — the multiset of pieces is identical, only the sides
 * swap. It is the single highest-cost misreading on the slip.
 *
 * ── 2..5, WHAT ELSE THIS CUTOVER LEARNED ───────────────────────────────────
 *   · THE BUILD ITSELF CAN BE TBC. The row already says a TBC/KIV COLOUR is a
 *     real state. Measured on the live book 2026-09-09: of the 23 sales orders
 *     whose sofa build the reconcile cannot verify, 21 carry NO drawing at all
 *     and a Desc2 reading only `tbc` / `kiv` / `Size: TBC`. The compartments
 *     were never decided either — so an invented build is not a near-miss, it is
 *     a fabrication of something that does not exist yet.
 *   · THE BOOK'S SHORTHAND. `ELT` = `L`, `2ER` = `2A(RHF)`, a bare `NA` = `1NA`.
 *     The owner has had to repeat these; they belong where the scanner reads.
 *   · `C TABLE` IS A TABLE, NOT A CORNER. Rule 4 says a box marked C is the
 *     corner, and that is right — but `HC-SO-011994`'s own Desc2 reads
 *     `C TABLE+1+C+2(28'INCH)`, where `C TABLE` is a console table and the bare
 *     `C` is the corner, in one string.
 *   · MODEL ALIASES ARE NOT SYMMETRIC. `8030` = `5540`; `5535` is its OWN model
 *     and must never be folded into another; `5537 -> 8030` is UNCONFIRMED and
 *     needs the owner. A wrongly folded model picks a catalog SKU for a sofa the
 *     customer did not buy.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, which writes nothing and prints the diff.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   The edit is PINNED: the old rule-5 text must be present VERBATIM or the run
 *   refuses, so a row somebody else has rewritten is never clobbered. The new
 *   section is appended only when its marker is absent.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE — the new
 *   rule-5 text present, the marker present exactly once, the old text gone, and
 *   the row still carrying everything it had before (length only grows).
 *
 * RE-RUN: idempotent. A second run finds the new text already present, writes
 * nothing and reports "already current".
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/update-so-scan-manual-rules-2026-09-09.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='update so scan manual rules 2026-09-09' \
 *     node backend/scripts/update-so-scan-manual-rules-2026-09-09.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'update so scan manual rules 2026-09-09';
const APPLY = MODE === 'apply';
const KEY = '__GLOBAL_MANUAL__';
const MARKER = 'WHAT THE 2026-09 CUTOVER TAUGHT US';

/* Must match the live row byte for byte, or the run refuses. */
const OLD_TV = `5. "TV" MARKS THE VIEWING DIRECTION. Left and right are as seen facing the sofa
   from the TV. A box drawn ABOVE or BELOW the main row, at right angles to it,
   is the other leg of an L — flatten it onto the end it joins.`;

const NEW_TV = `5. "TV" MARKS THE VIEWING DIRECTION, AND WHICH SIDE OF THE RUN IT IS DRAWN ON
   DECIDES LHF FROM RHF. You are standing at the TV looking at the sofa, so:
      TV drawn BELOW the run  -> you look from below; your left IS the drawing's
                                 left. A hatched arm on the LEFT edge is (LHF).
      TV drawn ABOVE the run  -> you look from above; your left is the drawing's
                                 RIGHT. That same arm is (RHF). Mirrored.
   Owner's own words: 主要是看TV的, 要看TV在上还是下. Read the TV's position
   BEFORE reading any arm, and say in notes which case you used.
   Get this backwards and every piece on the order is handed the wrong way while
   looking completely normal — the set of pieces is identical, only the sides
   swap. If there is NO TV marker, do not pick a side at all (see rule 8).
   A box drawn ABOVE or BELOW the main row AT RIGHT ANGLES to it is a different
   thing entirely — that is the other leg of an L; flatten it onto the end it
   joins. Do not mistake an L's leg for the TV.`;

const APPENDIX = `

${MARKER}

Four things the 2026-09 AutoCount reconciliation established by reading the live
account book. Each one changed a real order.

A. THE BUILD ITSELF CAN BE "TBC" — NOT JUST THE COLOUR. Of the 23 sales orders
   whose sofa build could not be verified against the book, 21 carry NO drawing
   at all and their only text is "tbc", "kiv", "Col: TBC" or "Size: TBC". The
   compartments had never been decided. So when the slip says TBC or KIV and no
   build is drawn, emit the sofa WITHOUT compartments and say so — an invented
   build is not a near miss, it is a fabrication of something that does not exist
   yet, and it reaches the factory.

B. THE ORDER BOOK'S SHORTHAND, as the owner writes it:
      ELT   = L            (the chaise)
      2ER   = 2A(RHF)
      NA    on its own     = 1NA
      2S(35") + 2S(28")    = two 2-seaters, different seat depths
   Expand these before matching a catalog SKU.

C. "C TABLE" IS A CONSOLE TABLE, NOT THE CORNER. Rule 4 above is right that a
   box marked C is the corner — but both appear in one string: a real slip reads
   "C TABLE + 1 + C + 2 (28inch)", where C TABLE is a table and the bare C is the
   corner. Match the whole token, never the letter.

D. MODEL ALIASES ARE NOT SYMMETRIC AND MUST NOT BE INVENTED.
      8030 = 5540          fold these
      5535                 is its OWN model. NEVER fold it into anything.
      5537 -> 8030         UNCONFIRMED. Do not use it; flag for the owner.
   A wrongly folded model picks a catalog SKU for a sofa the customer did not
   buy, and the price follows the SKU.`;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  const [row] = await sql`
    SELECT rules, length(rules) AS len, updated_at
      FROM scm.so_scan_rules WHERE salesperson = ${KEY}`;
  if (!row) {
    console.error(`REFUSED: no ${KEY} row. Nothing was written.`);
    await sql.end();
    process.exit(1);
  }
  console.log(`MODE=${MODE}`);
  console.log(`current row: ${row.len} chars, last updated ${row.updated_at}`);

  const hasOldTv = row.rules.includes(OLD_TV);
  const hasNewTv = row.rules.includes('DECIDES LHF FROM RHF');
  const hasMarker = row.rules.includes(MARKER);

  console.log(`  rule 5, old wording present : ${hasOldTv}`);
  console.log(`  rule 5, new wording present : ${hasNewTv}`);
  console.log(`  cutover appendix present    : ${hasMarker}`);

  if (hasNewTv && hasMarker) {
    console.log('\nAlready current — nothing to do.');
    await sql.end();
    process.exit(0);
  }
  if (!hasOldTv && !hasNewTv) {
    console.error('\nREFUSED: rule 5 is neither the wording this script expects nor the one it '
      + 'writes. Somebody has rewritten it; re-read the row before repairing. Nothing was written.');
    await sql.end();
    process.exit(1);
  }

  let next = row.rules;
  if (hasOldTv) next = next.replace(OLD_TV, NEW_TV);
  if (!hasMarker) next = `${next}${APPENDIX}`;

  console.log(`\nwould write: ${next.length} chars (was ${row.len}, +${next.length - row.len})`);
  if (!APPLY) {
    console.log('\n--- the new rule 5 ---');
    console.log(NEW_TV);
    console.log('\n--- the appended section ---');
    console.log(APPENDIX.trim());
    console.log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const done = await sql`
    UPDATE scm.so_scan_rules
       SET rules = ${next}, updated_at = now()
     WHERE salesperson = ${KEY} AND rules = ${row.rules}
    RETURNING salesperson`;
  console.log(`\nAPPLIED: ${done.length} row(s).`);
  await sql.end();
  if (done.length !== 1) {
    console.error('VERIFY FAILED: the row changed under us and was not written.');
    process.exit(1);
  }

  /* FRESH CONNECTION, and the SHAPE: a length check alone would pass on a row
     that had been truncated and re-appended. */
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [after] = await check`
    SELECT rules, length(rules) AS len FROM scm.so_scan_rules WHERE salesperson = ${KEY}`;
  await check.end();

  const marks = after.rules.split(MARKER).length - 1;
  const ok = {
    'new rule 5 present': after.rules.includes('DECIDES LHF FROM RHF'),
    'old rule 5 gone': !after.rules.includes(OLD_TV),
    'appendix present exactly once': marks === 1,
    'hatched-armrest rule still there': after.rules.includes('IS AN ARMREST'),
    'bedframe section still there': after.rules.includes('THE THREE HEIGHTS'),
    'row only grew': after.len >= row.len,
  };
  console.log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    console.log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  console.log(`  length ${row.len} -> ${after.len}`);
  if (bad) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  console.log('VERIFY OK — the scanner reads the TV before it reads an arm.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
