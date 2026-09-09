// Shorten the special-order text on the six lines the account book refuses for
// being over its 100-character Further Description.
//
// THE OWNER APPROVED EACH WORDING, 2026-09-09, on the listing produced by
// check-too-long-for-the-book.mjs: 「bedframe 你给的三个方案都ok」 and 「这个全部
// 没问题」. Nothing here is invented — every replacement below is the text he
// signed off, and two of them are simply DELETING a sentence that repeats what
// the line already says:
//
//   HC-SO-007678 · "Customer would like to customize the front divan with one
//     drawer on the left and one drawer on the right" says exactly what
//     "Left Drawer + Right Drawer" already says, twice over.
//   HC-PO-2609-017 · "HB back fully covered" and "HB Fully Cover" are one
//     instruction written twice.
//
// DESC2 IS A FACTORY BUILD INSTRUCTION. A wrong one builds wrong goods, so this
// refuses to touch a line whose CURRENT rendering is not character-for-character
// the text the owner was shown. If somebody edited the line in between, the
// approval was for different words and this stops.
//
//   MODE=plan (default)   read, render before and after, write nothing
//   APPLY=1               write; CONFIRM must equal the number of lines planned
//
// RE-RUN: idempotent. A second run finds every line already at its shortened
// wording, renders it unchanged, and reports "nothing to do" — the precondition
// is the ORIGINAL text, so a line already shortened no longer matches and is
// skipped rather than shortened twice.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { buildVariantSummary } from '../src/scm/shared/variant-summary.ts';
import { AC_DESC2_MAX } from '../src/services/autocount-sofa-collapse.ts';

/**
 * THE APPROVED EDITS, one per line, keyed by what is on that line today.
 *
 * `wasRendered` is the precondition and the whole safety of this script: it is
 * the exact string the owner read before he approved. `specials` is what
 * replaces `variants.specials`, and nothing else on the line is touched — not
 * the fabric code, not the divan, not the gap, not the heights.
 */
const EDITS = [
  {
    docNo: 'HC-SO-007678',
    itemCode: 'HILTON (A)-(K)',
    wasRendered: 'KS-16 ICE STEEL / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20" / SPECIAL: Left Drawer + Right Drawer + Customer would like to customize the front divan with one drawer on the left and one drawer on the right.',
    specials: ['Left Drawer', 'Right Drawer'],
  },
  {
    docNo: 'HC-SO-007678',
    itemCode: 'FENRIR-(Q)',
    wasRendered: 'KS-18 GRAPHITE STONE / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20" / SPECIAL: Left Drawer + Right Drawer + Customer would like to customize the front divan with one drawer on the left and one drawer on the right.',
    specials: ['L Drawer', 'R Drawer'],
  },
  {
    docNo: 'HC-SO-012312',
    itemCode: 'TRION (A)-(SK)',
    wasRendered: 'PC151-11 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24" / SPECIAL: HB Fully Cover + Divan Full Cover + Right Drawer',
    specials: ['HB FC', 'Divan FC', 'R Drawer'],
  },
  {
    docNo: 'HC-SO-012312',
    itemCode: 'HILTON (A)-(Q)',
    wasRendered: 'PC151-01 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24" / SPECIAL: HB Fully Cover + Divan Full Cover + Right Drawer',
    specials: ['HB FC', 'Divan FC', 'R Drawer'],
  },
  {
    docNo: 'HC-SO-012312',
    itemCode: 'HILTON (A)-(Q)',
    wasRendered: 'PC151-02 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24" / SPECIAL: HB Fully Cover + Divan Full Cover + Right Drawer',
    specials: ['HB FC', 'Divan FC', 'R Drawer'],
  },
  {
    docNo: 'HC-PO-2609-017',
    itemCode: 'TRION (A) (HB STR)-(K)',
    wasRendered: 'PC151-11 / DIVAN 8" + LEG 0" / GAP 12" / T.Heights 20" / SPECIAL: HB back fully covered + HB Fully Cover',
    specials: ['HB Fully Cover'],
  },
];

const APPLY = process.env.APPLY === '1';
const CONFIRM = (process.env.CONFIRM || '').trim();

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(1);
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

/** What the write-back would send for this row. A stored description2 wins
 *  verbatim — the echo path — so it is what gets measured when present. */
const renderOf = (row) => {
  const stored = String(row.description2 ?? '').trim();
  return stored || buildVariantSummary(row.item_group ?? '', row.variants ?? null);
};

try {
  const soNos = [...new Set(EDITS.filter((e) => !e.docNo.includes('-PO-')).map((e) => e.docNo))];
  const poNos = [...new Set(EDITS.filter((e) => e.docNo.includes('-PO-')).map((e) => e.docNo))];

  /* Ordered the way the write-back orders lines — created_at then id — so the
     position printed here is the position on the document. */
  const soRows = soNos.length
    ? await pg`SELECT 'so' AS side, doc_no, id, item_code, item_group, variants, description2
                 FROM scm.mfg_sales_order_items
                WHERE doc_no = ANY(${soNos})
                ORDER BY doc_no, created_at, id`
    : [];
  const poRows = poNos.length
    ? await pg`SELECT 'po' AS side, p.po_number AS doc_no, pi.id, pi.item_code, pi.item_group,
                      pi.variants, pi.description2
                 FROM scm.purchase_order_items pi
                 JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
                WHERE p.po_number = ANY(${poNos})
                ORDER BY p.po_number, pi.created_at, pi.id`
    : [];
  const rows = [...soRows, ...poRows];

  const planned = [];
  const skipped = [];
  const claimed = new Set();
  for (const edit of EDITS) {
    /* Matched on the RENDERING, not on a position. A line number moves when
       somebody inserts a line; the text the owner approved does not. */
    const hit = rows.find((r) => r.doc_no === edit.docNo
      && String(r.item_code ?? '') === edit.itemCode
      && renderOf(r) === edit.wasRendered
      && !claimed.has(r.id));
    if (!hit) { skipped.push(edit); continue; }
    claimed.add(hit.id);
    const nextVariants = { ...(hit.variants ?? {}), specials: edit.specials };
    const after = buildVariantSummary(hit.item_group ?? '', nextVariants);
    planned.push({ row: hit, edit, after, nextVariants });
  }

  console.log(`AutoCount's field holds ${AC_DESC2_MAX} characters.`);
  console.log(`approved edits: ${EDITS.length}  ·  matched: ${planned.length}  ·  not matched: ${skipped.length}`);
  for (const p of planned) {
    console.log('');
    console.log(`${p.row.doc_no}  ${p.row.item_code}`);
    console.log(`  before ${String(p.edit.wasRendered.length).padStart(3)}  ${p.edit.wasRendered}`);
    console.log(`  after  ${String(p.after.length).padStart(3)}  ${p.after}`);
    if (p.after.length > AC_DESC2_MAX) console.log('  STILL OVER — this edit does not solve it');
  }
  for (const s of skipped) {
    console.log('');
    console.log(`${s.docNo}  ${s.itemCode}  NOT MATCHED — the line reads differently now, so the`);
    console.log('  approval was for other words. Left alone; re-read it before editing.');
  }

  /* A plan whose result would still be refused is not a plan. */
  const stillOver = planned.filter((p) => p.after.length > AC_DESC2_MAX);
  if (stillOver.length) {
    console.log('');
    console.log(`REFUSING: ${stillOver.length} of the planned edits would still be over the column.`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log('');
    console.log(`PLAN — nothing written. Re-run with APPLY=1 and CONFIRM=${planned.length}.`);
    process.exit(0);
  }
  if (CONFIRM !== String(planned.length)) {
    console.error('');
    console.error(`APPLY=1 needs CONFIRM to equal the number of matched edits. Got "${CONFIRM}", wanted "${planned.length}".`);
    process.exit(1);
  }

  let written = 0;
  for (const p of planned) {
    if (p.row.side === 'so') {
      await pg`UPDATE scm.mfg_sales_order_items SET variants = ${pg.json(p.nextVariants)} WHERE id = ${p.row.id}`;
    } else {
      await pg`UPDATE scm.purchase_order_items SET variants = ${pg.json(p.nextVariants)} WHERE id = ${p.row.id}`;
    }
    written += 1;
  }
  console.log('');
  console.log(`WROTE ${written} line(s).`);

  /* THE SHAPE, ON A FRESH CONNECTION. A row count would be true of a write that
     stored the old text straight back — the jsonb double-encoding repair counted
     7 of 7 while re-corrupting all 7. So each row is read back and RE-RENDERED,
     and what is asserted is that the rendering is the approved one and inside
     the column. */
  const fresh = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  try {
    let bad = 0;
    for (const p of planned) {
      const back = p.row.side === 'so'
        ? await fresh`SELECT item_group, variants, description2 FROM scm.mfg_sales_order_items WHERE id = ${p.row.id}`
        : await fresh`SELECT item_group, variants, description2 FROM scm.purchase_order_items WHERE id = ${p.row.id}`;
      const got = back[0] ? renderOf(back[0]) : null;
      const ok = got === p.after && got.length <= AC_DESC2_MAX;
      if (!ok) {
        bad += 1;
        console.log(`  ${p.row.doc_no} ${p.row.item_code}: reads back as ${got === null ? '(missing)' : `${got.length} chars`}, wanted ${p.after.length}`);
      }
    }
    console.log(`VERIFY (fresh connection): ${planned.length - bad} of ${planned.length} render exactly as planned and fit the column`);
    if (bad > 0) {
      console.log('  THAT IS A FAILURE. Do not re-send these documents; read the rows first.');
      process.exit(1);
    }
    console.log('  every line now renders the approved text, inside the column.');
    console.log('  Saving each document in the ERP re-queues it; the 5-minute cron sends it.');
  } finally {
    await fresh.end({ timeout: 5 });
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
