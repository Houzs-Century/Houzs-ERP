#!/usr/bin/env node
/* Move the Processing Date into the ONE column the ERP actually reads.

   THE OWNER'S RULE, stated more than three times and finally pinned on
   2026-08-13:

     "我不要又 proceeded_at 又 processing_date 又 internal_expected_dd。我要统一,
      就是因为这样太多 bugs 了。全部跟着 processing date 就是 UI 看到的那个。"
     "只要有 Processing Date，就代表他 Proceed 了。Proceed 的日期是他填入
      Processing Date 的日期。"
     "没有 processing date 就代表没有 proceed。"

   Proceed is a STATE, not an action with its own timestamp: the state is
   "this order has a Processing Date", and the date says when production
   starts. So there is no separate "when was the button pressed" fact worth
   gating on, and pretending there was is what produced two columns, two gates
   and two answers.

   WHAT PROD LOOKS LIKE (company 1, read 2026-08-13):
     2723 orders, 0 carry internal_expected_dd, 519 carry proceeded_at.
   internal_expected_dd is the only column soProcessingLocked reads
   (mfg-sales-orders.ts:443 `const proc = header.internal_expected_dd ?? null;
   if (!proc) return false;`) and the only one MRP reads (mrp.ts:1002). So
   today the edit lock never fires, the amendment flow is unreachable, and MRP
   sees no processing date anywhere.

   ── HOW ROWS ARE CLASSIFIED, AND WHY NOT BY SHAPE ────────────────────────
   An earlier draft of this script split imported dates from click stamps by
   TIME OF DAY: the backfill wrote `proceeded_at = ${p}::date`, which lands at
   midnight, while the button writes new Date().toISOString(). That test is
   WRONG, and measuring the source proved it: in
   backend/scripts/data/ac-outstanding-so.json.gz, 10 of the 2500 UDF_PDate
   values are not midnight (SO-010311 = "2026-07-22 01:00:00"). A real
   AutoCount processing date can carry a time, so shape cannot separate the
   two populations.

   This version does not infer. It JOINS THE SOURCE. Both AutoCount extracts
   that fed the two importers are in the repo, and a row is migrated only when
   proceeded_at MATCHES the date AutoCount holds for that document:

     ac-outstanding-so.json.gz  UDF_PDate   (import-ac-outstanding-so.mjs)
     ac-so-dates.json.gz        PDate       (backfill-so-dates.mjs)

   matched on linked_ac_docno — the same key both importers joined on.

     MATCH      -> migrate, writing AUTOCOUNT'S value, not the DB's
     DISAGREE   -> refuse. AutoCount has a date for this order but the column
                   holds a different one, so something else wrote it and this
                   script must not guess which is right.
     NO SOURCE  -> not proceeded. No AutoCount processing date exists, so the
                   value is a click stamp, and a click is not a date:
                   "没有 processing date 就代表没有 proceed".

   ── WHY A RE-RUN IS NOT SAFE ON `IS NULL` ALONE ──────────────────────────
   NULL is a reachable POST-migration state: a Super Admin can Remove the
   Processing Date, which is the sanctioned way to pull an order back out of
   Proceed (mfg-sales-orders.ts, the remove_processing_date permission). A
   second run keyed only on `internal_expected_dd IS NULL` would silently undo
   that decision. So any document whose audit trail shows the Processing Date
   was ever changed is REFUSED — a deliberate human act outranks this script.

   ── BOTH COMPANIES ───────────────────────────────────────────────────────
   COMPANY selects which to migrate, but the census always reports BOTH,
   because the readers are not company-scoped. so-stock-allocation.ts gates on
   proceeded_at with no company predicate, so re-pointing it while one company
   is migrated and the other is not would force every unmigrated order's lines
   to PENDING and regress READY_TO_SHIP. The reader flip must wait until this
   reports zero remaining on EVERY company, and the summary says so plainly.

   ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
   It does not touch proceeded_at and does not drop it. Retiring a column is
   stop-writing, stop-reading, then drop — separate changes, in that order.
   Moving the data first is the only step reversible on its own, and the
   dry-run prints the full doc_no revert key before anything is written.

   MODE=dry-run (default) runs every write inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'dry-run').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 1);
/* Houzs 30%, 2990 50% — processingDateThresholdFor(companyCode). Passed in so
   this script never re-invents a threshold the app already owns. */
const DEPOSIT_THRESHOLD = Number(process.env.DEPOSIT_THRESHOLD || (CO === 2 ? 0.5 : 0.3));

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** AutoCount's own processing date per DocNo, from both extracts. The value is
 *  'YYYY-MM-DD HH:MM:SS'; only the calendar day is the business fact. A DocNo
 *  appears once per LINE, so the same date repeats — a document whose lines
 *  disagree is reported and excluded rather than silently taking the first. */
function loadAutoCountDates() {
  const byDoc = new Map(), conflicted = new Set();
  const add = (doc, raw) => {
    const d = String(raw || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !doc) return;
    const k = String(doc).trim();
    if (byDoc.has(k) && byDoc.get(k) !== d) conflicted.add(k);
    else byDoc.set(k, d);
  };
  for (const [file, field] of [['ac-outstanding-so.json.gz', 'UDF_PDate'], ['ac-so-dates.json.gz', 'PDate']]) {
    const p = path.join(here, 'data', file);
    if (!fs.existsSync(p)) { bad(`missing source extract ${file} — cannot classify without it`); process.exit(2); }
    const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').replace(/^﻿/, ''));
    let n = 0;
    for (const r of rows) if (r[field]) { add(r.DocNo, r[field]); n++; }
    note(`  ${file}: ${rows.length} rows, ${n} with ${field}`);
  }
  for (const k of conflicted) byDoc.delete(k);
  return { byDoc, conflicted };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'DRY-RUN (everything rolls back)'} company=${CO} deposit_threshold=${DEPOSIT_THRESHOLD}`);

  note(`\n=== AUTOCOUNT SOURCE ===`);
  const { byDoc, conflicted } = loadAutoCountDates();
  note(`  documents with a processing date: ${byDoc.size}`);
  if (conflicted.size) note(`  EXCLUDED, lines disagree on the date: ${conflicted.size} (${[...conflicted].slice(0, 8).join(', ')})`);

  // ── CENSUS, ALL COMPANIES ────────────────────────────────────────────────
  const census = await sql`
    SELECT company_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE internal_expected_dd IS NOT NULL)::int AS has_ied,
           count(*) FILTER (WHERE proceeded_at IS NOT NULL)::int AS has_proc,
           count(*) FILTER (WHERE proceeded_at IS NOT NULL AND internal_expected_dd IS NULL)::int AS split
      FROM scm.mfg_sales_orders GROUP BY company_id ORDER BY company_id`;
  note(`\n=== CENSUS (every company — the readers are NOT company-scoped) ===`);
  for (const r of census) {
    note(`  company ${r.company_id}: ${String(r.total).padStart(5)} orders | Processing Date ${String(r.has_ied).padStart(5)} | proceeded_at ${String(r.has_proc).padStart(5)} | split ${String(r.split).padStart(5)}`);
  }

  const rows = await sql`
    SELECT doc_no, status::text AS status, linked_ac_docno,
           to_char(proceeded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS proc_date,
           to_char(customer_delivery_date, 'YYYY-MM-DD') AS deliv,
           debtor_name, address1, postcode, paid_centi, local_total_centi
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND proceeded_at IS NOT NULL AND internal_expected_dd IS NULL
     ORDER BY doc_no`;

  /* A deliberate human decision outranks this script. Any document whose audit
     trail mentions the Processing Date has had it changed by a person — very
     likely the Super-Admin Remove action, which is exactly the state a blind
     re-run would undo. Matched broadly on both the column and the payload key:
     over-refusing is safe, re-adding a removed date is not. */
  const docs = rows.map((r) => r.doc_no);
  const touchedRows = docs.length
    ? await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
                 WHERE so_doc_no = ANY(${docs})
                   AND (field_changes::text ILIKE '%internal_expected_dd%'
                     OR field_changes::text ILIKE '%internalExpectedDd%'
                     OR field_changes::text ILIKE '%Processing Date%')`
    : [];
  const touched = new Set(touchedRows.map((r) => r.so_doc_no));

  const migrate = [], notProceeded = [], disagree = [], humanTouched = [];
  for (const r of rows) {
    if (touched.has(r.doc_no)) { humanTouched.push(r); continue; }
    const src = r.linked_ac_docno ? byDoc.get(String(r.linked_ac_docno).trim()) : undefined;
    if (!src) { notProceeded.push(r); continue; }
    if (src !== r.proc_date) { disagree.push({ ...r, src }); continue; }
    migrate.push({ ...r, value: src });
  }

  note(`\n=== CLASSIFICATION (company ${CO}, ${rows.length} split rows) ===`);
  note(`  MIGRATE        ${String(migrate.length).padStart(5)}  proceeded_at MATCHES AutoCount's own processing date for that document`);
  note(`  NOT PROCEEDED  ${String(notProceeded.length).padStart(5)}  AutoCount has no processing date — a click stamp, and a click is not a date`);
  note(`  DISAGREE       ${String(disagree.length).padStart(5)}  AutoCount has a date but the column holds a different one — refused`);
  note(`  HUMAN-TOUCHED  ${String(humanTouched.length).padStart(5)}  the Processing Date was changed by a person — their decision stands`);

  for (const [title, list, fmt] of [
    ['DISAGREE', disagree, (r) => `${String(r.doc_no).padEnd(18)} ${String(r.status).padEnd(14)} db=${r.proc_date}  autocount=${r.src}`],
    ['HUMAN-TOUCHED', humanTouched, (r) => `${String(r.doc_no).padEnd(18)} ${String(r.status).padEnd(14)} db=${r.proc_date}`],
  ]) {
    if (!list.length) continue;
    note(`\n  --- ${title} ---`);
    for (const r of list.slice(0, 25)) note(`    ${fmt(r)}`);
    if (list.length > 25) note(`    … and ${list.length - 25} more`);
  }

  /* The contradiction the owner's rule exposes: an order at IN_PRODUCTION or
     beyond with no Processing Date never proceeded, yet the pipeline moved it
     on. Named, not silently picked a side for. */
  const advanced = notProceeded.filter((r) => !['DRAFT', 'CONFIRMED', 'CANCELLED'].includes(r.status));
  note(`\n=== NOT PROCEEDED, but already past CONFIRMED: ${advanced.length} ===`);
  for (const r of advanced.slice(0, 25)) {
    note(`    ${String(r.doc_no).padEnd(18)} ${String(r.status).padEnd(14)} clicked ${r.proc_date}  deliv=${r.deliv ?? '-'}`);
  }
  if (advanced.length > 25) note(`    … and ${advanced.length - 25} more`);

  // ── WHAT WAKES UP ────────────────────────────────────────────────────────
  const [{ today_my: todayMY }] = await sql`SELECT to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS today_my`;
  const wouldLock = migrate.filter((r) => r.value < todayMY && !['DRAFT', 'CANCELLED'].includes(r.status));
  const gateFail = migrate.map((r) => {
    const miss = [];
    if (!(r.debtor_name ?? '').trim()) miss.push('customer name');
    if (!(r.address1 ?? '').trim()) miss.push('address line 1');
    if (!(r.postcode ?? '').trim()) miss.push('postcode');
    if (!r.deliv) miss.push('delivery date');
    const total = Number(r.local_total_centi || 0), paid = Number(r.paid_centi || 0);
    if (total > 0 && paid / total < DEPOSIT_THRESHOLD) miss.push('deposit below threshold');
    return { doc: r.doc_no, locked: r.value < todayMY, miss };
  }).filter((x) => x.miss.length);

  note(`\n=== WHAT WAKES UP THE MOMENT THE DATE LANDS (today MYT = ${todayMY}) ===`);
  note(`  become EDIT-LOCKED immediately (processing date already past): ${wouldLock.length} of ${migrate.length}`);
  note(`  would FAIL the proceed gate on their NEXT save:                ${gateFail.length} of ${migrate.length}`);
  const tally = new Map();
  for (const g of gateFail) for (const m of g.miss) tally.set(m, (tally.get(m) || 0) + 1);
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) note(`     ${String(n).padStart(5)}  ${k}`);

  /* THE TRAP, named because it is the one an operator hits first. The
     completeness gate is not conditional on the save touching a date, so on a
     migrated order that is ALSO locked, editing a free field (a phone number)
     returns 422 asking for a postcode — and adding the postcode is itself a
     CONTROLLED field, so the plain edit path cannot fix it either. Those
     orders need the amendment flow, or their gap filled BEFORE apply. */
  const trapped = gateFail.filter((g) => g.locked);
  note(`\n  DEADLOCK RISK: ${trapped.length} would be BOTH locked AND gate-failing.`);
  note(`  On those, a free-field edit 422s asking for a field that is itself CONTROLLED —`);
  note(`  so they can only be fixed through an amendment. Fill their gaps before apply,`);
  note(`  or accept that they are amendment-only from day one.`);
  for (const g of trapped.slice(0, 20)) note(`     ${String(g.doc).padEnd(18)} ${g.miss.join(', ')}`);
  if (trapped.length > 20) note(`     … and ${trapped.length - 20} more`);

  note(`\n=== REVERT KEY — the ${migrate.length} doc_no(s) this would write ===`);
  for (let i = 0; i < migrate.length; i += 12) note(`  ${migrate.slice(i, i + 12).map((r) => r.doc_no).join(' ')}`);

  if (!migrate.length) { note(`\nNothing to migrate.`); await sql.end({ timeout: 5 }); return; }

  // ── WRITE ────────────────────────────────────────────────────────────────
  let wrote = 0;
  const ROLLBACK = Symbol('dry-run rollback');
  try {
    await sql.begin(async (tx) => {
      for (const r of migrate) {
        /* Company-scoped: the service role bypasses RLS, so this predicate is
           the only isolation. The IS NULL guard keeps a re-run a no-op; the
           audit-trail refusal above is what keeps it CORRECT. */
        const back = await tx`
          UPDATE scm.mfg_sales_orders SET internal_expected_dd = ${r.value}::date
           WHERE company_id = ${CO} AND doc_no = ${r.doc_no} AND internal_expected_dd IS NULL
          RETURNING doc_no`;
        wrote += back.length;
      }
      note(`\n${APPLY ? 'wrote' : 'would write'}: ${wrote} row(s)`);
      if (wrote !== migrate.length) throw new Error(`expected ${migrate.length}, wrote ${wrote} — refusing`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`DRY-RUN: transaction rolled back, nothing was written.`);
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── VERIFY ON A FRESH CONNECTION ─────────────────────────────────────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const after = await check`
      SELECT company_id,
             count(*) FILTER (WHERE internal_expected_dd IS NOT NULL)::int AS has_ied,
             count(*) FILTER (WHERE proceeded_at IS NOT NULL AND internal_expected_dd IS NULL)::int AS split
        FROM scm.mfg_sales_orders GROUP BY company_id ORDER BY company_id`;
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const r of after) note(`  company ${r.company_id}: Processing Date ${String(r.has_ied).padStart(5)} | still split ${String(r.split).padStart(5)}`);

    const wrong = await check`
      SELECT doc_no FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND doc_no = ANY(${migrate.map((r) => r.doc_no)})
         AND internal_expected_dd <> (proceeded_at AT TIME ZONE 'UTC')::date
       LIMIT 10`;
    if (wrong.length) bad(`${wrong.length}+ migrated row(s) whose date differs from proceeded_at: ${wrong.map((r) => r.doc_no).join(', ')}`);
    else note(`  every migrated date equals AutoCount's, and equals proceeded_at's day`);

    const remaining = after.reduce((a, r) => a + Number(r.split), 0);
    note(`\n  ${remaining} row(s) across ALL companies still hold a date only in proceeded_at.`);
    note(`  DO NOT re-point the readers (so-stock-allocation.ts gates on proceeded_at with`);
    note(`  NO company predicate) until this reaches 0 on every company — flipping early`);
    note(`  forces the unmigrated company's lines to PENDING and regresses READY_TO_SHIP.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
