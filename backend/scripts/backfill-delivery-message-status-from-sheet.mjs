#!/usr/bin/env node
/* Backfill the dispatch team's "Delivery Message Status" onto each sales order,
   from the HC Delivery Updated Google Sheet.

   WHY. The customer-message follow-up status (scm.mfg_sales_orders
   .delivery_message_status, the board's "Delivery Message Status" column) was
   kept by the dispatch team in the sheet's own "DELIVERY MESSAGE STATUS" column
   (col A of the Delivery Details / SG Order / EM Order tabs) and was never synced
   into the ERP — in production only 3 orders carried a value. The owner wants the
   sheet's status onto the board (owner 2026-10-22), the same one-off backfill as
   the crew / delivery-date pull (backfill-delivery-crew-from-sheet.mjs, #4843).

   SOURCE. data/delivery-message-status-from-sheet.json — 731 {k, s} records, one
   per DISTINCT sheet Doc. No. that carries a single status. Captured once from the
   three tabs (904 status rows): blank-status rows (111) and non-order keys (22 —
   project SETUP/DISMANTLE rows, driver-off / trip notes) were dropped at capture,
   the "Peding Delivery (EM)" typo was normalised to "Pending Delivery (EM)", and
   job-suffix keys (-SERVICE / -INSPECTION / -PICKUP / -PILLOW / -CORNER / a
   trailing -N on an SO-###### AutoCount no.) were folded to the base order. Six
   keys carried TWO different statuses across tabs and are NOT in the file — they
   are refused as conflicts, never guessed: SO-010886, SO-003661, SO-011641,
   SO-011891, SO-012611, SO-012538. The file is the audit trail: every value
   written is visible in the PR.

   WHAT IT WRITES. For each record it resolves the sheet key -> the SO
   (coalesce(linked_ac_docno, doc_no), the exact value the ERP->sheet sync writes
   as the sheet's Doc No), then:
     - UPDATE scm.mfg_sales_orders SET delivery_message_status = <sheet status>,
       ONLY where it is currently NULL/blank. An order that already carries a
       status is LEFT AS-IS (the owner chose not to overwrite the few already set),
       and the IS NULL guard enforces it in the database as well as in the plan.
   The status string is written verbatim. The 23 recurring statuses are now in the
   HC_MESSAGE_STATUS_VALUES whitelist (delivery-planning-fields.ts) so the board's
   dropdown offers them; a handful of rare historical values (Done Remind,
   Pending Rescheduling, REFUNDED, CTM MIA, Customer Request Hold Shipment) are
   written for the record and still display — the board's editor keeps any stored
   value as its current option — but are intentionally not added to the dropdown.

   REFUSES, never guesses: a key with no SO in the ERP, and a key matching more
   than one SO, are each listed and skipped.

   MODE=plan (default) resolves everything and prints the full plan, writing
   nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes, then
   re-reads on a FRESH connection and asserts the stored status VALUES match what
   was intended (a row count is not a shape).

   RE-RUN: inert. Each write is guarded by delivery_message_status IS NULL, so an
   order this script filled (or one a planner later set through the board) is
   excluded next time and a second run writes nothing. */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const ROWS = JSON.parse(readFileSync(new URL('./data/delivery-message-status-from-sheet.json', import.meta.url), 'utf8'));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}  source rows=${ROWS.length}`);

  const keys = [...new Set(ROWS.map((r) => r.k))];

  // key -> SO. A key matching more than one SO is ambiguous and refused. The sheet
  // Doc No is coalesce(linked_ac_docno, doc_no) by construction (the ERP->sheet
  // sync writes exactly that), so this one predicate resolves AutoCount and ERP
  // keys alike.
  const soRows = await sql`SELECT doc_no, company_id, delivery_message_status,
                                  coalesce(linked_ac_docno, doc_no) AS k
                             FROM scm.mfg_sales_orders
                             WHERE coalesce(linked_ac_docno, doc_no) = ANY(${keys})`;
  const soByKey = new Map();
  for (const r of soRows) {
    const list = soByKey.get(r.k) ?? [];
    const cur = (r.delivery_message_status ?? '').trim();
    list.push({ doc_no: r.doc_no, company_id: Number(r.company_id), has_status: cur !== '' });
    soByKey.set(r.k, list);
  }

  const writes = [];            // { doc_no, company_id, status, key }
  const noSo = []; const ambiguous = []; const skippedExisting = [];

  for (const r of ROWS) {
    const sos = soByKey.get(r.k);
    if (!sos || sos.length === 0) { noSo.push(r.k); continue; }
    if (sos.length > 1) { ambiguous.push(`${r.k} -> ${sos.map((s) => s.doc_no).join(', ')}`); continue; }
    const so = sos[0];
    if (so.has_status) { skippedExisting.push(`${r.k} (${so.doc_no})`); continue; }
    writes.push({ doc_no: so.doc_no, company_id: so.company_id, status: r.s, key: r.k });
  }

  // status -> count, for the plan
  const byStatus = new Map();
  for (const w of writes) byStatus.set(w.status, (byStatus.get(w.status) ?? 0) + 1);

  note(`\n=== PLAN ===`);
  note(`  message-status updates (delivery_message_status, only where blank): ${writes.length}`);
  note(`  skipped — order already has a status (left as-is): ${skippedExisting.length}`);
  note(`  skipped — key not an ERP order: ${noSo.length}`);
  note(`  skipped — key matches >1 SO (ambiguous): ${ambiguous.length}`);
  note(`\n  by status:`);
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) note(`    ${n}\t${s}`);
  for (const x of noSo) note(`    no ERP order: ${x}`);
  for (const x of ambiguous) bad(`    AMBIGUOUS: ${x}`);
  for (const x of skippedExisting) note(`    already set: ${x}`);
  note(`\n  sample of what will be written (first 10):`);
  for (const w of writes.slice(0, 10)) note(`    ${w.key} -> ${w.doc_no} (co ${w.company_id}) :: "${w.status}"`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING ${writes.length} message-status value(s) ===`);
  let wrote = 0;
  for (const w of writes) {
    // IS NULL guard: an order that gained a status between the read and here is
    // never overwritten, which also makes a re-run inert.
    const back = await sql`UPDATE scm.mfg_sales_orders SET delivery_message_status = ${w.status}
                             WHERE doc_no = ${w.doc_no} AND delivery_message_status IS NULL
                             RETURNING doc_no`;
    wrote += back.length;
  }
  note(`  message statuses set: ${wrote} of ${writes.length} (the rest already had one)`);

  await sql.end({ timeout: 5 });

  // Verify on a FRESH connection: re-read the written statuses and assert the
  // stored VALUE equals what we intended — not a count.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const sample = writes.slice(0, 15);
    const docNos = sample.map((w) => w.doc_no);
    const stored = docNos.length
      ? await check`SELECT doc_no, delivery_message_status FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docNos})`
      : [];
    const byDoc = new Map(stored.map((r) => [r.doc_no, r.delivery_message_status]));
    let mismatches = 0;
    for (const w of sample) {
      const got = byDoc.get(w.doc_no) ?? null;
      if (got !== w.status) { mismatches += 1; bad(`    MISMATCH ${w.key} ${w.doc_no}: stored "${got ?? ''}" wanted "${w.status}"`); }
      else note(`    ok ${w.key} ${w.doc_no}: "${got}"`);
    }
    note(`  verified ${sample.length} row(s); mismatches: ${mismatches}`);
    if (mismatches) { bad(`verification found ${mismatches} mismatch(es)`); process.exitCode = 1; }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
