// Put HC-SO-2609-395's Processing Date back to what it was before BUG-101.
//
// Sim, 2026-10-10: the order was proceeded 30/9 and PO-2610-025 was already out,
// then the Purchaser-lane half of Jason's amendment moved the Processing Date to
// 2026-10-10. The supplier works to the PO, so the moved date describes nothing.
// Sim, 2026-10-12: 「yes change back to original proceed date」.
//
// WHAT THIS DOES: one column on one Sales Order. processing_date goes back to
// the value the applied amendment's own old_header_snapshot recorded, version is
// bumped so an editor open on the old row cannot save over it, and one SO
// history row says why. Status, lines, the PO and AutoCount are untouched.
//
// It refuses unless production still has the shape the ticket describes: the
// order at 2026-10-10, and exactly one applied Purchaser-lane amendment that
// moved it there from a recorded earlier date.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: RESTORE-2609-395-PROCESSING
//   COMPANY_ID     default 1
//
// RE-RUN: idempotent. Once the date is back the shape check reports nothing to do.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'RESTORE-2609-395-PROCESSING';
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

const SO = 'HC-SO-2609-395';
const MOVED_TO = '2026-10-10';
const day = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function readShape(sql) {
  const [so] = await sql`
    SELECT doc_no, status, version, processing_date::text AS processing_date,
           customer_delivery_date::text AS customer_delivery_date
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND doc_no = ${SO}`;
  const moves = await sql`
    SELECT id, amendment_no, status, lane, so_approved_at,
           header_changes->>'processingDate'      AS requested,
           old_header_snapshot->>'processingDate' AS original
      FROM scm.so_amendments
     WHERE company_id = ${CO} AND so_doc_no = ${SO}
       AND header_changes ? 'processingDate'
     ORDER BY created_at`;
  return { so, moves };
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}  ${SO}`);

  const { so, moves } = await readShape(sql);
  if (!so) {
    log(`NOT FOUND — ${SO} is not in company ${CO}. Refusing.`);
    await sql.end();
    process.exit(APPLY ? 1 : 0);
  }
  log(`  order: status=${so.status} version=${so.version} processing=${day(so.processing_date)} delivery=${day(so.customer_delivery_date)}`);
  for (const m of moves) {
    log(`  ${m.amendment_no}: lane=${m.lane} status=${m.status} processing ${day(m.original) || '(none)'} -> ${day(m.requested) || '(cleared)'} approved=${m.so_approved_at ? new Date(m.so_approved_at).toISOString() : '-'}`);
  }

  const applied = moves.filter((m) => m.status === 'SO_APPROVED' && day(m.requested) === MOVED_TO);
  if (applied.length !== 1 || !day(applied[0].original)) {
    log(`SHAPE CHANGED — expected one applied amendment that moved the date to ${MOVED_TO} with a recorded original, `
      + `saw ${applied.length}. Refusing.`);
    await sql.end();
    process.exit(APPLY ? 1 : 0);
  }
  const original = day(applied[0].original);
  const current = day(so.processing_date);

  if (current === original) {
    log(`ALREADY RESTORED — processing date is ${original}. Nothing to change.`);
    await sql.end();
    return;
  }
  if (current !== MOVED_TO) {
    log(`SHAPE CHANGED — the order's processing date is ${current || '(none)'}, not ${MOVED_TO}. `
      + 'Something else moved it since; refusing rather than overwrite that.');
    await sql.end();
    process.exit(APPLY ? 1 : 0);
  }

  log('');
  log(`PLAN: ${SO} processing_date ${MOVED_TO} -> ${original} (from ${applied[0].amendment_no}'s old_header_snapshot), `
    + `version ${so.version} -> ${Number(so.version) + 1}, plus one SO history row. Status stays ${so.status}.`);

  if (!APPLY) {
    log('');
    log(`PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    await sql.end();
    return;
  }

  const updated = await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE scm.mfg_sales_orders
         SET processing_date = ${original}, version = version + 1, updated_at = now()
       WHERE company_id = ${CO} AND doc_no = ${SO} AND processing_date = ${MOVED_TO}
       RETURNING doc_no`;
    if (rows.length !== 1) throw new Error(`expected 1 row, updated ${rows.length}`);
    await tx`
      INSERT INTO scm.mfg_so_audit_log
        (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
      VALUES
        (${SO}, ${CO}, 'UPDATE', 'System (BUG-101 repair)',
         ${tx.json([{ field: 'processing_date', from: MOVED_TO, to: original }])},
         ${so.status}, 'script',
         ${`BUG-101: Processing Date restored to ${original}. ${applied[0].amendment_no} had moved it to ${MOVED_TO} after PO-2610-025 was raised; a PO now freezes the Processing Date. Requested by Sim 2026-10-12.`})`;
    return rows.length;
  });
  log('');
  log(`rows updated: ${updated}`);
  await sql.end();

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = await readShape(check);
  await check.end();
  const now = day(after.so?.processing_date);
  log(`VERIFY (fresh connection): processing_date=${now} status=${after.so?.status} version=${after.so?.version}`);
  if (now !== original) {
    log('VERIFY FAILED — the date did not land; investigate.');
    process.exit(1);
  }
  log('OK — the Processing Date is back.');
}

await main();
