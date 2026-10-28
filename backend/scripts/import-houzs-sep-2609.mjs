#!/usr/bin/env node
/* import-houzs-sep-2609.mjs — Houzs (company 1): AutoCount's September 2026
   papers the ERP lacks (owner 2026-10-28: 「开始导入9月的资料」; the books open
   01/09 on AutoCount's 31/08). Data: scripts/data/houzs-sep-2609.json, built
   from AutoCount's GL 01/09–30/09 (the GL of record) and its AP Payment listing
   with knock-offs, matched against the ERP:
     • purchase invoices → AP invoices, POSTED, each journal on its own day; six
       replace the ERP's migrated copies (no journal), which close "Replaced by …";
     • the purchase return → a supplier credit note, POSTED;
     • the trade-finance receipt → a receipt, POSTED (a receipt posts as it is
       recorded — 不需要走四层);
     • payments → payment vouchers as DRAFTS, ticks on the opening / September
       bills as AutoCount knocked them off — Finance Prepare → Check → Approve,
       and the approval posts the journal, settles the bills, records advances;
     • journal vouchers → MANUAL drafts — Finance posts them.
   Suppliers AutoCount pays that the ERP lacks are created (Finance-only).
   What the ERP already holds, and what waits on the owner, is left out
   (data.skipped). MODE=plan (default) rolls everything back; MODE=apply +
   CONFIRM="IMPORT HOUZS SEP" keeps it. Refuses a second run. Verifies inside
   the transaction: every posted journal balanced, the books still balance,
   each supplier moved by exactly its papers, drafts touch no ledger, no bill
   ticked beyond what it owes.
   Env: DATABASE_URL, COMPANY_ID (1). */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
const PHRASE = 'IMPORT HOUZS SEP';
const CO = Number(process.env.COMPANY_ID || 1);
const BOOKS_START = '2026-09-01';
const TAG = '(September import)';
const ACTOR = 'AutoCount September import (owner 2026-10-28)';
const data = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'houzs-sep-2609.json'), 'utf8'));
const NEW_SUPPLIERS = { '400-C007': 'CV SMART ENTERPRISE', '405-G001': 'GORGEOUS EVENT SDN. BHD.' };
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const emit = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const yymm = (d) => d.slice(2, 4) + d.slice(5, 7);
class Rollback extends Error {}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`MODE=apply needs CONFIRM="${PHRASE}".`); process.exit(2); }
  out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}, company ${CO}, data built ${data.builtAt}`);
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
  /* ── 0. the books, and no second run ────────────────────────────────────── */
  const st = await tx`SELECT books_start_date::text AS start FROM scm.acc_company_settings WHERE company_id = ${CO}`;
  if (st[0]?.start !== BOOKS_START) throw new Error(`the books start on ${st[0]?.start ?? 'no day'}, not ${BOOKS_START}`);
  const like = `%${TAG}%`;
  const again = await tx`SELECT (SELECT count(*) FROM scm.payment_vouchers WHERE company_id = ${CO} AND notes LIKE ${like})::int
      + (SELECT count(*) FROM scm.ap_invoices WHERE company_id = ${CO} AND notes LIKE ${like})::int
      + (SELECT count(*) FROM scm.acc_receipts WHERE company_id = ${CO} AND notes LIKE ${like})::int
      + (SELECT count(*) FROM scm.journal_entries WHERE company_id = ${CO} AND narration LIKE ${like})::int AS n`;
  if (again[0].n > 0) throw new Error(`the September import already ran (${again[0].n} papers carry "${TAG}") — refusing a second run`);

  const roleRows = await tx`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${CO}`;
  const role = { AP: '400-0000', AP_OTHER: '405-0000', ...Object.fromEntries(roleRows.map((r) => [r.role, r.account_code])) };
  const control = (code) => (String(code).startsWith('405-') ? role.AP_OTHER : role.AP);
  const chart = new Map((await tx`SELECT account_code, account_name, is_active, acc_money FROM scm.accounts WHERE company_id = ${CO}`).map((a) => [a.account_code, a]));
  const parents = new Set((await tx`SELECT DISTINCT parent_code FROM scm.accounts WHERE company_id = ${CO} AND parent_code IS NOT NULL`).map((r) => r.parent_code));
  const leaf = (code, where) => {
    const a = chart.get(code);
    if (!a || a.is_active === false || parents.has(code)) throw new Error(`${where}: ${code} is not a live leaf account`);
  };
  const controls = new Set([role.AP, role.AP_OTHER, role.AR, role.AR_OTHER].filter(Boolean));
  for (const b of data.bills) for (const l of b.lines) leaf(l.acc, b.acDoc);
  for (const p of data.pvs) { leaf(p.bank, p.acDoc); if (!chart.get(p.bank)?.acc_money) throw new Error(`${p.acDoc}: pays from ${p.bank}, not a money account`); for (const l of p.lines) if (!(p.kind === 'AP' && l.acc === control(p.supplier))) leaf(l.acc, p.acDoc); }
  for (const j of data.jvs) for (const l of j.lines) { leaf(l.acc, j.acDoc); if (controls.has(l.acc)) throw new Error(`${j.acDoc}: a hand journal cannot touch the control ${l.acc}`); }
  for (const r of data.receipts) { leaf(r.bank, r.acDoc); for (const l of r.lines) leaf(l.acc, r.acDoc); }

  /* ── 1. suppliers (two AutoCount pays the ERP never had) ────────────────── */
  const supBy = new Map((await tx`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO}`).map((s) => [s.code, s]));
  const wanted = new Set([...data.bills.map((b) => b.supplier), ...data.pvs.filter((p) => p.supplier).map((p) => p.supplier)]);
  const missing = [...wanted].filter((c) => !supBy.has(c));
  for (const c of missing) if (!NEW_SUPPLIERS[c]) throw new Error(`supplier ${c} is not in the ERP and has no name here`);
  if (missing.length) {
    for (const s of await tx`INSERT INTO scm.suppliers ${tx(missing.map((c) => ({ company_id: CO, code: c, name: NEW_SUPPLIERS[c], currency: 'MYR', for_purchasing: false })))} RETURNING id, code, name`) supBy.set(s.code, s);
    out(`suppliers created (Finance-only): ${missing.map((c) => `${c} ${NEW_SUPPLIERS[c]}`).join('; ')}`);
  }
  const supOf = (c) => { const s = supBy.get(c); if (!s) throw new Error(`supplier ${c} missing`); return s; };

  /* ── 2. numbers: claim each series' block once ──────────────────────────── */
  const claim = async (series, table, col, n, scoped = true) => {
    if (n <= 0) return 0;
    const floor = Number((await tx.unsafe(`SELECT coalesce(max(substring(${col} from '-([0-9]+)$')::int), 0) AS n FROM scm.${table}
        WHERE ${col} LIKE $1${scoped ? ' AND company_id = $2' : ''}`, scoped ? [`${series}-%`, CO] : [`${series}-%`]))[0].n);
    const r = await tx`INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source) VALUES (${series}, ${floor + 1 + n}, ${`self-seeded by the AutoCount September import from the live max (${floor})`})
        ON CONFLICT (series) DO UPDATE SET next_n = GREATEST(c.next_n, ${floor + 1}) + ${n}, updated_at = now() RETURNING next_n - ${n} AS first`;
    return Number(r[0].first);
  };
  const apiBills = data.bills.filter((b) => b.kind === 'API');
  const scnBills = data.bills.filter((b) => b.kind === 'SCN');
  for (const b of data.bills) if (b.date.slice(0, 7) !== '2026-09') throw new Error(`${b.acDoc} is dated ${b.date}, not September`);
  const jeCount = apiBills.length + scnBills.length + data.receipts.length + data.jvs.length;
  let nApi = await claim('HC-API-2609', 'ap_invoices', 'invoice_number', apiBills.length);
  let nScn = await claim('HC-SCN-2609', 'acc_credit_notes', 'note_number', scnBills.length);
  let nOr = await claim('HC-OR-2609', 'acc_receipts', 'receipt_number', data.receipts.length);
  let nJe = await claim('JE-2609', 'journal_entries', 'je_no', jeCount, false);
  let nPv = await claim('HC-Draft-2609', 'payment_vouchers', 'pv_number', data.pvs.length);
  const nextJe = () => `JE-2609-${String(nJe++).padStart(4, '0')}`;
  const nowIso = new Date().toISOString();
  const audits = [];

  /* AP balance per supplier BEFORE, as the books read it (30/09) */
  const supCodes = [...new Set(data.bills.map((b) => b.supplier))];
  const apBefore = new Map((await tx`SELECT party_code AS code, sum(credit_sen - debit_sen)::bigint AS owed FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= '2026-09-30' AND party_code = ANY(${supCodes}::text[]) AND account_code IN (${role.AP}, ${role.AP_OTHER}) GROUP BY 1`).map((r) => [r.code, Number(r.owed)]));

  /* ── 3. purchase invoices → AP invoices, posted ─────────────────────────── */
  const journals = []; // { no, date, src, doc, narration, lines: [{a, dr, cr, pt, pc, pn, notes}], post }
  for (const b of apiBills) b.no = `HC-API-2609-${String(nApi++).padStart(3, '0')}`;
  const noteOfBill = (b) => `AutoCount ${b.acDoc}${b.ref ? ` — supplier invoice ${b.ref}` : ''} ${TAG}${b.replacesCopy ? `; replaces the migrated copy ${b.replacesCopy}` : ''}`;
  const apiIds = new Map();
  if (apiBills.length) {
    for (const r of await tx`INSERT INTO scm.ap_invoices ${tx(apiBills.map((b) => ({ company_id: CO, invoice_number: b.no, supplier_id: supOf(b.supplier).id, supplier_invoice_ref: b.ref, invoice_date: b.date,
      currency: 'MYR', exchange_rate: 1, total_sen: b.total, paid_sen: 0, status: 'POSTED', notes: noteOfBill(b), created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR })))} RETURNING id, invoice_number`) apiIds.set(r.invoice_number, r.id);
    await tx`INSERT INTO scm.ap_invoice_lines ${tx(apiBills.flatMap((b) => b.lines.map((l, i) => ({ company_id: CO, invoice_id: apiIds.get(b.no), line_no: i + 1, description: l.desc, debit_account_code: l.acc, amount_sen: l.sen }))))}`;
  }
  for (const b of apiBills) {
    const s = supOf(b.supplier);
    journals.push({ no: nextJe(), date: b.date, src: 'API', doc: b.no, post: true, narration: `AP invoice ${b.no} — ${s.name}${b.ref ? ` (${b.ref})` : ''} — AutoCount ${b.acDoc} ${TAG}`,
      lines: [...b.lines.map((l) => ({ a: l.acc, dr: l.sen, cr: 0, notes: l.desc ?? `AP invoice ${b.no}` })), { a: control(s.code), dr: 0, cr: b.total, pt: 'SUPPLIER', pc: s.code, pn: s.name, notes: `AP invoice ${b.no}` }] });
    audits.push({ entity_type: 'AP_INVOICE', entity_id: String(apiIds.get(b.no)), entity_doc_no: b.no, action: 'CREATE', status_snapshot: 'POSTED', note: noteOfBill(b) });
  }

  /* the migrated copies the new bills replace — closed, never deleted */
  const copies = apiBills.filter((b) => b.replacesCopy);
  if (copies.length) {
    const rows = await tx`SELECT id, invoice_number, total_sen, paid_sen, status::text AS status, coalesce(migrated_no_stock, false) AS migrated FROM scm.purchase_invoices
        WHERE company_id = ${CO} AND invoice_number = ANY(${copies.map((b) => b.replacesCopy)}::text[])`;
    for (const b of copies) {
      const c = rows.find((r) => r.invoice_number === b.replacesCopy);
      if (!c || !c.migrated) throw new Error(`${b.replacesCopy} is not a migrated copy`);
      const ticks = await tx`SELECT v.pv_number FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id WHERE a.pi_id = ${c.id} AND v.status::text <> 'CANCELLED'`;
      const knocks = await tx`SELECT 1 FROM scm.acc_credit_note_allocations WHERE purchase_invoice_id = ${c.id}`;
      if (ticks.length || knocks.length) throw new Error(`${c.invoice_number} carries ticks (${ticks.map((t) => t.pv_number).join(', ')}) — move them first`);
      const note = `Replaced by ${b.no} (${TAG}, AutoCount ${b.acDoc} RM ${rm(b.total)}; this copy carried RM ${rm(c.total_sen)})`;
      await tx`UPDATE scm.purchase_invoices SET paid_sen = total_sen, status = 'PAID', updated_at = now(), notes = concat_ws(E'\n', nullif(notes, ''), ${note}::text) WHERE id = ${c.id}`;
      audits.push({ entity_type: 'PURCHASE_INVOICE', entity_id: String(c.id), entity_doc_no: c.invoice_number, action: 'UPDATE', status_snapshot: 'PAID', note });
    }
  }

  /* ── 4. the purchase return → a supplier credit note, posted ────────────── */
  for (const b of scnBills) {
    const s = supOf(b.supplier);
    b.no = `HC-SCN-2609-${String(nScn++).padStart(3, '0')}`;
    const jeNo = nextJe();
    const note = `AutoCount ${b.acDoc} purchase return${b.ref ? ` ${b.ref}` : ''} ${TAG}`;
    const [{ id }] = await tx`INSERT INTO scm.acc_credit_notes ${tx({ company_id: CO, note_number: b.no, kind: 'SCN', party_type: 'SUPPLIER', party_code: s.code, party_name: s.name, supplier_id: s.id,
      source_doc_no: b.ref, note_date: b.date, total_sen: b.total, reason: note.slice(0, 300), notes: note, status: 'POSTED', je_no: jeNo, created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR })} RETURNING id`;
    await tx`INSERT INTO scm.acc_credit_note_lines ${tx(b.lines.map((l, i) => ({ company_id: CO, note_id: id, line_no: i + 1, description: l.desc, account_code: l.acc, amount_sen: l.sen })))}`;
    journals.push({ no: jeNo, date: b.date, src: 'SCN', doc: b.no, post: true, narration: `Supplier credit note ${b.no} — ${s.name}${b.ref ? ` (${b.ref})` : ''} — AutoCount ${b.acDoc} ${TAG}`,
      lines: [{ a: control(s.code), dr: b.total, cr: 0, pt: 'SUPPLIER', pc: s.code, pn: s.name, notes: `Supplier credit note ${b.no}` }, ...b.lines.map((l) => ({ a: l.acc, dr: 0, cr: l.sen, notes: l.desc ?? `Supplier credit note ${b.no}` }))] });
    audits.push({ entity_type: 'CREDIT_NOTE', entity_id: String(id), entity_doc_no: b.no, action: 'CREATE', status_snapshot: 'POSTED', note });
  }

  /* ── 5. receipts, posted ────────────────────────────────────────────────── */
  for (const r of data.receipts) {
    r.no = `HC-OR-2609-${String(nOr++).padStart(3, '0')}`;
    const total = sum(r.lines, (l) => l.sen);
    const [{ id }] = await tx`INSERT INTO scm.acc_receipts ${tx({ company_id: CO, receipt_number: r.no, payer_name: r.payer, receipt_date: r.date, bank_account_code: r.bank, total_sen: total, status: 'POSTED', notes: `${r.note}`, created_by: ACTOR })} RETURNING id`;
    await tx`INSERT INTO scm.acc_receipt_lines ${tx(r.lines.map((l, i) => ({ company_id: CO, receipt_id: id, line_no: i + 1, description: l.desc, credit_account_code: l.acc, amount_sen: l.sen })))}`;
    journals.push({ no: nextJe(), date: r.date, src: 'RCT', doc: r.no, post: true, narration: `Receipt ${r.no} — ${r.payer} — AutoCount ${r.acDoc} ${TAG}`,
      lines: [{ a: r.bank, dr: total, cr: 0, pn: r.payer, notes: `Receipt ${r.no} — ${r.payer}` }, ...r.lines.map((l) => ({ a: l.acc, dr: 0, cr: l.sen, notes: l.desc ?? r.no }))] });
    audits.push({ entity_type: 'RECEIPT', entity_id: String(id), entity_doc_no: r.no, action: 'CREATE', status_snapshot: 'POSTED', note: r.note });
  }

  /* ── 6. hand journals → MANUAL drafts ───────────────────────────────────── */
  for (const j of data.jvs) {
    j.no = nextJe();
    journals.push({ no: j.no, date: j.date, src: 'MANUAL', doc: j.acDoc, post: false, narration: `${j.narration} ${TAG}`.slice(0, 500),
      lines: j.lines.map((l) => ({ a: l.acc, dr: l.dr, cr: l.cr, notes: l.desc })) });
  }

  /* write every journal: header (unposted), lines, then post the posting ones */
  for (const j of journals) {
    const dr = sum(j.lines, (l) => l.dr); const cr = sum(j.lines, (l) => l.cr);
    if (dr !== cr || dr <= 0) throw new Error(`${j.no} (${j.doc}) does not balance: Dr ${dr} Cr ${cr}`);
    j.total = dr;
  }
  const jeIds = new Map();
  for (const r of await tx`INSERT INTO scm.journal_entries ${tx(journals.map((j) => ({ company_id: CO, je_no: j.no, entry_date: j.date, source_type: j.src, source_doc_no: j.doc, narration: j.narration,
    total_debit_sen: j.total, total_credit_sen: j.total, posted: false })))} RETURNING id, je_no`) jeIds.set(r.je_no, r.id);
  await tx`INSERT INTO scm.journal_entry_lines ${tx(journals.flatMap((j) => j.lines.map((l, i) => ({ company_id: CO, journal_entry_id: jeIds.get(j.no), line_no: i + 1, account_code: l.a,
    debit_sen: l.dr, credit_sen: l.cr, party_type: l.pt ?? null, party_code: l.pc ?? null, party_name: l.pn ?? null, notes: l.notes ?? null }))))}`;
  const toPost = journals.filter((j) => j.post).map((j) => jeIds.get(j.no));
  await tx`UPDATE scm.journal_entries SET posted = true, posted_at = now() WHERE id = ANY(${toPost}::uuid[])`;

  /* ── 7. payments → payment vouchers, DRAFT, with their ticks ────────────── */
  const billRows = await tx`SELECT 'API' AS k, id, invoice_number AS no, supplier_id, total_sen, paid_sen, status FROM scm.ap_invoices WHERE company_id = ${CO} AND status <> 'CANCELLED'
      UNION ALL SELECT 'PI', id, invoice_number, supplier_id, total_sen, paid_sen, status::text FROM scm.purchase_invoices WHERE company_id = ${CO} AND status::text NOT IN ('CANCELLED', 'DRAFT')`;
  const billBy = new Map(billRows.map((b) => [b.no, b]));
  const billOf = (t) => {
    const no = t.bill.startsWith('NEW:') ? apiBills.find((b) => b.acDoc === t.bill.slice(4))?.no : t.bill;
    const b = no ? billBy.get(no) : null;
    if (!b) throw new Error(`no ERP bill for ${t.bill} (AutoCount ${t.acPi})`);
    return b;
  };
  for (const p of data.pvs) p.no = `HC-Draft-2609-${String(nPv++).padStart(3, '0')}`;
  const pvIds = new Map();
  for (const r of await tx`INSERT INTO scm.payment_vouchers ${tx(data.pvs.map((p) => ({ company_id: CO, pv_number: p.no, voucher_date: p.date, payee_name: p.payee.slice(0, 200), supplier_id: p.supplier ? supOf(p.supplier).id : null,
    credit_account_code: p.bank, currency: 'MYR', exchange_rate: 1, purpose: p.purpose, notes: p.note, total_sen: p.total, bank_charge_sen: p.bankCharge || 0, status: 'DRAFT' })))} RETURNING id, pv_number`) pvIds.set(r.pv_number, r.id);
  await tx`INSERT INTO scm.payment_voucher_lines ${tx(data.pvs.flatMap((p) => p.lines.map((l, i) => ({ company_id: CO, pv_id: pvIds.get(p.no), line_no: i + 1, description: l.desc,
    debit_account_code: p.kind === 'AP' ? control(p.supplier) : l.acc, amount_sen: l.sen }))))}`;
  const allocs = data.pvs.flatMap((p) => p.ticks.map((t) => { const b = billOf(t); if (String(b.supplier_id) !== String(supOf(p.supplier).id)) throw new Error(`${p.acDoc}: tick on ${b.no} of another supplier`);
    return { company_id: CO, pv_id: pvIds.get(p.no), pi_id: b.k === 'PI' ? b.id : null, ap_invoice_id: b.k === 'API' ? b.id : null, amount_sen: t.sen, applied_sen: 0, from_advance: false }; }));
  if (allocs.length) await tx`INSERT INTO scm.pv_allocations ${tx(allocs)}`;
  for (const p of data.pvs) {
    if (sum(p.lines, (l) => l.sen) !== p.total) throw new Error(`${p.acDoc}: lines ≠ total`);
    if (sum(p.ticks, (t) => t.sen) > p.total) throw new Error(`${p.acDoc}: ticks beyond what it pays`);
    audits.push({ entity_type: 'PAYMENT_VOUCHER', entity_id: String(pvIds.get(p.no)), entity_doc_no: p.no, action: 'CREATE', status_snapshot: 'DRAFT', note: p.note });
  }

  await tx`INSERT INTO scm.entity_audit_log ${tx(audits.map((a) => ({ company_id: CO, ...a, actor_name_snapshot: ACTOR, field_changes: tx.json([]), source: 'script' })))}`;

  /* ── 8. verify ──────────────────────────────────────────────────────────── */
  const tb = await tx`SELECT sum(debit_sen)::bigint AS dr, sum(credit_sen)::bigint AS cr FROM scm.v_gl_entries WHERE company_id = ${CO} AND entry_date <= '2026-09-30'`;
  if (Number(tb[0].dr) !== Number(tb[0].cr)) throw new Error(`the books at 30/09 do not balance: Dr ${tb[0].dr} Cr ${tb[0].cr}`);
  const glMine = await tx`SELECT je_no, sum(debit_sen)::bigint AS dr, sum(credit_sen)::bigint AS cr, count(*)::int AS n FROM scm.v_gl_entries WHERE company_id = ${CO} AND je_no = ANY(${journals.map((j) => j.no)}::text[]) GROUP BY 1`;
  const glBy = new Map(glMine.map((g) => [g.je_no, g]));
  for (const j of journals) {
    const g = glBy.get(j.no);
    if (j.post && (!g || Number(g.dr) !== j.total || Number(g.cr) !== j.total || g.n !== j.lines.length)) throw new Error(`${j.no} (${j.doc}) is not in the books as written`);
    if (!j.post && g) throw new Error(`draft ${j.no} (${j.doc}) reached the books`);
  }
  const apAfter = new Map((await tx`SELECT party_code AS code, sum(credit_sen - debit_sen)::bigint AS owed FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= '2026-09-30' AND party_code = ANY(${supCodes}::text[]) AND account_code IN (${role.AP}, ${role.AP_OTHER}) GROUP BY 1`).map((r) => [r.code, Number(r.owed)]));
  for (const c of supCodes) {
    const want = sum(apiBills.filter((b) => b.supplier === c), (b) => b.total) - sum(scnBills.filter((b) => b.supplier === c), (b) => b.total);
    const moved = (apAfter.get(c) ?? 0) - (apBefore.get(c) ?? 0);
    if (moved !== want) throw new Error(`${c} moved RM ${rm(moved)} in the books, its papers say RM ${rm(want)}`);
  }
  const head = await tx`SELECT coalesce(a.ap_invoice_id::text, a.pi_id::text) AS bill, sum(a.amount_sen)::bigint AS planned FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id
      WHERE v.company_id = ${CO} AND v.status::text = 'DRAFT' AND coalesce(a.ap_invoice_id::text, a.pi_id::text) = ANY(${[...new Set(allocs.map((a) => String(a.ap_invoice_id ?? a.pi_id)))]}::text[]) GROUP BY 1`;
  const byId = new Map(billRows.map((b) => [String(b.id), b]));
  for (const h of head) {
    const b = byId.get(h.bill) ?? { no: '(new)', total_sen: 0, paid_sen: 0 };
    const nb = b.no === '(new)' ? apiBills.find((x) => String(apiIds.get(x.no)) === h.bill) : null;
    const owed = nb ? nb.total : Number(b.total_sen) - Number(b.paid_sen);
    if (Number(h.planned) > owed) throw new Error(`${nb ? nb.no : b.no}: unposted vouchers plan RM ${rm(h.planned)} > owed RM ${rm(owed)}`);
  }

  /* ── 9. report ──────────────────────────────────────────────────────────── */
  for (const b of apiBills) emit('DOC', { k: 'API', no: b.no, ac: b.acDoc, supplier: b.supplier, name: supOf(b.supplier).name, ref: b.ref, date: b.date, sen: b.total, replaces: b.replacesCopy, copySen: b.copyTotal,
    accounts: b.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), je: journals.find((j) => j.doc === b.no).no });
  for (const b of scnBills) emit('DOC', { k: 'SCN', no: b.no, ac: b.acDoc, supplier: b.supplier, name: supOf(b.supplier).name, ref: b.ref, date: b.date, sen: b.total, accounts: b.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), je: journals.find((j) => j.doc === b.no).no });
  for (const r of data.receipts) emit('DOC', { k: 'OR', no: r.no, ac: r.acDoc, payer: r.payer, bank: r.bank, date: r.date, sen: sum(r.lines, (l) => l.sen), accounts: r.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), je: journals.find((j) => j.doc === r.no).no });
  for (const j of data.jvs) emit('DOC', { k: 'JV', no: j.no, ac: j.acDoc, date: j.date, sen: sum(j.lines, (l) => l.dr), narration: j.narration, lines: j.lines.length });
  for (const p of data.pvs) emit('DOC', { k: 'PV', no: p.no, ac: p.acDoc, kind: p.kind, date: p.date, bank: p.bank, payee: p.payee, supplier: p.supplier, sen: p.total, charge: p.bankCharge || 0,
    accounts: p.kind === 'AP' ? control(p.supplier) : p.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), ticks: p.ticks.map((t) => `${billOf(t).no} ${rm(t.sen)} (AutoCount ${t.acPi})`).join('; '), advance: p.advance });
  for (const s of data.skipped) emit('SKIP', s);
  out(`AP invoices ${apiBills.length} RM ${rm(sum(apiBills, (b) => b.total))} posted (${copies.length} replace migrated copies); supplier credit notes ${scnBills.length} RM ${rm(sum(scnBills, (b) => b.total))}; receipts ${data.receipts.length} RM ${rm(sum(data.receipts, (r) => sum(r.lines, (l) => l.sen)))}`);
  out(`payment vouchers ${data.pvs.length} DRAFT RM ${rm(sum(data.pvs, (p) => p.total + (p.bankCharge || 0)))} (supplier ${data.pvs.filter((p) => p.kind === 'AP').length}, transfers ${data.pvs.filter((p) => p.kind === 'TRANSFER').length}, other ${data.pvs.filter((p) => p.kind === 'OTHER').length}); ticks ${allocs.length} RM ${rm(sum(allocs, (a) => a.amount_sen))}`);
  out(`journal vouchers ${data.jvs.length} DRAFT RM ${rm(sum(data.jvs, (j) => sum(j.lines, (l) => l.dr)))}; numbers ${journals[0]?.no ?? '-'} … ${journals.at(-1)?.no ?? '-'}, vouchers ${data.pvs[0]?.no ?? '-'} … ${data.pvs.at(-1)?.no ?? '-'}`);
  out(`VERIFIED: books at 30/09 balance (Dr = Cr RM ${rm(tb[0].dr)}); ${toPost.length} posted journals in the books as written; ${journals.length - toPost.length} drafts outside; ${supCodes.length} suppliers moved by exactly their papers; no bill ticked beyond what it owes`);
  out(`left out: ${data.skipped.length} — ${data.skipped.filter((s) => s.why.startsWith('ASK')).length} wait on the owner`);
}

main().catch((e) => { console.error(e); process.exit(1); });
