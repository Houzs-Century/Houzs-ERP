#!/usr/bin/env node
// try-migration-ocn.mjs — DRY RUN, ROLLED BACK. Runs migration 20261029T0900
// (a credit note TO an other debtor: acc_credit_notes.debtor_id, kind OCN,
// party ODEBTOR, acc_credit_note_allocations.debtor_bill_id, the three-target
// CHECK, scm.settle_odb_received_sen) against PRODUCTION inside one
// transaction, reads back what it would leave, writes one note, one line and
// one knock-off the way the app does, moves a live bill's received_sen through
// the new function and back, tries the shapes the CHECKs must refuse, then
// ROLLS BACK — nothing stays, whatever the outcome. Env: DATABASE_URL,
// COMPANY_ID (1), BILL (a POSTED debtor bill number, e.g. HC-ODB-2608-005).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const BILL = String(process.env.BILL || 'HC-ODB-2608-005').trim();
const out = (s) => console.log(`ROW|${s}`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const text = readFileSync(new URL('./data/try-20261029T0900.sql', import.meta.url), 'utf8');
  class Rollback extends Error {}
  try {
    const checks = await sql`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('scm.acc_credit_notes'::regclass, 'scm.acc_credit_note_allocations'::regclass) AND contype = 'c' ORDER BY 1, 2`;
    for (const r of checks) out(`before: ${r.t} ${r.conname} ${r.def}`);
    const [n] = await sql`SELECT count(*)::int AS notes, count(*) FILTER (WHERE kind = 'SCN')::int AS scn FROM scm.acc_credit_notes`;
    const [a] = await sql`SELECT count(*)::int AS n FROM scm.acc_credit_note_allocations`;
    out(`before: ${n.notes} notes (${n.scn} SCN), ${a.n} allocations`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      const cols = await tx`SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS nl FROM information_schema.columns
        WHERE table_schema = 'scm' AND ((table_name = 'acc_credit_notes' AND column_name = 'debtor_id') OR (table_name = 'acc_credit_note_allocations' AND column_name = 'debtor_bill_id'))
        ORDER BY 1`;
      for (const r of cols) out(`column ${r.t}.${r.c} ${r.d} nullable=${r.nl}`);
      const after = await tx`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('scm.acc_credit_notes'::regclass, 'scm.acc_credit_note_allocations'::regclass) AND contype IN ('c', 'f') ORDER BY 1, 2`;
      for (const r of after) out(`after: ${r.t} ${r.conname} ${r.def}`);
      const idx = await tx`SELECT indexname FROM pg_indexes WHERE schemaname = 'scm' AND indexname IN ('idx_acc_credit_notes_debtor', 'idx_acc_cn_alloc_debtor_bill') ORDER BY 1`;
      out(`indexes: ${idx.map((r) => r.indexname).join(', ')}`);
      const [fn] = await tx`SELECT p.prosecdef AS secdef, pg_get_function_result(p.oid) AS result,
          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
        FROM pg_proc p WHERE p.oid = 'scm.settle_odb_received_sen(uuid, bigint)'::regprocedure`;
      out(`function: security definer ${fn.secdef}, returns ${fn.result}, service_role ${fn.service_role}, anon ${fn.anon}`);

      /* A live bill, the note and its knock-off written the way insertCreditNote / writePlan write them. */
      const [bill] = await tx`SELECT b.id, b.bill_number, b.debtor_id, b.total_sen, b.received_sen, b.status, d.name
        FROM scm.acc_debtor_bills b JOIN scm.acc_debtors d ON d.id = b.debtor_id WHERE b.company_id = ${CO} AND b.bill_number = ${BILL}`;
      if (!bill) throw new Error(`${BILL} is not a bill of company ${CO}`);
      out(`bill ${bill.bill_number} (${bill.name}): total ${bill.total_sen}, received ${bill.received_sen}, ${bill.status}`);
      const [note] = await tx`INSERT INTO scm.acc_credit_notes (company_id, note_number, kind, party_type, party_code, party_name, debtor_id, source_doc_no, note_date, total_sen, reason, status, created_by)
        VALUES (${CO}, 'TRY-OCN-0001', 'OCN', 'ODEBTOR', NULL, ${bill.name}, ${bill.debtor_id}, 'TRY', '2026-09-02', 200000, 'try', 'DRAFT', 'try-migration-ocn')
        RETURNING id, kind, party_type, debtor_id`;
      out(`note written: ${note.kind} ${note.party_type} debtor ${note.debtor_id === bill.debtor_id}`);
      await tx`INSERT INTO scm.acc_credit_note_lines (company_id, note_id, line_no, description, account_code, amount_sen)
        VALUES (${CO}, ${note.id}, 1, 'try', '520-0000', 200000)`;
      const [al] = await tx`INSERT INTO scm.acc_credit_note_allocations (company_id, note_id, debtor_bill_id, amount_sen, applied_sen, created_by)
        VALUES (${CO}, ${note.id}, ${bill.id}, 200000, 0, 'try-migration-ocn') RETURNING id`;
      out(`allocation written: ${al.id ? 'yes' : 'no'}`);

      /* The bill's received_sen through the new function — and back. */
      const [up] = await tx`SELECT * FROM scm.settle_odb_received_sen(${bill.id}::uuid, 200000::bigint)`;
      const [mid] = await tx`SELECT received_sen, status FROM scm.acc_debtor_bills WHERE id = ${bill.id}`;
      out(`settle +200000: applied ${up.applied_sen}, received ${bill.received_sen} → ${mid.received_sen}, ${mid.status} (reason ${up.reason ?? '-'})`);
      const [down] = await tx`SELECT * FROM scm.settle_odb_received_sen(${bill.id}::uuid, -200000::bigint)`;
      const [end] = await tx`SELECT received_sen, status FROM scm.acc_debtor_bills WHERE id = ${bill.id}`;
      out(`settle -200000: applied ${down.applied_sen}, received → ${end.received_sen}, ${end.status}`);
      const [huge] = await tx`SELECT * FROM scm.settle_odb_received_sen(${bill.id}::uuid, 999999999999::bigint)`;
      const [clamped] = await tx`SELECT received_sen, total_sen, status FROM scm.acc_debtor_bills WHERE id = ${bill.id}`;
      out(`settle +huge: applied ${huge.applied_sen} (clamped at total ${clamped.total_sen}), ${clamped.status}`);

      /* What the CHECKs must refuse. */
      const refused = async (label, run) => {
        try { await tx.savepoint(run); out(`${label}: ACCEPTED (wrong)`); }
        catch (e) { out(`${label}: refused (${e.message})`); }
      };
      await refused('an allocation naming a bill AND an AP invoice', (sp) => sp`INSERT INTO scm.acc_credit_note_allocations (company_id, note_id, debtor_bill_id, ap_invoice_id, amount_sen)
        VALUES (${CO}, ${note.id}, ${bill.id}, (SELECT id FROM scm.ap_invoices WHERE company_id = ${CO} LIMIT 1), 100)`);
      await refused('an allocation naming nothing', (sp) => sp`INSERT INTO scm.acc_credit_note_allocations (company_id, note_id, amount_sen) VALUES (${CO}, ${note.id}, 100)`);
      await refused('a note of kind XCN', (sp) => sp`INSERT INTO scm.acc_credit_notes (company_id, note_number, kind, party_type, note_date) VALUES (${CO}, 'TRY-X-1', 'XCN', 'ODEBTOR', '2026-09-02')`);
      await refused('a note to party OTHER', (sp) => sp`INSERT INTO scm.acc_credit_notes (company_id, note_number, kind, party_type, note_date) VALUES (${CO}, 'TRY-X-2', 'OCN', 'OTHER', '2026-09-02')`);
      /* The supplier side still reads and writes as before. */
      const [old] = await tx`SELECT count(*)::int AS n FROM scm.acc_credit_note_allocations WHERE purchase_invoice_id IS NOT NULL OR ap_invoice_id IS NOT NULL`;
      out(`supplier allocations still read: ${old.n}`);
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) out('ROLLED BACK — the migration applies cleanly; nothing was kept.');
    else { out(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
  } finally { await sql.end(); }
  const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [still] = await after`SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_credit_notes' AND column_name = 'debtor_id') AS col,
    to_regprocedure('scm.settle_odb_received_sen(uuid, bigint)') IS NOT NULL AS fn,
    (SELECT count(*)::int FROM scm.acc_credit_notes WHERE note_number LIKE 'TRY-%') AS rows`;
  out(`after rollback: debtor_id exists ${still.col === 1}, function exists ${still.fn}, TRY rows ${still.rows}`);
  await after.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
