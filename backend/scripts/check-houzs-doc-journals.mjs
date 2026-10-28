#!/usr/bin/env node
/* check-houzs-doc-journals.mjs — READ ONLY. Every journal ever written for the
   named documents (posted or not, reversed or not), with lines, plus each
   document's audit trail — for bills that read POSTED but have no live journal
   (owner 2026-10-28 September import: HC-PI-2609-013/-014/-019/-025/-033).
   Env: DATABASE_URL, COMPANY_ID (1), DOCS (comma list). Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!DOCS.length) { console.error('DOCS is empty'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const jes = await sql`SELECT id, je_no, entry_date::text AS d, source_type, source_doc_no, posted, reversed, reversed_by_je, total_debit_sen, narration, created_at
        FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no = ANY(${DOCS}::text[]) ORDER BY source_doc_no, created_at`;
    const ls = jes.length ? await sql`SELECT journal_entry_id, account_code, debit_sen, credit_sen, party_code FROM scm.journal_entry_lines WHERE journal_entry_id = ANY(${jes.map((j) => j.id)}::uuid[]) ORDER BY journal_entry_id, line_no` : [];
    for (const j of jes) out('JE', { doc: j.source_doc_no, no: j.je_no, date: j.d, src: j.source_type, posted: j.posted, reversed: j.reversed, contra: j.reversed_by_je, total: Number(j.total_debit_sen), narration: j.narration, created: j.created_at,
      lines: ls.filter((l) => l.journal_entry_id === j.id).map((l) => `${l.account_code}${l.party_code ? `(${l.party_code})` : ''} ${Number(l.debit_sen) ? 'Dr ' + l.debit_sen : 'Cr ' + l.credit_sen}`) });
    for (const d of DOCS) if (!jes.some((j) => j.source_doc_no === d)) out('JE', { doc: d, none: true });
    for (const a of await sql`SELECT entity_doc_no, action, actor_name_snapshot, source, created_at, note, field_changes FROM scm.entity_audit_log
        WHERE company_id = ${CO} AND entity_doc_no = ANY(${DOCS}::text[]) ORDER BY entity_doc_no, created_at`) {
      out('AUDIT', { doc: a.entity_doc_no, action: a.action, by: a.actor_name_snapshot, source: a.source, at: a.created_at, note: String(a.note ?? '').slice(0, 200), changes: JSON.stringify(a.field_changes ?? null).slice(0, 300) });
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
