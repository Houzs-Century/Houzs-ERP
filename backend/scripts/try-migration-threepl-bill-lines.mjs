#!/usr/bin/env node
// try-migration-threepl-bill-lines.mjs — DRY RUN, ROLLED BACK. Runs migration
// 20261024T1400 (3PL bill lines kept + the read log + threepl_do_charges.
// billed_by_hand) against PRODUCTION inside one transaction, reads back what it
// would leave, writes one line and one read log the way the app does (array
// columns, foreign keys), runs the app's own selects, then ROLLS BACK —
// nothing stays, whatever the outcome. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const text = readFileSync(new URL('./data/try-20261024T1400.sql', import.meta.url), 'utf8');
  class Rollback extends Error {}
  try {
    const before = await sql`SELECT count(*)::int AS n, count(ap_invoice_id)::int AS from_ap FROM scm.threepl_do_charges`;
    console.log(`ROW|threepl_do_charges before: ${before[0].n} rows, ${before[0].from_ap} from an AP invoice`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      const cols = await tx`SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n, column_default AS def FROM information_schema.columns
        WHERE table_schema = 'scm' AND (table_name IN ('threepl_bill_lines', 'threepl_bill_reads') OR (table_name = 'threepl_do_charges' AND column_name = 'billed_by_hand'))
        ORDER BY table_name, ordinal_position`;
      for (const r of cols) console.log(`ROW|column ${r.t}.${r.c} ${r.d} nullable=${r.n} default=${r.def ?? '-'}`);
      const idx = await tx`SELECT indexname FROM pg_indexes WHERE schemaname = 'scm' AND tablename IN ('threepl_bill_lines', 'threepl_bill_reads') ORDER BY indexname`;
      console.log(`ROW|indexes: ${idx.map((r) => r.indexname).join(', ')}`);
      const rls = await tx`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'scm'::regnamespace AND relname IN ('threepl_bill_lines', 'threepl_bill_reads') ORDER BY relname`;
      for (const r of rls) console.log(`ROW|rls ${r.relname}: ${r.relrowsecurity}`);
      const grants = await tx`SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
        WHERE table_schema = 'scm' AND grantee = 'service_role' AND table_name IN ('threepl_bill_lines', 'threepl_bill_reads') GROUP BY table_name ORDER BY table_name`;
      for (const r of grants) console.log(`ROW|service_role on ${r.table_name}: ${r.p}`);

      /* One line and one read log, written the way saveBill / logRead write them. */
      const [inv] = await tx`SELECT id, company_id FROM scm.ap_invoices WHERE status <> 'CANCELLED' ORDER BY invoice_date DESC LIMIT 1`;
      const [dov] = await tx`SELECT id FROM scm.delivery_orders WHERE company_id = ${inv.company_id} LIMIT 1`;
      await tx`INSERT INTO scm.threepl_bill_lines (company_id, ap_invoice_id, line_no, text, line_date, kind, amount_sen, printed, read_status, assign, do_ids, assigned_by, assigned_at)
        VALUES (${inv.company_id}, ${inv.id}, 1, 'try', '2026-10-06', 'delivery', 12000, ${['HC-SO-1']}, 'matched', 'do', ${[dov.id]}::uuid[], 'auto', now())`;
      await tx`INSERT INTO scm.threepl_bill_reads (ap_invoice_id, company_id, read_by, files_count, files_latest, attempts, error)
        VALUES (${inv.id}, ${inv.company_id}, 'auto', 1, now(), 0, null)
        ON CONFLICT (ap_invoice_id) DO UPDATE SET attempts = scm.threepl_bill_reads.attempts + 1`;
      const lines = await tx`SELECT id, ap_invoice_id, threepl_company_id, line_no, text, line_date, kind, amount_sen, printed, read_status, assign, do_ids, service_ref, project_id, assigned_by, assigned_at
        FROM scm.threepl_bill_lines WHERE ap_invoice_id = ${inv.id}`;
      console.log(`ROW|line written and read back: ${lines.length} (do_ids ${lines[0]?.do_ids?.length ?? 0}, printed ${JSON.stringify(lines[0]?.printed)})`);
      let bad;
      try { await tx.savepoint((sp) => sp`INSERT INTO scm.threepl_bill_lines (company_id, ap_invoice_id, line_no, read_status, assign) VALUES (${inv.company_id}, ${inv.id}, 2, 'x', 'elsewhere')`); bad = 'ACCEPTED (wrong)'; }
      catch (e) { bad = `refused (${e.message})`; }
      console.log(`ROW|an assign outside do/service/event/none: ${bad}`);
      const reads = await tx`SELECT ap_invoice_id, threepl_company_id, read_by, read_at, error FROM scm.threepl_bill_reads WHERE ap_invoice_id = ${inv.id}`;
      console.log(`ROW|read log written and read back: ${reads.length}`);
      const charges = await tx`SELECT id, do_id, threepl_company_id, billed_sen, billed_by_hand FROM scm.threepl_do_charges LIMIT 5`;
      console.log(`ROW|charges select with billed_by_hand reads: ${charges.length} rows`);
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) console.log('ROW|ROLLED BACK — the migration applies cleanly; nothing was kept.');
    else { console.log(`ROW|MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
  } finally { await sql.end(); }
  const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const still = await after`SELECT to_regclass('scm.threepl_bill_lines') IS NOT NULL AS lines, to_regclass('scm.threepl_bill_reads') IS NOT NULL AS reads,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'threepl_do_charges' AND column_name = 'billed_by_hand') AS col`;
  console.log(`ROW|after rollback: bill_lines exists ${still[0].lines}, bill_reads exists ${still[0].reads}, billed_by_hand exists ${still[0].col === 1}`);
  await after.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
