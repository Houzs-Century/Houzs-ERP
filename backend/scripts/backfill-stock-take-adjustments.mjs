#!/usr/bin/env node
/* Backfill a Stock Adjustment DOCUMENT for every POSTED stock take that booked
   variance BEFORE the mirror-adjustment feature (PR #5869) existed, so those
   older counts also appear in the Stock Adjustments list and the take links to
   them. Writes NO stock movements — the stock already moved under the take
   (source_doc_type='STOCK_TAKE'); this records only the document that mirrors it.

   IN SCOPE. A take that is POSTED, has at least one non-zero STOCK_TAKE movement,
   and has no scm.stock_adjustments row with source_stock_take_id yet. The SA
   number reuses the take's OWN prefix and month, read straight from its take_no
   (HC-STK-2611-003 -> HC-SA-2611-NNN), numbered after that month's existing max —
   so the document lands in the same company and accounting month as the count,
   with no timezone or company-code guessing.

   MODE=plan (default) lists what it would create and writes nothing.
   MODE=apply needs CONFIRM="BACKFILL STOCK TAKE ADJUSTMENTS", inserts each take's
   header + lines in one transaction, then verifies on a FRESH connection that
   every targeted take now has exactly one mirror document whose line count equals
   its non-zero movements. COMPANY=<id> limits to one company; omitted does all.

   RE-RUN: idempotent. The NOT EXISTS (source_stock_take_id) filter skips any take
   that already has its document, so a second run finds and writes nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'BACKFILL STOCK TAKE ADJUSTMENTS';
const ONLY_CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* take_no -> { prefix, monthPrefix }. Reuses the take's own numbering so the SA
   lands in the same company (prefix) and month as the count. Null = a take_no
   this script will not number (it is then refused, not guessed). */
function saMonthPrefixFromTakeNo(takeNo) {
  const m = /^(.*?)STK-(\d{4,6})-\d+$/.exec(String(takeNo ?? ''));
  if (!m) return null;
  return `${m[1]}SA-${m[2]}`; // e.g. "HC-SA-2611"
}
const suffixOf = (docNo, monthPrefix) => {
  const tail = String(docNo).slice(monthPrefix.length + 1); // skip "<monthPrefix>-"
  return /^\d+$/.test(tail) ? parseInt(tail, 10) : 0;
};

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}${ONLY_CO ? ` company=${ONLY_CO}` : ' company=ALL'}`);

  /* Eligible takes: POSTED, have a non-zero STOCK_TAKE movement, no mirror yet. */
  const takes = await sql`
    SELECT st.id::text AS id, st.take_no, st.company_id::int AS company_id,
           st.warehouse_id::text AS warehouse_id, st.created_by::text AS created_by
      FROM scm.stock_takes st
     WHERE st.status = 'POSTED'
       AND (${ONLY_CO}::bigint IS NULL OR st.company_id = ${ONLY_CO}::bigint)
       AND EXISTS (SELECT 1 FROM scm.inventory_movements m
                    WHERE m.source_doc_type = 'STOCK_TAKE' AND m.source_doc_id = st.id AND m.qty <> 0)
       AND NOT EXISTS (SELECT 1 FROM scm.stock_adjustments sa WHERE sa.source_stock_take_id = st.id)
     ORDER BY st.company_id, st.take_no`;

  if (!takes.length) { note(`\nNothing to backfill — every eligible take already has its adjustment.`); await sql.end({ timeout: 5 }); return; }

  /* Per month-prefix running counter, seeded from the month's current max so a
     backfilled number never collides with a live-minted one. */
  const counters = new Map();
  const seedCounter = async (monthPrefix, companyId) => {
    if (counters.has(monthPrefix)) return;
    const rows = await sql`SELECT adjustment_no FROM scm.stock_adjustments
                            WHERE company_id = ${companyId} AND adjustment_no LIKE ${monthPrefix + '-%'}`;
    let max = 0;
    for (const r of rows) { const n = suffixOf(r.adjustment_no, monthPrefix); if (n > max) max = n; }
    counters.set(monthPrefix, max);
  };

  const plan = [];
  const refused = [];
  for (const t of takes) {
    const monthPrefix = saMonthPrefixFromTakeNo(t.take_no);
    if (!monthPrefix) { refused.push({ ...t, why: `take_no "${t.take_no}" does not match <prefix>STK-<yymm>-<n>` }); continue; }
    // eslint-disable-next-line no-await-in-loop -- one small read per distinct month, memoised
    await seedCounter(monthPrefix, t.company_id);
    const next = counters.get(monthPrefix) + 1;
    counters.set(monthPrefix, next);
    const adjustmentNo = `${monthPrefix}-${String(next).padStart(3, '0')}`;
    // eslint-disable-next-line no-await-in-loop -- one read per eligible take; the set is small (historical takes)
    const lines = await sql`
      SELECT item_code, product_name, variant_key, qty::int AS qty, unit_cost_sen::int AS unit_cost_sen
        FROM scm.inventory_movements
       WHERE source_doc_type = 'STOCK_TAKE' AND source_doc_id = ${t.id} AND qty <> 0
       ORDER BY item_code, variant_key`;
    plan.push({ take: t, adjustmentNo, lines: lines.map((l) => ({ ...l })) });
  }

  note(`\n=== WOULD CREATE ${plan.length} adjustment document(s) ===`);
  for (const p of plan) {
    note(`  ${p.adjustmentNo}  <- ${p.take.take_no}  (co ${p.take.company_id}, ${p.lines.length} line(s))`);
  }
  for (const r of refused) bad(`  REFUSED ${r.take_no} (${r.id}) — ${r.why}`);
  note(`\n  to create: ${plan.length}   refused: ${refused.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== CREATING ${plan.length} DOCUMENT(S) ===`);
  let wrote = 0;
  for (const p of plan) {
    const t = p.take;
    // eslint-disable-next-line no-await-in-loop -- one small transaction per document; sequential keeps numbering deterministic
    await sql.begin(async (tx) => {
      const [hdr] = await tx`
        INSERT INTO scm.stock_adjustments (adjustment_no, company_id, warehouse_id, notes, created_by, source_stock_take_id)
        VALUES (${p.adjustmentNo}, ${t.company_id}, ${t.warehouse_id},
                ${`Backfilled from stock take ${t.take_no}`}, ${t.created_by}, ${t.id})
        RETURNING id::text AS id`;
      for (let i = 0; i < p.lines.length; i++) {
        const l = p.lines[i];
        // eslint-disable-next-line no-await-in-loop -- one insert per line inside the document's own transaction
        await tx`
          INSERT INTO scm.stock_adjustment_lines
            (stock_adjustment_id, company_id, line_no, item_code, product_name, variant_key, qty, unit_cost_sen, reason_code, notes)
          VALUES (${hdr.id}, ${t.company_id}, ${i + 1}, ${l.item_code}, ${l.product_name ?? null},
                  ${l.variant_key ?? ''}, ${l.qty}, ${l.unit_cost_sen ?? null}, ${'COUNT'}, ${`Stock take ${t.take_no}`})`;
      }
    });
    wrote += 1;
    note(`  OK ${p.adjustmentNo} <- ${t.take_no}`);
  }
  note(`  written: ${wrote} of ${plan.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let okShape = 0;
    const problems = [];
    for (const p of plan) {
      // eslint-disable-next-line no-await-in-loop -- one verify read per created document
      const [row] = await check`
        SELECT sa.adjustment_no,
               (SELECT COUNT(*)::int FROM scm.stock_adjustment_lines sal WHERE sal.stock_adjustment_id = sa.id) AS line_count
          FROM scm.stock_adjustments sa
         WHERE sa.source_stock_take_id = ${p.take.id}`;
      if (!row) { problems.push(`${p.take.take_no}: no mirror document after apply`); continue; }
      if (row.line_count !== p.lines.length) { problems.push(`${p.take.take_no}: ${row.line_count} lines, expected ${p.lines.length}`); continue; }
      okShape += 1;
    }
    /* Exactly one mirror per eligible take, with the right line count — shape,
       not a row tally. */
    const [[dupes]] = [await check`
      SELECT COUNT(*)::int AS n FROM (
        SELECT source_stock_take_id FROM scm.stock_adjustments
         WHERE source_stock_take_id IS NOT NULL
         GROUP BY source_stock_take_id HAVING COUNT(*) > 1) d`];
    note(`  documents verified (right line count): ${okShape} of ${plan.length}`);
    note(`  takes with MORE THAN ONE mirror document: ${dupes.n}`);
    for (const pr of problems) bad(`  ${pr}`);
    if (dupes.n > 0) bad(`  ${dupes.n} take(s) now carry more than one mirror adjustment — investigate before re-running`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
