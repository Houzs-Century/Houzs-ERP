#!/usr/bin/env node
// check-event-rental-cn.mjs — READ-ONLY. Owner 2026-10-22: 「这个rental如果是有
// cn, 显示的是扣了cn的？」 for JOHOR [AKEMI] INHOME @ SUTERA MALL (10/09-10/11):
// the legs tagged to the event, the documents behind its rental, and every
// supplier credit note (SCN) on those documents or naming the event, with
// whether the note's journal legs carry the event tag.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const ev = await sql`
    SELECT id, name, start_date::text AS s, end_date::text AS e, company_id FROM projects
     WHERE archived_at IS NULL AND name ILIKE '%[AKEMI] INHOME%SUTERA%' AND start_date >= '2026-10-01' ORDER BY id`;
  for (const p of ev) {
    console.log(`ROW|=== #${p.id} ${p.name} ${p.s}..${p.e}`);
    const legs = await sql`
      SELECT je.je_no, je.entry_date::text AS d, je.source_type, je.source_doc_no, je.posted, je.reversed,
             l.account_code, a.pms_row, l.debit_sen, l.credit_sen, left(coalesce(l.notes, ''), 60) AS notes
        FROM scm.journal_entry_lines l
        JOIN scm.journal_entries je ON je.id = l.journal_entry_id
        LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
       WHERE l.project_id = ${p.id}
       ORDER BY je.entry_date, je.je_no`;
    for (const g of legs) console.log(`ROW|leg ${g.d} ${g.je_no} ${g.source_type}/${g.source_doc_no} ${g.account_code} row=${g.pms_row ?? '-'} Dr ${(Number(g.debit_sen ?? 0) / 100).toFixed(2)} Cr ${(Number(g.credit_sen ?? 0) / 100).toFixed(2)} posted=${g.posted} reversed=${g.reversed} | ${g.notes}`);
    const docs = [...new Set(legs.filter((g) => g.pms_row === 'rental').map((g) => g.source_doc_no).filter(Boolean))];
    const inv = docs.length ? await sql`SELECT id, invoice_number, supplier_id, total_sen, paid_sen, status FROM scm.ap_invoices WHERE invoice_number = ANY(${docs})` : [];
    for (const i of inv) console.log(`ROW|ap ${i.invoice_number} total ${(Number(i.total_sen) / 100).toFixed(2)} paid ${(Number(i.paid_sen) / 100).toFixed(2)} ${i.status}`);
    const invIds = inv.map((i) => i.id);
    const suppliers = [...new Set(inv.map((i) => i.supplier_id).filter(Boolean))];
    const notes = await sql`
      SELECT n.note_number, n.kind, n.status, n.note_date::text AS d, n.total_sen, n.je_no, n.source_doc_no, left(coalesce(n.reason, '') || ' ' || coalesce(n.notes, ''), 80) AS why,
             (SELECT string_agg(cl.account_code || ' ' || (cl.amount_sen / 100.0)::text || ' ' || coalesce(cl.description, ''), '; ') FROM scm.acc_credit_note_lines cl WHERE cl.note_id = n.id) AS lines
        FROM scm.acc_credit_notes n
       WHERE n.company_id = ${p.company_id} AND n.kind = 'SCN'
         AND (n.ap_invoice_id = ANY(${invIds.length ? invIds : ['00000000-0000-0000-0000-000000000000']}::uuid[])
              OR n.supplier_id = ANY(${suppliers.length ? suppliers : ['00000000-0000-0000-0000-000000000000']}::uuid[])
              OR coalesce(n.notes, '') ILIKE '%SUTERA%' OR coalesce(n.reason, '') ILIKE '%SUTERA%' OR coalesce(n.source_doc_no, '') = ANY(${docs.length ? docs : ['-']}))
       ORDER BY n.note_date`;
    for (const n of notes) {
      console.log(`ROW|scn ${n.note_number} ${n.status} ${n.d} total ${(Number(n.total_sen) / 100).toFixed(2)} je=${n.je_no ?? '-'} src=${n.source_doc_no ?? '-'} | ${n.why} | lines: ${n.lines ?? '-'}`);
      if (n.je_no) {
        const tl = await sql`SELECT l.account_code, l.project_id, l.debit_sen, l.credit_sen FROM scm.journal_entry_lines l JOIN scm.journal_entries je ON je.id = l.journal_entry_id WHERE je.je_no = ${n.je_no} AND je.company_id = ${p.company_id}`;
        for (const x of tl) console.log(`ROW|  scn-leg ${x.account_code} project=${x.project_id ?? '-'} Dr ${(Number(x.debit_sen ?? 0) / 100).toFixed(2)} Cr ${(Number(x.credit_sen ?? 0) / 100).toFixed(2)}`);
      }
    }
    if (notes.length === 0) console.log('ROW|no supplier credit note found for this rental');
    const all = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'POSTED')::int AS posted FROM scm.acc_credit_notes WHERE company_id = ${p.company_id} AND kind = 'SCN'`;
    console.log(`ROW|SCN in the company: ${all[0].n} (${all[0].posted} posted)`);
  }
} finally { await sql.end(); }
