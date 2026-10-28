#!/usr/bin/env node
/* adjust-houzs-0109-diffs.mjs — Houzs (company 1): where AutoCount's 31/08 bill
   and the supplier's own invoice disagree, the books' first day carries the
   difference (owner 2026-10-28: 「Diglant NB 是erp 对，Armani 是auto count 对，
   dorsetloft … 2608-076 RM2368 这个是对的」). The opening stays AutoCount's 31/08;
   September takes:
     • Diglant DGSIZ26001656 (AutoCount PI-007957 RM 2,600): the BASTION (SS)
       line AutoCount missed — an AP invoice of RM 800 dated 01/09;
     • NB Furniture NBF2608-974 (AutoCount PI-008026 RM 3,403): the MISC line
       AutoCount missed — an AP invoice of RM 498 dated 01/09;
     • Dorsettloft IV-2608-076 (AutoCount PI-008135 RM 6,388, the invoice RM
       2,368): a supplier credit note of RM 4,020 dated 01/09, knocked off its
       opening bill.
   Each paper is an ordinary one of its kind (not opening): its own journal on
   01/09, numbered from the live series, audited. MODE=plan (default) rolls it
   all back; MODE=apply + CONFIRM="HOUZS 01/09 DIFFS" keeps it. Refuses to add a
   paper twice (same supplier invoice reference, same amount, already on file).
   Env: DATABASE_URL, COMPANY_ID (1), NB_ACCOUNT (601-0001). */
import postgres from 'postgres';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
const PHRASE = 'HOUZS 01/09 DIFFS';
const CO = Number(process.env.COMPANY_ID || 1);
const DAY = '2026-09-01';
const ACTOR = 'Opening differences (owner 2026-10-28)';
const NB_ACCOUNT = String(process.env.NB_ACCOUNT || '601-0001');
const PAPERS = [
  { kind: 'API', supplier: '400-D002', ref: 'DGSIZ26001656', sen: 80000, account: '601-0001', what: 'AKEMI BASTION MATT (SS) 1 × RM 800.00 — on Diglant invoice DGSIZ26001656; AutoCount PI-007957 left this line out (owner 2026-10-28: the ERP is right)' },
  { kind: 'API', supplier: '400-N002', ref: 'NBF2608-974', sen: 49800, account: NB_ACCOUNT, what: 'MISC 1 × RM 498.00 — on NB Furniture invoice NBF2608-974; AutoCount PI-008026 left this line out (owner 2026-10-28: the ERP is right)' },
  { kind: 'SCN', supplier: '400-D004', ref: 'IV-2608-076', sen: 402000, account: '601-0003', knockOffAcDoc: 'PI-008135', what: 'Dorsettloft invoice IV-2608-076 is RM 2,368.00; AutoCount PI-008135 booked RM 6,388.00 — RM 4,020.00 off (owner 2026-10-28)' },
];
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
class Rollback extends Error {}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`MODE=apply needs CONFIRM="${PHRASE}".`); process.exit(2); }
  out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}, company ${CO}, dated ${DAY}`);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin(async (tx) => {
      await run(tx);
      if (!APPLY) throw new Rollback('plan');
    });
    out('APPLIED — committed.');
  } catch (e) {
    if (e instanceof Rollback) out('PLAN — rolled back, nothing written.');
    else throw e;
  } finally {
    await sql.end();
  }
}

async function run(tx) {
  const s = await tx`SELECT books_start_date::text AS start FROM scm.acc_company_settings WHERE company_id = ${CO}`;
  if (s[0]?.start !== DAY) throw new Error(`the books start on ${s[0]?.start ?? 'no day'}, not ${DAY}`);
  const roleRows = await tx`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${CO}`;
  const role = { AP: '400-0000', AP_OTHER: '405-0000', ...Object.fromEntries(roleRows.map((r) => [r.role, r.account_code])) };
  const control = (code) => (String(code).startsWith('405-') ? role.AP_OTHER : role.AP);
  const chart = await tx`SELECT account_code, account_name, is_active FROM scm.accounts WHERE company_id = ${CO} AND account_code = ANY(${[...new Set(PAPERS.map((p) => p.account))]}::text[])`;
  const parents = new Set((await tx`SELECT DISTINCT parent_code FROM scm.accounts WHERE company_id = ${CO} AND parent_code IS NOT NULL`).map((r) => r.parent_code));
  for (const p of PAPERS) {
    const a = chart.find((x) => x.account_code === p.account);
    if (!a || a.is_active === false || parents.has(p.account)) throw new Error(`${p.account} is not a live leaf account`);
  }
  const claim = async (series, n = 1) => {
    const floor = Number((await tx.unsafe(`SELECT coalesce(max(substring(x from '-([0-9]+)$')::int), 0) AS n FROM (
        SELECT invoice_number AS x FROM scm.ap_invoices WHERE invoice_number LIKE $1 UNION ALL
        SELECT note_number FROM scm.acc_credit_notes WHERE note_number LIKE $1 UNION ALL
        SELECT je_no FROM scm.journal_entries WHERE je_no LIKE $1) t`, [`${series}-%`]))[0].n);
    const r = await tx`INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source) VALUES (${series}, ${floor + 1 + n}, ${`self-seeded by the 01/09 differences from the live max (${floor})`})
        ON CONFLICT (series) DO UPDATE SET next_n = GREATEST(c.next_n, ${floor + 1}) + ${n}, updated_at = now() RETURNING next_n - ${n} AS first`;
    return Number(r[0].first);
  };
  const nowIso = new Date().toISOString();
  for (const p of PAPERS) {
    const sup = (await tx`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO} AND code = ${p.supplier}`)[0];
    if (!sup) throw new Error(`supplier ${p.supplier} not found`);
    const dup = p.kind === 'API'
      ? await tx`SELECT invoice_number AS no FROM scm.ap_invoices WHERE company_id = ${CO} AND supplier_id = ${sup.id} AND supplier_invoice_ref = ${p.ref} AND total_sen = ${p.sen} AND status <> 'CANCELLED' AND NOT opening`
      : await tx`SELECT note_number AS no FROM scm.acc_credit_notes WHERE company_id = ${CO} AND supplier_id = ${sup.id} AND source_doc_no = ${p.ref} AND total_sen = ${p.sen} AND status <> 'CANCELLED' AND NOT opening`;
    if (dup.length) { out(`! ${sup.code} ${p.ref} RM ${rm(p.sen)} is already on file as ${dup[0].no} — not added again`); continue; }
    const docNo = `HC-${p.kind}-2609-${String(await claim(`HC-${p.kind}-2609`)).padStart(3, '0')}`;
    const jeNo = `JE-2609-${String(await claim('JE-2609')).padStart(4, '0')}`;
    let docId;
    let lines;
    if (p.kind === 'API') {
      [{ id: docId }] = await tx`INSERT INTO scm.ap_invoices ${tx({ company_id: CO, invoice_number: docNo, supplier_id: sup.id, supplier_invoice_ref: p.ref, invoice_date: DAY, currency: 'MYR', exchange_rate: 1,
        total_sen: p.sen, paid_sen: 0, status: 'POSTED', notes: p.what, created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR })} RETURNING id`;
      await tx`INSERT INTO scm.ap_invoice_lines ${tx({ company_id: CO, invoice_id: docId, line_no: 1, description: p.what.slice(0, 500), debit_account_code: p.account, amount_sen: p.sen })}`;
      lines = [{ a: p.account, dr: p.sen, cr: 0, notes: p.what.slice(0, 300) }, { a: control(sup.code), dr: 0, cr: p.sen, pt: 'SUPPLIER', pc: sup.code, pn: sup.name, notes: `AP invoice ${docNo}` }];
    } else {
      [{ id: docId }] = await tx`INSERT INTO scm.acc_credit_notes ${tx({ company_id: CO, note_number: docNo, kind: 'SCN', party_type: 'SUPPLIER', party_code: sup.code, party_name: sup.name, supplier_id: sup.id,
        source_doc_no: p.ref, note_date: DAY, total_sen: p.sen, reason: p.what.slice(0, 300), notes: p.what, status: 'POSTED', je_no: jeNo, created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR })} RETURNING id`;
      await tx`INSERT INTO scm.acc_credit_note_lines ${tx({ company_id: CO, note_id: docId, line_no: 1, description: p.what.slice(0, 500), account_code: p.account, amount_sen: p.sen })}`;
      lines = [{ a: control(sup.code), dr: p.sen, cr: 0, pt: 'SUPPLIER', pc: sup.code, pn: sup.name, notes: `Supplier credit note ${docNo}` }, { a: p.account, dr: 0, cr: p.sen, notes: p.what.slice(0, 300) }];
    }
    const [je] = await tx`INSERT INTO scm.journal_entries ${tx({ company_id: CO, je_no: jeNo, entry_date: DAY, source_type: p.kind, source_doc_no: docNo,
      narration: `${p.kind === 'API' ? 'AP invoice' : 'Supplier credit note'} ${docNo} — ${sup.name} (${p.ref}) — the 31/08 difference, carried on 01/09`, total_debit_sen: p.sen, total_credit_sen: p.sen, posted: false })} RETURNING id`;
    await tx`INSERT INTO scm.journal_entry_lines ${tx(lines.map((l, i) => ({ company_id: CO, journal_entry_id: je.id, line_no: i + 1, account_code: l.a, debit_sen: l.dr, credit_sen: l.cr,
      party_type: l.pt ?? null, party_code: l.pc ?? null, party_name: l.pn ?? null, notes: l.notes ?? null })))}`;
    await tx`UPDATE scm.journal_entries SET posted = true, posted_at = now() WHERE id = ${je.id}`;
    let knock = '';
    if (p.knockOffAcDoc) {
      const bill = (await tx`SELECT id, invoice_number, total_sen, paid_sen FROM scm.ap_invoices WHERE company_id = ${CO} AND supplier_id = ${sup.id} AND opening AND status <> 'CANCELLED'
          AND notes LIKE ${`%AutoCount ${p.knockOffAcDoc}%`}`)[0];
      if (!bill) throw new Error(`no opening bill for AutoCount ${p.knockOffAcDoc}`);
      const left = Number(bill.total_sen) - Number(bill.paid_sen);
      if (left < p.sen) throw new Error(`${bill.invoice_number} has only RM ${rm(left)} left to take RM ${rm(p.sen)}`);
      await tx`INSERT INTO scm.acc_credit_note_allocations ${tx({ company_id: CO, note_id: docId, ap_invoice_id: bill.id, amount_sen: p.sen, applied_sen: p.sen, created_by: ACTOR })}`;
      await tx`UPDATE scm.ap_invoices SET paid_sen = paid_sen + ${p.sen}, status = CASE WHEN paid_sen + ${p.sen} >= total_sen THEN 'PAID' ELSE 'PARTIALLY_PAID' END, updated_at = now() WHERE id = ${bill.id}`;
      knock = `, knocked off ${bill.invoice_number} (RM ${rm(bill.total_sen)} → RM ${rm(left - p.sen)} left)`;
    }
    await tx`INSERT INTO scm.entity_audit_log ${tx({ company_id: CO, entity_type: p.kind === 'API' ? 'AP_INVOICE' : 'CREDIT_NOTE', entity_id: String(docId), entity_doc_no: docNo, action: 'CREATE',
      actor_name_snapshot: ACTOR, field_changes: tx.json([]), status_snapshot: 'POSTED', source: 'script', note: p.what })}`;
    out(`${p.kind === 'API' ? 'AP invoice' : 'credit note'} ${docNo} ${sup.code} ${sup.name} ${p.ref} RM ${rm(p.sen)} on ${p.account}, journal ${jeNo}${knock}`);
  }
  const owed = await tx`SELECT party_code AS code, sum(credit_sen - debit_sen)::bigint AS owed FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= '2026-09-01' AND NOT reversed AND reversed_by_je IS NULL AND party_code = ANY(${PAPERS.map((p) => p.supplier)}::text[])
        AND account_code IN (${role.AP}, ${role.AP_OTHER}) GROUP BY 1 ORDER BY 1`;
  out(`owed at 01/09 after: ${owed.map((o) => `${o.code} RM ${rm(o.owed)}`).join('; ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
