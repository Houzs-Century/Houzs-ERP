// Move HC-SO-2609-077's Processing Date to the day it was confirmed (HC-0113).
//
// Sim, 2026-10-16: the order was drafted with Processing Date 18/9 and
// confirmed by the salesperson on 13/10, so it reached purchasing dated 18/9
// and read as an order purchasing had missed. Sim raised its PO on 16/10 and
// asked: "this 2609-077 proceed date should be 13/10". From this release a
// late confirm does that itself (processingDateOnConfirm); this is the one
// order Sim asked to fix by hand.
//
// WHAT THIS DOES: one column on one Sales Order. processing_date 2026-09-18 ->
// the MYT day of its recorded DRAFT confirm (must be 2026-10-13), version is
// bumped so an editor open on the old row cannot save over it, updated_at moves
// so the delivery sheet re-pulls it, and one SO history row says why. Status,
// lines, the PO and AutoCount are untouched.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: HC0113-2609-077-PROCESSING
//   COMPANY_ID     default 1
//
// RE-RUN: idempotent. Once the date is 13/10 it reports nothing to do.
import postgres from 'postgres';
import { readConfirmShape, writeProcessingDate } from './lib/hc0113-processing-date-sql.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'HC0113-2609-077-PROCESSING';
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

const SO = 'HC-SO-2609-077';
const FROM = '2026-09-18';
const TO = '2026-10-13';

async function refuse(sql, m) {
  log(m);
  await sql.end();
  process.exit(APPLY ? 1 : 0);
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}  ${SO}`);

  const { so, changes, audits } = await readConfirmShape(sql, CO, SO);
  if (!so) return refuse(sql, `NOT FOUND — ${SO} is not in company ${CO}. Refusing.`);
  log(`  order: status=${so.status} version=${so.version} processing=${so.processing_date ?? '(none)'} delivery=${so.customer_delivery_date ?? '(none)'}`);
  for (const c of changes) log(`  status change DRAFT -> ${c.to_status} on ${c.day} (MYT)`);
  for (const a of audits) log(`  history: ${a.actor ?? '?'} confirmed the draft on ${a.day} (MYT)`);

  const days = [...new Set([...changes, ...audits].map((r) => r.day))];
  if (days.length !== 1 || days[0] !== TO) {
    return refuse(sql, `SHAPE CHANGED — expected one recorded DRAFT confirm on ${TO}, saw ${days.join(', ') || 'none'}. Refusing.`);
  }
  if (so.processing_date === TO) {
    log(`ALREADY DONE — processing date is ${TO}. Nothing to change.`);
    await sql.end();
    return;
  }
  if (so.processing_date !== FROM) {
    return refuse(sql, `SHAPE CHANGED — the processing date is ${so.processing_date ?? '(none)'}, not ${FROM}. `
      + 'Something else moved it since; refusing rather than overwrite that.');
  }
  if (['DRAFT', 'CANCELLED'].includes(so.status)) {
    return refuse(sql, `SHAPE CHANGED — the order is ${so.status}. Refusing.`);
  }
  if (so.customer_delivery_date && so.customer_delivery_date < TO) {
    return refuse(sql, `SHAPE CHANGED — the delivery date ${so.customer_delivery_date} is before ${TO}. Refusing.`);
  }

  log('');
  log(`PLAN: ${SO} processing_date ${FROM} -> ${TO} (the confirm day), version ${so.version} -> ${Number(so.version) + 1}, `
    + `plus one SO history row. Status stays ${so.status}; the PO is not touched.`);

  if (!APPLY) {
    log('');
    log(`PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    await sql.end();
    return;
  }

  const updated = await sql.begin((tx) => writeProcessingDate(tx, {
    companyId: CO, docNo: SO, from: FROM, to: TO, status: so.status,
    note: `HC-0113: Processing Date moved to the confirm date ${TO}. The draft carried ${FROM} from before it was confirmed on ${TO}. Requested by Sim 2026-10-16.`,
  }));
  log('');
  log(`rows updated: ${updated}`);
  await sql.end();
  if (updated !== 1) {
    log('NOTHING WRITTEN — the row moved between the read and the write; re-run plan.');
    process.exit(1);
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = await readConfirmShape(check, CO, SO);
  await check.end();
  log(`VERIFY (fresh connection): processing_date=${after.so?.processing_date} status=${after.so?.status} version=${after.so?.version}`);
  if (after.so?.processing_date !== TO) {
    log('VERIFY FAILED — the date did not land; investigate.');
    process.exit(1);
  }
  log('OK — the Processing Date is the confirm date.');
}

await main();
