#!/usr/bin/env node
/* Live lines still naming a colour that was RETIRED. Find them, move them.

   THIS IS THE DIRT THE PREVIOUS CLEANUPS LEFT. A merge has two halves: retire
   the losing colour, and repoint everything that names it. The 2026-08-11 pass
   did the first half against a sweep that knew FOUR document arms out of
   fifteen — so it superseded the colour and left live documents pointing at a
   row that no longer exists in any picker.

   The census found it on prod before this script was written:

     BO315-2-FEATHER   3 scm.mfg_sales_order_items   (variants)
                       3 scm.purchase_order_items    (variants)
                       3 scm.inventory_movements     (variant_key)
                       3 scm.inventory_lots          (variant_key)
                       1 scm.fabric_colours          (the row, already inactive)

   And it is invisible to a duplicate DETECTOR, which is why nobody caught it:
   the retired row is not a duplicate any more, it is a merge that already
   happened. merge-duplicate-fabric-colours.mjs deliberately excludes inactive
   rows for exactly that reason, so it will never report these. They have to be
   looked for from the other end — by asking which retired colours are still
   NAMED — and that is what this does.

   ── WHERE THE TARGET COMES FROM ──────────────────────────────────────────
   Not from a guess. When a colour is superseded the label records what
   absorbed it, verbatim:

     "BO315-2-FEATHER [MERGED into BO315-02 on 2026-08-11 - superseded, not deleted]"

   so the destination is READ OUT OF THE LABEL, and a row whose label does not
   carry that marker is REFUSED and listed rather than sent somewhere plausible.
   The target is then checked to exist, to be ACTIVE, and to sit in the same
   series — a repoint onto a second retired row would just move the problem.

   ── WHY IT MOVES STOCK TOO ───────────────────────────────────────────────
   variant_key materialises the colour into the physical stock bucket at post
   time and is compared, never recomputed. Repointing the documents alone is
   what leaves a sofa unable to match its own on-hand, so the lots move in the
   same transaction as the lines, along with the printed description2 and the
   model's colour whitelist.

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", runs one transaction per colour, and
   verifies on a fresh connection. Nothing is deleted and nothing is
   re-activated: the retired row stays retired, which is the point.

   RE-RUN: inert. A line is in scope only while it names a retired colour, which the repoint changes. */
import postgres from 'postgres';
import {
  repointColour, repointDescription2, repointVariantKey, repointAllowedOptions,
  countColour, arrayShapeCheck, skippedArms, sum, busy,
} from './lib/fabric-write.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** The colour that absorbed this one, as recorded in its own label. Both stamp
 *  wordings that exist in prod are accepted; anything else returns null and the
 *  row is refused rather than guessed at. */
const absorbedBy = (label) => {
  const m = /\[MERGED into ([^\]]+?) on \d{4}-\d{2}-\d{2}/i.exec(String(label ?? ''))
        || /\[superseded by ([^\]]+?) on \d{4}-\d{2}-\d{2}/i.exec(String(label ?? ''));
  return m ? m[1].trim() : null;
};

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  const cols = await sql`SELECT fabric_id, colour_id, label, active
                           FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const active = new Map(cols.filter((c) => c.active !== false).map((c) => [String(c.colour_id).toUpperCase(), c]));
  const retired = cols.filter((c) => c.active === false);
  note(`\nfabric_colours: ${cols.length}  (active ${cols.length - retired.length}, retired ${retired.length})`);

  /* Ask each RETIRED colour whether anything still names it. Only the ones
     that do are a problem — a quietly retired colour with no references is a
     completed merge. */
  const work = [], refused = [];
  for (const r of retired) {
    const n = sum(await countColour(sql, CO, r.colour_id));
    if (!n) continue;
    const target = absorbedBy(r.label);
    if (!target) { refused.push({ ...r, n, why: 'label does not record what absorbed it' }); continue; }
    const tgt = active.get(target.toUpperCase());
    if (!tgt) { refused.push({ ...r, n, why: `"${target}" is not an ACTIVE colour` }); continue; }
    if (String(tgt.fabric_id) !== String(r.fabric_id)) {
      refused.push({ ...r, n, why: `"${target}" is in series "${tgt.fabric_id}", not "${r.fabric_id}"` });
      continue;
    }
    work.push({ ...r, n, to: tgt.colour_id });
  }

  note(`\n=== RETIRED COLOURS STILL NAMED BY LIVE LINES ===`);
  note(`  repairable: ${work.length}   refused: ${refused.length}`);
  for (const w of work.sort((a, b) => b.n - a.n)) {
    note(`    ${String(w.n).padStart(5)} line(s)  "${w.colour_id}"  ->  "${w.to}"   [${w.fabric_id}]`);
  }
  for (const r of refused) {
    note(`    REFUSED  ${String(r.n).padStart(5)} line(s)  "${r.colour_id}"  — ${r.why}`);
  }
  const skipped = skippedArms();
  if (skipped.length) {
    note(`\n  ARMS SKIPPED (absent from this database — never sweep silently):`);
    for (const s of skipped) note(`    ${s.kind.padEnd(12)} ${String(s.table).padEnd(42)} ${s.why}`);
  }
  note(`\n  total live lines stranded on a retired colour: ${work.reduce((a, w) => a + w.n, 0)}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== REPAIRING ${work.length} COLOUR(S) ===`);
  const done = [], failed = [];
  for (const w of work) {
    try {
      await sql.begin(async (tx) => {
        const moved = {
          variants: busy(await repointColour(tx, CO, w.colour_id, w.to)),
          desc2: busy(await repointDescription2(tx, CO, w.colour_id, w.to)),
          stock: busy(await repointVariantKey(tx, CO, w.colour_id, w.to)),
          models: (await repointAllowedOptions(tx, CO, w.colour_id, w.to)).n,
        };
        const left = sum(await countColour(tx, CO, w.colour_id));
        if (left) throw new Error(`${left} line(s) still name "${w.colour_id}" after the repoint`);
        done.push({ ...w, moved });
        note(`  OK  "${w.colour_id}" -> "${w.to}"  variants[${moved.variants || '-'}] desc2[${moved.desc2 || '-'}] stock[${moved.stock || '-'}] models[${moved.models}]`);
      });
    } catch (e) {
      failed.push({ ...w, why: e.message });
      bad(`FAILED "${w.colour_id}": ${e.message} (rolled back; the others stand)`);
    }
  }

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    note(`  repaired: ${done.length}   failed: ${failed.length}   refused: ${refused.length}`);
    let dirty = 0;
    for (const d of done) {
      const left = sum(await countColour(check, CO, d.colour_id));
      if (left) { bad(`  "${d.colour_id}" still named by ${left} live line(s)`); dirty += left; }
    }
    if (!dirty) note(`  no repaired colour is named by any live line on any arm`);
    for (const a of await arrayShapeCheck(check, CO)) {
      if (a.n) bad(`  ${a.arm}: ${a.n} variants block(s) of ARRAY shape — the 2026-08-10 COE shape`);
    }
    note(`\n  Then run census-fabric-colour with require_clean=1 over the repaired codes:`);
    note(`  this proves the line arms, the census proves all 51 live carriers.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
