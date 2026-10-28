#!/usr/bin/env node
/* check-imported-field-coverage — did the fields actually come across?
 *
 * WHY IT EXISTS. The owner, 2026-09-04: 「然后我的 description 2 的也进来 erp 了？」
 *
 * It is the same question he has now asked in three shapes in one day — did the
 * delivery orders come across, did their lines come across, did Description 2
 * come across — and every time the honest answer needed a COUNT, not a reading
 * of the importer. Twice today I answered from the code and was refuted by the
 * data within the hour. So this is the count, for the fields a person can see on
 * a document, and it will answer the next one of these without another build.
 *
 * WHAT `description2` IS, in the owner's terms: AutoCount's Desc2 — the free
 * text under the item that carries a sofa's build, a colour, a spec note. It is
 * not decoration: the sofa collapse ECHOES the stored original back to AutoCount
 * rather than reconstructing it (autocount-sofa-collapse.ts), because a
 * reconstruction corrupted 0.59% of builds when it was measured. If that text
 * had not arrived, that whole path would be running on nothing.
 *
 * PRESENT vs USEFUL. A blank Desc2 is not automatically a loss — plenty of
 * ordinary lines never had one. So the number that means something is the share
 * of lines carrying text, reported beside the total, per company and per
 * document type. A reader can then judge it against what AutoCount holds.
 *
 * READ-ONLY. SELECTs on one connection, no DDL, no writes, no transaction.
 * Exit 0 for every legitimate answer; non-zero only for an unreachable database.
 *
 * SAFE IN A PUBLIC LOG. Counts only. It never prints the text of a description,
 * an item code, a customer or an amount — the whole point is the SHARE, and the
 * content is exactly what must not travel.
 *
 * RE-RUN: idempotent. It reads and prints, and holds no state between runs.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

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
  console.error('check-imported-field-coverage: no DATABASE_URL.');
  process.exit(1);
}

const pg = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
const note = (s) => console.log(`::notice::${s}`);
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

try {
  /* SALES ORDER LINES. Scoped by the header's company — the line table has no
     company column of its own, so the join IS the tenant predicate here. */
  const so = await pg`
    SELECT h.company_id,
           count(*)::int AS lines,
           count(*) FILTER (WHERE coalesce(trim(i.description2), '') <> '')::int AS desc2,
           count(*) FILTER (WHERE coalesce(trim(i.description), '') <> '')::int AS descr,
           count(*) FILTER (WHERE i.variants IS NOT NULL)::int AS variants,
           count(*) FILTER (WHERE i.linked_ac_dtlkey IS NOT NULL)::int AS keyed
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     GROUP BY h.company_id ORDER BY h.company_id`;
  note('SALES ORDER LINES — how many carry each field:');
  for (const r of so) {
    note(`  company ${r.company_id}: ${r.lines} line(s)`);
    note(`    Description 2 (AutoCount Desc2): ${r.desc2}  (${pct(r.desc2, r.lines)})`);
    note(`    Description:                     ${r.descr}  (${pct(r.descr, r.lines)})`);
    note(`    variants (colour/size/build):    ${r.variants}  (${pct(r.variants, r.lines)})`);
    note(`    AutoCount line key:              ${r.keyed}  (${pct(r.keyed, r.lines)})`);
  }

  /* PURCHASE ORDER LINES. The PO importer writes the sofa Desc2 onto every
     compartment row, so a low share here is a different fact from a low share
     above and the two must not be averaged together. */
  const po = await pg`
    SELECT h.company_id,
           count(*)::int AS lines,
           count(*) FILTER (WHERE coalesce(trim(i.description2), '') <> '')::int AS desc2,
           count(*) FILTER (WHERE coalesce(trim(i.description), '') <> '')::int AS descr,
           count(*) FILTER (WHERE i.linked_ac_dtlkey IS NOT NULL)::int AS keyed
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     GROUP BY h.company_id ORDER BY h.company_id`;
  note('PURCHASE ORDER LINES — how many carry each field:');
  for (const r of po) {
    note(`  company ${r.company_id}: ${r.lines} line(s)`);
    note(`    Description 2 (AutoCount Desc2): ${r.desc2}  (${pct(r.desc2, r.lines)})`);
    note(`    Description:                     ${r.descr}  (${pct(r.descr, r.lines)})`);
    note(`    AutoCount line key:              ${r.keyed}  (${pct(r.keyed, r.lines)})`);
  }

  /* THE SOFA LINES ON THEIR OWN, because they are the ones whose Desc2 is not
     optional. A sofa compartment's build lives in that text and the collapse
     echoes it back to the account book; a blank there is a real gap, while a
     blank on a mattress line usually is not. Matched on the compartment suffix
     the splitter uses, so this counts the same rows the sofa path does. */
  const sofa = await pg`
    SELECT h.company_id,
           count(*)::int AS lines,
           count(*) FILTER (WHERE coalesce(trim(i.description2), '') <> '')::int AS desc2
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE i.item_code ~ '-(1S|2S|3S|1A|2A|3A|CNR|OTT|CHS|LHF|RHF)(\\(|$)'
     GROUP BY h.company_id ORDER BY h.company_id`;
  note('SOFA COMPARTMENT LINES — where Desc2 is NOT optional (it carries the build):');
  if (!sofa.length) note('  none matched the compartment pattern');
  for (const r of sofa) {
    note(`  company ${r.company_id}: ${r.lines} sofa line(s), ${r.desc2} carry Desc2`
      + `  (${pct(r.desc2, r.lines)})`);
  }
} catch (e) {
  console.error(`check-imported-field-coverage: the database could not be read — ${e.message}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
