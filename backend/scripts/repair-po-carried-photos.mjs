#!/usr/bin/env node
/* Re-align a PO line's CARRIED photos to its source SO line's current photos.

   THE BUG (docs/bugs/0789). A PO line copies the SO line's `photo_urls` at
   convert time (mfg-purchase-orders.ts) and a revision PRESERVES that copy — so
   when the SO line's photos change, or the line is replaced with a new id and a
   new photo, the PO keeps a STALE `so-items/<old>/...` key whose R2 object is
   gone, and the PO photo strip renders "err". Carried photos are read-only,
   authored on the SO, so the PO should MIRROR the SO line's CURRENT photos.
   Observed on HC-PO-2609-049 line 9028-2A(RHF): PO carried
   `so-items/HC-SO-012016/de3dbc2f.../ac-824937-1.jpg` (old line, object gone)
   while the SO line now holds `.../62db736a.../de1a8463....jpg`.

   SCOPE — narrow and reversible-by-nature:
     * Only PO lines that carry a `so-items/` key NOT present in the linked SO
       line's current `photo_urls` (the stale ones). Not "every PO line".
     * Only the `photo_urls` column, set to (the PO's OWN `po-items/` uploads) +
       (the linked SO line's CURRENT photos). Never a price, qty, status or date.
     * A dangling `so_item_id` (SO line deleted) is LEFT and reported — the
       current photos cannot be resolved, so it is not this script's to guess.

   RE-RUN: idempotent. A second run re-reads the same candidates, finds each PO
   line's carried keys already equal to the SO line's photos, plans zero fixes
   and writes nothing. The target is derived from the live SO line, not from the
   current PO row, so there is no state to double-apply.

   Gate: MODE=plan by default (no writes). MODE=apply requires
   CONFIRM="REPAIR PO CARRIED PHOTOS". After writing, a FRESH connection re-reads
   each fixed line and asserts its `photo_urls` now equals the desired array (a
   row count is not a shape). Exit 0 for every legitimate answer; non-zero only
   for an unreachable DB, a bad CONFIRM, or a failed verify.

   Env: DATABASE_URL (the only credential). MODE=apply + CONFIRM to write. */
import postgres from 'postgres';
import { planPhotoResync, verifyPhotoResync } from './lib/po-carried-photo-resync.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REPAIR PO CARRIED PHOTOS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (no writes)'}`);

  // Candidate set: PO lines that carry a `so-items/` key NOT in the linked SO
  // line's current photo_urls (a stale carried key), with the SO line's current
  // photos to re-sync to.
  const rows = await sql`
    SELECT pi.id::text          AS "poLineId",
           po.po_number         AS "poNumber",
           pi.item_code         AS "itemCode",
           pi.photo_urls        AS "poPhotoUrls",
           (si.id IS NOT NULL)  AS "soLineExists",
           si.photo_urls        AS "soPhotoUrls"
    FROM scm.purchase_order_items pi
    JOIN scm.purchase_orders po           ON po.id = pi.purchase_order_id
    LEFT JOIN scm.mfg_sales_order_items si ON si.id = pi.so_item_id
    WHERE pi.so_item_id IS NOT NULL
      AND pi.photo_urls IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM unnest(pi.photo_urls) k
        WHERE k LIKE 'so-items/%' AND NOT (k = ANY(COALESCE(si.photo_urls, '{}')))
      )
  `;
  note(`candidate PO lines (carrying a stale SO photo key): ${rows.length}`);

  const { toFix, skipped } = planPhotoResync(rows);
  note(`to re-sync: ${toFix.length}   left alone: ${skipped.length}`);
  for (const f of toFix) note(`  ${f.poNumber}  ${f.itemCode}  [${f.from.join(', ')}] -> [${f.to.join(', ')}]`);
  for (const s of skipped) note(`  skip ${s.poLineId}: ${s.reason}`);

  if (toFix.length === 0) { note('nothing to repair.'); await sql.end(); return; }

  if (!APPLY) {
    note(`\nPLAN only. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
    await sql.end();
    return;
  }

  // APPLY — one UPDATE per line, `photo_urls` ONLY.
  let wrote = 0;
  for (const f of toFix) {
    const res = await sql`UPDATE scm.purchase_order_items SET photo_urls = ${f.to} WHERE id = ${f.poLineId}`;
    wrote += res.count;
  }
  note(`wrote ${wrote} row(s).`);
  await sql.end();

  // VERIFY on a FRESH connection, asserting the SHAPE (each line's photo_urls now
  // equals the desired array we wrote), not a row count.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const afterByLineId = new Map();
    for (const f of toFix) {
      const [row] = await check`SELECT photo_urls FROM scm.purchase_order_items WHERE id = ${f.poLineId}`;
      afterByLineId.set(f.poLineId, row ? row.photo_urls : null);
    }
    const failures = verifyPhotoResync(toFix, afterByLineId);
    if (failures.length) {
      bad(`verify FAILED for ${failures.length} line(s): ${failures.join(', ')}`);
      process.exitCode = 1;
    } else {
      note(`verify OK — all ${toFix.length} line(s) now carry the SO line's current photos.`);
    }
  } finally {
    await check.end();
  }
}

main().catch((e) => { bad(e?.message ?? String(e)); process.exit(1); });
