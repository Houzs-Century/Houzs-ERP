#!/usr/bin/env node
/* stamp-ac-line-keys-2026-09-09 — give 23 sales-order lines the account book's
 * own line key, so the ten documents holding them stop being UNEDITABLE.
 *
 * WHAT A MISSING KEY COSTS. `src/scm/lib/autocount-line-keys.ts:155` — every ERP
 * row behind one AutoCount line must carry the SAME key, and `composeEdit`
 * treats a build whose rows disagree (or hold none) as having no line identity
 * at all. So one keyless row does not cost that row: it costs the WHOLE document
 * its identity, and staff are refused with "the ERP cannot tell which lines
 * AutoCount already has". The owner asked for sales-order editing to be opened;
 * `backfill-ac-sofa-line-keys.mjs` measured the blocker on 2026-09-09 05:47
 * (run 34316280108) and reported `UNEDITABLE AFTER: 8 migrated sales order(s)`,
 * having stamped zero rows.
 *
 * WHY THAT SCRIPT STAMPS NOTHING HERE, AND WHY THIS ONE MAY.
 * `lib/ac-forced-line-pairing.mjs` stamps only where the DOCUMENT forces the
 * answer, and it is right to refuse these. Its own run named two of them:
 *     split, untouched by this run HC-SO-013384 ...: 6 row(s) carrying (none), 914562, 914561
 *     split, untouched by this run HC-SO-012025 ...: 5 row(s) carrying (none), 829179, 829180
 * Two book lines, rows split across them, and nothing in the DOCUMENT says which
 * unkeyed row belongs to which. That refusal must not be loosened — a pairing
 * rule that guesses is docs/bugs/0708, and a key pair is not an identity match
 * (docs/bugs/0671).
 *
 * What resolves it is evidence from OUTSIDE the document, one source per case,
 * and each is recorded against the row below:
 *
 *   RULED   the owner has already adjudicated the build. The sales-order verdict
 *           (run 34336644061) prints it: "the owner ruled 1A(LHF)+1NA+CNR+1A(RHF)
 *           and the ERP does NOT hold it". The ERP holds those pieces as separate
 *           rows; only the grouping was missing. His ruling is what forces it,
 *           and it forces it uniquely — pairing the two 1NA rows together on
 *           HC-SO-013384 would build 1A(LHF)+1NA+1NA, which is NOT what he ruled.
 *   DESC2   the owner, 2026-09-09: 「如果没有图片的就看description 2」. HC-SO-013145
 *           carries no drawing in the book (FurtherDescription is a 115-byte
 *           empty RTF shell, checked on the live book) and its own Desc2 states
 *           the builds: rows 1 and 2 read `1R+2R`, row 3 reads `2S`. The money
 *           agrees independently — book line 891939 holds RM 7,200 and so does
 *           ERP row 1, which is the `1R+2R` one.
 *   ONE     exactly one book line on that document is unclaimed and it matches on
 *           quantity AND price. Four delivery fees (RM 50 / 150 / 400 / 200) and
 *           two whole documents are this shape.
 *
 * NOT IN THIS SCRIPT, and the owner said so twice: HC-SO-012312. Its book line
 * `BEDFRAME` qty 2 "BEDFRAME KIV" is one line against the ERP's two HILTON (A)-(Q)
 * rows, and the second carries RM 250 the book does not. That is money, and
 * 「SO12312 有人会处理」.
 *
 * A KEY IS IDENTITY, NOT VALUE. This writes one column, `linked_ac_dtlkey`, and
 * nothing else. No quantity, no price, no status, no stock — 「库存先不看」 is
 * respected by construction, and the verification below asserts the whole table's
 * money and quantities are byte-identical afterwards.
 *
 * NOTHING IS SENT TO AUTOCOUNT BY THIS SCRIPT. `enqueueAcEdit` runs on the API
 * save path; no trigger on `scm.mfg_sales_order_items` writes to
 * `scm.autocount_outbox` (checked on production 2026-09-09 against pg_trigger),
 * so a direct row update enqueues nothing. The documents become editable; what
 * reaches the book after that is a person's save, which is the point.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN. Plan writes nothing and prints every row.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   The UPDATE is PINNED: it matches on doc_no, line_no, item_code, qty AND
 *   unit_price_sen, and requires linked_ac_dtlkey IS NULL. If any one of the 23
 *   rows fails to match, the script writes NOTHING and exits non-zero — a row
 *   that moved since the manifest was measured is a finding, not something to
 *   work around.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: each of
 *   the nine documents holds zero keyless lines, each stamped book line's
 *   compartment multiset is exactly the expected one, and the table's money and
 *   quantities are unchanged.
 *
 * RE-RUN: idempotent. Every UPDATE carries `linked_ac_dtlkey IS NULL`, so a
 * second run matches nothing, writes nothing, and its manifest check reports the
 * rows as already stamped rather than as missing.
 *
 * Env:  DATABASE_URL (required)
 *       MODE=plan|apply (default plan)
 *       CONFIRM (required when MODE=apply)
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/stamp-ac-line-keys-2026-09-09.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='stamp ac line keys 2026-09-09' \
 *     node backend/scripts/stamp-ac-line-keys-2026-09-09.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'stamp ac line keys 2026-09-09';
const APPLY = MODE === 'apply';

/* doc_no, line_no, item_code, qty, unit_price_sen, dtlkey, why
   Measured against production 2026-09-09 (read-only DSN) and against the live
   AED_HOUZS book over ZeroTier. `why` is the evidence class in the header. */
const MANIFEST = [
  ['HC-SO-000015', 1, 'AKEMI FORTRESS MATT (K)', 1, 909900, 123387, 'ONE'],
  ['HC-SO-000015', 2, 'AKEMI BASTION MATT (SP)', 1, 0, 123388, 'ONE'],
  ['HC-SO-000015', 3, 'JAGER-(Q)', 1, 0, 123389, 'ONE'],

  ['HC-SO-000102', 4, 'TRANSPORTATION CHARGES', 1, 5000, 15971, 'ONE'],
  ['HC-SO-001180', 10, 'TRANSPORTATION CHARGES', 1, 15000, 80259, 'ONE'],
  ['HC-SO-001463', 4, 'TRANSPORTATION CHARGES', 1, 40000, 98461, 'ONE'],
  ['HC-SO-001473', 5, 'TRANSPORTATION CHARGES', 1, 20000, 98859, 'ONE'],

  ['HC-SO-012025', 6, '9050-1NA', 1, 0, 829179, 'RULED'],
  ['HC-SO-012025', 7, '9050-CNR', 1, 0, 829179, 'RULED'],
  ['HC-SO-012025', 8, '9050-1A(RHF)', 1, 0, 829179, 'RULED'],

  ['HC-SO-013145', 1, '9021-1A(R)(LHF)', 1, 720000, 891939, 'DESC2'],
  ['HC-SO-013145', 2, '9021-2A(RHF)', 1, 0, 891939, 'DESC2'],
  ['HC-SO-013145', 3, '9021-2S', 1, 0, 891940, 'DESC2'],

  ['HC-SO-013384', 5, '8030-1NA', 1, 0, 914561, 'RULED'],
  ['HC-SO-013384', 6, '8030-1A(RHF)', 1, 0, 914561, 'RULED'],
  ['HC-SO-013384', 7, '8030-1NA', 1, 0, 914562, 'RULED'],
  ['HC-SO-013384', 8, '8030-1A(RHF)', 1, 0, 914562, 'RULED'],

  ['HC-SO-2609-011', 0, 'DUNLOPILLO CLASSIC DREAM VALLEY MATT (Q)', 1, 488800, 927736, 'ONE'],
  ['HC-SO-2609-011', 1, 'CODY-(Q)', 1, 0, 927739, 'ONE'],
  ['HC-SO-2609-011', 2, 'NTYR-CL MX MICR PIL', 2, 0, 927740, 'ONE'],
  ['HC-SO-2609-011', 3, 'DL-MP(Q)', 1, 0, 927738, 'ONE'],
  ['HC-SO-2609-011', 4, 'HB109NL', 1, 0, 927735, 'ONE'],
  ['HC-SO-2609-011', 5, 'DL-WHITE BOLSTER', 1, 0, 927737, 'ONE'],
];

/* What each stamped book line must hold AFTERWARDS, as a sorted multiset of item
   codes. This is the shape the verification asserts — a row count cannot tell a
   correct grouping from a wrong one, and the wrong grouping on HC-SO-013384 has
   the same count as the right one. */
const EXPECTED_BUILD = {
  829179: ['9050-1A(LHF)', '9050-1A(RHF)', '9050-1NA', '9050-CNR'],
  891939: ['9021-1A(R)(LHF)', '9021-2A(RHF)'],
  891940: ['9021-2S'],
  914561: ['8030-1A(LHF)', '8030-1A(RHF)', '8030-1NA'],
  914562: ['8030-1A(LHF)', '8030-1A(RHF)', '8030-1NA'],
};

const DOCS = [...new Set(MANIFEST.map((r) => r[0]))];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

/** The whole table's money and quantities, so "identity, not value" is proven. */
async function moneyShape(conn) {
  const [r] = await conn`
    SELECT count(*)::int AS rows,
           coalesce(sum(qty), 0)::text AS qty,
           coalesce(sum(unit_price_sen), 0)::text AS unit_price_sen,
           coalesce(sum(total_sen), 0)::text AS total_sen,
           count(*) FILTER (WHERE coalesce(cancelled, false))::int AS cancelled
      FROM scm.mfg_sales_order_items`;
  return r;
}

try {
  console.log(`MODE=${MODE}  ${MANIFEST.length} row(s) across ${DOCS.length} document(s)`);
  const before = await moneyShape(sql);

  console.log('\n=== THE PLAN, row by row ===');
  let missing = 0;
  let already = 0;
  for (const [doc, lineNo, item, qty, priceSen, dtlkey, why] of MANIFEST) {
    const [row] = await sql`
      SELECT id, linked_ac_dtlkey, qty, unit_price_sen, item_code
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${doc} AND line_no = ${lineNo}
         AND coalesce(cancelled, false) = false`;
    if (!row) {
      console.log(`  MISSING  ${doc} #${lineNo} ${item} — no such live line`);
      missing += 1;
      continue;
    }
    const same = row.item_code === item
      && Number(row.qty) === qty
      && Number(row.unit_price_sen ?? 0) === priceSen;
    if (!same) {
      console.log(`  MOVED    ${doc} #${lineNo} — manifest says ${item} qty ${qty} `
        + `RM ${(priceSen / 100).toFixed(2)}, the row holds ${row.item_code} qty ${row.qty} `
        + `RM ${(Number(row.unit_price_sen ?? 0) / 100).toFixed(2)}`);
      missing += 1;
      continue;
    }
    if (row.linked_ac_dtlkey != null) {
      const ok = Number(row.linked_ac_dtlkey) === dtlkey;
      console.log(`  ${ok ? 'ALREADY ' : 'CONFLICT'} ${doc} #${lineNo} ${item} — carries `
        + `${row.linked_ac_dtlkey}${ok ? ' (this run\'s value)' : `, manifest says ${dtlkey}`}`);
      if (!ok) missing += 1;
      else already += 1;
      continue;
    }
    console.log(`  STAMP    ${doc} #${lineNo} ${item.padEnd(42)} -> ${dtlkey}   [${why}]`);
  }

  if (missing > 0) {
    console.error(`\nREFUSED: ${missing} manifest row(s) do not match the database. `
      + 'Nothing was written — re-measure before repairing.');
    await sql.end();
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\nPLAN ONLY — nothing was written. (${already} row(s) already carry their key.)`);
    await sql.end();
    process.exit(0);
  }

  let stamped = 0;
  for (const [doc, lineNo, item, qty, priceSen, dtlkey] of MANIFEST) {
    const done = await sql`
      UPDATE scm.mfg_sales_order_items
         SET linked_ac_dtlkey = ${dtlkey}
       WHERE doc_no = ${doc} AND line_no = ${lineNo}
         AND item_code = ${item}
         AND qty = ${qty}
         AND coalesce(unit_price_sen, 0) = ${priceSen}
         AND coalesce(cancelled, false) = false
         AND linked_ac_dtlkey IS NULL
      RETURNING id`;
    stamped += done.length;
  }
  console.log(`\nAPPLIED: ${stamped} row(s) stamped.`);
  await sql.end();

  /* FRESH CONNECTION. Nothing below may read this process's own transaction. */
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

  const keyless = await check`
    SELECT doc_no, count(*)::int AS n
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${DOCS}) AND coalesce(cancelled, false) = false
       AND linked_ac_dtlkey IS NULL
     GROUP BY 1 ORDER BY 1`;

  const builds = await check`
    SELECT linked_ac_dtlkey::text AS key,
           array_agg(item_code ORDER BY item_code) AS items
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${DOCS}) AND coalesce(cancelled, false) = false
       AND linked_ac_dtlkey = ANY(${Object.keys(EXPECTED_BUILD).map(Number)})
     GROUP BY 1 ORDER BY 1`;

  const after = await moneyShape(check);
  await check.end();

  console.log('\n=== VERIFY (fresh connection) ===');
  console.log(`  documents still holding a keyless line : ${keyless.length}   (want 0)`);
  for (const k of keyless) console.log(`     ${k.doc_no}  ${k.n}`);

  let shapeBad = 0;
  for (const [key, want] of Object.entries(EXPECTED_BUILD)) {
    const got = builds.find((b) => b.key === key);
    const list = (got?.items ?? []).slice().sort();
    const ok = list.length === want.length && list.every((x, i) => x === want[i]);
    if (!ok) shapeBad += 1;
    console.log(`  build ${key}: ${ok ? 'OK  ' : 'WRONG'} ${list.join(' + ') || '(none)'}`);
    if (!ok) console.log(`     wanted: ${want.join(' + ')}`);
  }

  const moneySame = before.rows === after.rows
    && before.qty === after.qty
    && before.unit_price_sen === after.unit_price_sen
    && before.total_sen === after.total_sen
    && before.cancelled === after.cancelled;
  console.log(`  money and quantities unchanged        : ${moneySame ? 'YES' : 'NO'}`);
  if (!moneySame) {
    console.log(`     before ${JSON.stringify(before)}`);
    console.log(`     after  ${JSON.stringify(after)}`);
  }

  if (keyless.length !== 0 || shapeBad !== 0 || !moneySame) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  console.log('VERIFY OK — a line key is identity, not value.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
