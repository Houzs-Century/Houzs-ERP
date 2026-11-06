#!/usr/bin/env node
// check-voucher-fair-ledger.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06: a voucher he cancelled seems to count several times on the fair's
// ledger (KL CHEN, Sunway Kluang: HC-HPV-2610-025, HC-HPV-2610-112, HC-Draft-2610-150).
// Prints those vouchers, every journal they made, what the event page's own reads return,
// and a sweep of cancelled documents still counting on a fair. Also who may reject a
// payment request: the roles holding scm.payment_voucher.create.
import postgres from 'postgres';
import { d1Compat } from '../src/db/d1-compat.ts';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { countsInTheBooks } from '../src/acc/reversal-pairs.ts';
import { booksLinesFor, readCheckedVoucherLegs, readEventBooks, withCheckedVouchers } from '../src/scm/lib/event-books.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 19);

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const pvCols = (await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'payment_vouchers' ORDER BY ordinal_position`).map((r) => r.column_name);
  out(`payment_vouchers columns: ${pvCols.join(', ')}`);
  const pvs = await tx`
    SELECT * FROM scm.payment_vouchers
     WHERE company_id = 1 AND (pv_number IN ('HC-Draft-2610-150', 'HC-HPV-2610-025', 'HC-HPV-2610-112') OR payee_name ILIKE '%KL CHEN%')
     ORDER BY voucher_date, pv_number`;
  const lines = pvs.length ? await tx`SELECT l.* FROM scm.payment_voucher_lines l WHERE l.pv_id IN ${tx(pvs.map((p) => p.id))} ORDER BY l.pv_id, l.line_no` : [];
  const projects = new Set();
  for (const p of pvs) {
    const mine = lines.filter((l) => String(l.pv_id) === String(p.id));
    out(`PV ${p.pv_number} | ${p.status} | ${day(p.voucher_date).slice(0, 10)} | ${p.payee_name} | ${rm(p.total_sen ?? p.amount_sen)} | submitted ${day(p.submitted_at) || '-'} checked ${day(p.checked_at) || '-'} approved ${day(p.approved_at) || '-'} cancelled ${day(p.cancelled_at) || '-'} | je ${p.journal_entry_id ?? p.je_no ?? p.posted_je_no ?? '-'} | header project ${p.project_id ?? '-'} | purpose ${String(p.purpose ?? '').slice(0, 40)}`);
    for (const l of mine) {
      if (l.project_id != null) projects.add(Number(l.project_id));
      out(`   line ${l.line_no} ${l.debit_account_code} ${rm(l.amount_sen)} project ${l.project_id ?? '-'} | ${String(l.description ?? '').slice(0, 70)}`);
    }
    if (p.project_id != null) projects.add(Number(p.project_id));
    const jes = await tx`
      SELECT je.id::text AS id, je.je_no, je.entry_date, je.source_type, je.source_doc_no, je.posted, je.reversed, je.reversed_by_je::text AS reversed_by_je, je.created_at
        FROM scm.journal_entries je
       WHERE je.company_id = 1 AND (je.source_doc_no = ${String(p.pv_number)} OR je.source_doc_no = ${String(p.id)})
       ORDER BY je.created_at`;
    for (const j of jes) out(`   JE ${j.je_no} ${String(j.entry_date).slice(0, 10)} ${j.source_type} doc ${j.source_doc_no} posted ${j.posted} reversed ${j.reversed} by ${j.reversed_by_je ?? '-'} made ${day(j.created_at)}`);
  }

  /* The event page's own reads, through its own connection. */
  const db = d1Compat(() => tx);
  for (const projectId of projects) {
    const [proj] = await tx`SELECT * FROM public.projects WHERE id = ${projectId}`;
    out(`== project ${projectId}: ${proj?.name ?? '?'} ${String(proj?.start_date ?? proj?.starts_on ?? '').slice(0, 10)}..${String(proj?.end_date ?? proj?.ends_on ?? '').slice(0, 10)}`);
    const posted = await readEventBooks(db, projectId, 1);
    const checked = await readCheckedVoucherLegs(db, projectId, 1);
    if (!posted.ok || !checked.ok) { out(`   read failed: ${posted.reason ?? ''} ${checked.reason ?? ''}`); continue; }
    for (const l of posted.legs) out(`   posted leg ${l.je_no} ${l.entry_date} ${l.source_type} ${l.source_doc_no} ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)} posted ${l.posted} reversed ${l.reversed} by ${l.reversed_by_je ?? '-'} counts ${countsInTheBooks(l)} row ${l.pms_row ?? '-'}`);
    for (const l of checked.legs) out(`   checked leg ${l.je_no} ${l.entry_date} ${l.account_code} ${rm(l.debit_sen)} row ${l.pms_row ?? '-'}`);
    const merged = withCheckedVouchers(posted, checked);
    const page = booksLinesFor(projectId, merged.legs);
    const byRow = {};
    for (const b of page) byRow[b.category] = (byRow[b.category] ?? 0) + b.amount;
    out(`   ON THE PAGE: ${page.map((b) => `${b.doc_no} ${b.category} ${b.amount.toFixed(2)}`).join(' ; ') || 'nothing'}`);
    out(`   by row: ${JSON.stringify(byRow)}`);
    const typed = await tx`SELECT * FROM public.project_finance_lines WHERE project_id = ${projectId} ORDER BY id`;
    for (const t of typed) out(`   typed ${t.kind} ${t.category} ${t.amount} archived ${day(t.archived_at) || '-'} | ${String(t.description ?? '').slice(0, 60)}`);
  }

  /* The sweep: cancelled vouchers and AP invoices whose tagged legs still count. */
  const legs = await tx`
    SELECT l.company_id, l.project_id, l.account_code, l.debit_sen, l.credit_sen, je.je_no, je.entry_date, je.source_type, je.source_doc_no, je.posted, je.reversed, je.reversed_by_je::text AS reversed_by_je
      FROM scm.journal_entry_lines l JOIN scm.journal_entries je ON je.id = l.journal_entry_id
     WHERE l.project_id IS NOT NULL AND je.source_type IN ('PV', 'PV_REVERSAL', 'API', 'API_REVERSAL', 'AP_INVOICE', 'AP_INVOICE_REVERSAL')`;
  const counted = legs.filter(countsInTheBooks);
  const cancelledPv = new Set((await tx`SELECT pv_number FROM scm.payment_vouchers WHERE status = 'CANCELLED'`).map((r) => String(r.pv_number)));
  const cancelledApi = new Set((await tx`SELECT invoice_number FROM scm.ap_invoices WHERE status = 'CANCELLED'`).map((r) => String(r.invoice_number)));
  const stuck = counted.filter((l) => cancelledPv.has(String(l.source_doc_no)) || cancelledApi.has(String(l.source_doc_no)));
  out(`sweep: tagged legs ${legs.length}, counting ${counted.length}, counting though the document is cancelled ${stuck.length}`);
  for (const l of stuck.slice(0, 30)) out(`   ${l.company_id} project ${l.project_id} ${l.je_no} ${String(l.entry_date).slice(0, 10)} ${l.source_type} ${l.source_doc_no} ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)} posted ${l.posted} reversed ${l.reversed} by ${l.reversed_by_je ?? '-'}`);
  const reversals = counted.filter((l) => /_REVERSAL$/.test(String(l.source_type)));
  out(`sweep: reversal legs that count by themselves ${reversals.length}`);
  for (const l of reversals.slice(0, 30)) out(`   ${l.company_id} project ${l.project_id} ${l.je_no} ${String(l.entry_date).slice(0, 10)} ${l.source_type} ${l.source_doc_no} ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)} posted ${l.posted} reversed ${l.reversed} by ${l.reversed_by_je ?? '-'}`);
  const twice = new Map();
  for (const l of counted) { const k = `${l.project_id}|${l.source_doc_no}|${l.account_code}`; twice.set(k, (twice.get(k) ?? 0) + 1); }
  const many = [...twice.entries()].filter(([, n]) => n > 1);
  out(`sweep: same document + account + fair counting more than once: ${many.length} ${many.slice(0, 12).map(([k, n]) => `${k}×${n}`).join(', ')}`);
  /* Same payee, same fair, same amount on more than one live voucher: paid twice? */
  const liveLines = await tx`
    SELECT pv.company_id, pv.pv_number, pv.status, pv.checked_at, pv.approved_at, pv.payee_name, l.project_id, l.amount_sen, p.name AS project
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
      LEFT JOIN public.projects p ON p.id = l.project_id
     WHERE l.project_id IS NOT NULL AND pv.status NOT IN ('CANCELLED')`;
  const dup = new Map();
  for (const l of liveLines) { const k = `${l.company_id}|${l.project_id}|${l.amount_sen}`; dup.set(k, [...(dup.get(k) ?? []), l]); }
  const dups = [...dup.values()].filter((xs) => xs.length > 1);
  out(`same fair + same amount on more than one live voucher: ${dups.length}`);
  for (const xs of dups.slice(0, 14)) out(`   ${xs[0].project} ${rm(xs[0].amount_sen)}: ${xs.map((x) => `${x.pv_number} ${x.status}${x.checked_at ? ' checked' : ''}${x.approved_at ? ' approved' : ''} ${String(x.payee_name ?? '').slice(0, 18)}`).join(' / ')}`);

  /* Who may reject a payment request. */
  const roles = await tx`SELECT * FROM public.roles ORDER BY name`;
  const users = await tx`SELECT role_id, count(*)::int AS n, string_agg(name, ', ' ORDER BY name) AS names FROM public.users WHERE status = 'active' GROUP BY role_id`;
  const usersOf = new Map(users.map((u) => [Number(u.role_id), u]));
  const permsOf = (r) => { try { const p = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions; return Array.isArray(p) ? p : []; } catch { return []; } };
  out('-- roles: name | active users | * | scm.payment_voucher.create | scm.payment_request.create | scm.payment_voucher.check/approve | who');
  for (const r of roles) {
    const p = permsOf(r);
    const star = p.includes('*');
    const create = p.includes('scm.payment_voucher.create');
    const req = p.includes('scm.payment_request.create');
    const other = p.filter((k) => /^scm\.payment_voucher\./.test(k) && k !== 'scm.payment_voucher.create');
    const u = usersOf.get(Number(r.id));
    if (!star && !create && !req && !/financ/i.test(String(r.name))) continue;
    out(`${r.name} | ${u?.n ?? 0} | ${star} | ${create} | ${req} | ${other.join(' ')} | ${String(u?.names ?? '').slice(0, 160)}`);
  }
  const rejected = await tx`SELECT company_id, request_no, status, decided_by, decided_at, finance_note FROM scm.acc_payment_requests WHERE status = 'REJECTED' ORDER BY decided_at DESC LIMIT 12`;
  for (const r of rejected) out(`rejected ${r.request_no} by ${r.decided_by ?? '-'} ${day(r.decided_at)} | ${String(r.finance_note ?? '').slice(0, 70)}`);
  const by = await tx`SELECT decided_by, count(*)::int AS n FROM scm.acc_payment_requests WHERE status = 'REJECTED' GROUP BY 1 ORDER BY 2 DESC`;
  out(`rejected by: ${by.map((b) => `${b.decided_by ?? '-'} ${b.n}`).join(', ')}`);
  });
await sql.end();
