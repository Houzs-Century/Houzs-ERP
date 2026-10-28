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
     • payments → payment vouchers with ticks on the opening / September bills as
       AutoCount knocked them off — DRAFTS for Finance's Prepare → Check →
       Approve, or with POST_ALL=1 (owner 2026-10-28: 「这个直接帮我入账可以吗？」)
       POSTED here the way Approve posts them: the formal number minted from the
       bank's letter, the journal pvLines + pvBankChargeLines write, the bills
       settled through scm.settle_api_paid_sen / settle_pi_paid_sen, the part no
       tick takes recorded as the supplier's advance;
     • journal vouchers → MANUAL journals, drafts or (POST_ALL=1) posted.
   Suppliers AutoCount pays that the ERP lacks are created (Finance-only).
   What the ERP already holds, and what waits on the owner, is left out
   (data.skipped). MODE=plan (default) rolls everything back; MODE=apply +
   CONFIRM="IMPORT HOUZS SEP" keeps it. Refuses a second run. Verifies inside
   the transaction: every posted journal balanced, the books still balance,
   each supplier moved by exactly its papers, drafts touch no ledger, no bill
   ticked beyond what it owes.
   FIX_UNGROUPED=1 also mends the ERP's own five September purchase invoices
   that read POSTED with no journal (Sim 22/09: a pair of split lines on each
   lost its product group, so postPiAccounting refused line_ungrouped): the
   group goes back on those lines (…MATT → MATTRESS, JAGER → BEDFRAME) and the
   journal posts as postPiAccounting writes it — one Dr per group's purchase
   account, Cr the supplier's AP control, on the invoice's own day.
   Env: DATABASE_URL, COMPANY_ID (1), FIX_UNGROUPED (0), POST_ALL (0). */
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
const FIX_UNGROUPED = String(process.env.FIX_UNGROUPED || '0') === '1';
const POST_ALL = String(process.env.POST_ALL || '0') === '1';
const PV_BANK_CHARGE_ACCOUNT = '900-B001'; // acc/rules.ts
const UNGROUPED = ['HC-PI-2609-013', 'HC-PI-2609-014', 'HC-PI-2609-019', 'HC-PI-2609-025', 'HC-PI-2609-033'];
const groupOfName = (name) => (/\bMATT\b/i.test(name) ? 'MATTRESS' : /^JAGER\b/i.test(name) ? 'BEDFRAME' : null);
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
  const jeCount = apiBills.length + scnBills.length + data.receipts.length + data.jvs.length + (FIX_UNGROUPED ? UNGROUPED.length : 0) + (POST_ALL ? data.pvs.length : 0);
  let nApi = await claim('HC-API-2609', 'ap_invoices', 'invoice_number', apiBills.length);
  let nScn = await claim('HC-SCN-2609', 'acc_credit_notes', 'note_number', scnBills.length);
  let nOr = await claim('HC-OR-2609', 'acc_receipts', 'receipt_number', data.receipts.length);
  let nJe = await claim('JE-2609', 'journal_entries', 'je_no', jeCount, false);
  const nextJe = () => `JE-2609-${String(nJe++).padStart(4, '0')}`;
  /* Voucher numbers. A draft is born on {co}Draft-YYMM; a posted voucher carries
     the FORMAL number Check mints (mintFormalPvNo): {co}{bank letter}PV-YYMM-NNN,
     the letter from acc_bank_letters (the cash drawer is C), the width from
     acc_numbering — claimed per series in date + AutoCount order, the order the
     batch Check walks. */
  if (POST_ALL) {
    const letters = new Map((await tx`SELECT account_code, letter FROM scm.acc_bank_letters WHERE company_id = ${CO}`).map((r) => [r.account_code, r.letter]));
    const digits = Number((await tx`SELECT doc_digits FROM scm.acc_numbering WHERE company_id = ${CO}`)[0]?.doc_digits ?? 3);
    const seriesOf = (p) => { const l = p.bank === role.CASH ? 'C' : letters.get(p.bank); if (!l) throw new Error(`${p.acDoc}: ${p.bank} has no voucher letter`); return `HC-${l}PV-${yymm(p.date)}`; };
    const bySeries = new Map();
    for (const p of data.pvs) { const s = seriesOf(p); if (!bySeries.has(s)) bySeries.set(s, []); bySeries.get(s).push(p); }
    for (const [s, ps] of [...bySeries].sort()) {
      let n = await claim(s, 'payment_vouchers', 'pv_number', ps.length);
      for (const p of ps) p.no = `${s}-${String(n++).padStart(digits, '0')}`;
    }
  } else {
    let nPv = await claim('HC-Draft-2609', 'payment_vouchers', 'pv_number', data.pvs.length);
    for (const p of data.pvs) p.no = `HC-Draft-2609-${String(nPv++).padStart(3, '0')}`;
  }
  const nowIso = new Date().toISOString();
  const audits = [];

  /* AP balance per supplier BEFORE, as the books read it (30/09) */
  const fixSup = FIX_UNGROUPED ? (await tx`SELECT s.code FROM scm.purchase_invoices p JOIN scm.suppliers s ON s.id = p.supplier_id WHERE p.company_id = ${CO} AND p.invoice_number = ANY(${UNGROUPED}::text[])`).map((r) => r.code) : [];
  const supCodes = [...new Set([...data.bills.map((b) => b.supplier), ...fixSup, ...(POST_ALL ? data.pvs.filter((p) => p.kind === 'AP').map((p) => p.supplier) : [])])];
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

  /* ── 6. hand journals → MANUAL (drafts, or posted with POST_ALL) ─────────── */
  for (const j of data.jvs) {
    j.no = nextJe();
    journals.push({ no: j.no, date: j.date, src: 'MANUAL', doc: j.acDoc, post: POST_ALL, narration: `${j.narration} ${TAG}`.slice(0, 500),
      lines: j.lines.map((l) => ({ a: l.acc, dr: l.dr, cr: l.cr, notes: l.desc })) });
  }

  /* ── 6b. the ERP's own five POSTED invoices with no journal (FIX_UNGROUPED) ─ */
  const mended = [];
  if (FIX_UNGROUPED) {
    const binds = new Map((await tx`SELECT upper(trim(group_code)) AS g, purchase_account FROM scm.acc_item_group_accounts WHERE company_id = ${CO}`).map((b) => [b.g, b.purchase_account]));
    for (const no of UNGROUPED) {
      const [pi] = await tx`SELECT p.id, p.invoice_number, p.invoice_date::text AS d, p.total_sen, p.status::text AS status, coalesce(p.migrated_no_stock, false) AS migrated, coalesce(p.exchange_rate, 1)::numeric AS rate, p.currency::text AS currency, s.code, s.name
          FROM scm.purchase_invoices p JOIN scm.suppliers s ON s.id = p.supplier_id WHERE p.company_id = ${CO} AND p.invoice_number = ${no}`;
      if (!pi || pi.migrated || ['DRAFT', 'CANCELLED'].includes(pi.status) || pi.currency !== 'MYR') throw new Error(`${no} is not a posted MYR invoice of this company`);
      const live = await tx`SELECT je_no FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'PI' AND source_doc_no = ${no} AND NOT reversed AND reversed_by_je IS NULL`;
      if (live.length) throw new Error(`${no} already has journal ${live[0].je_no}`);
      const items = await tx`SELECT id, coalesce(item_code, material_name) AS name, item_group, line_total_sen FROM scm.purchase_invoice_items WHERE purchase_invoice_id = ${pi.id}`;
      const fixes = items.filter((i) => !String(i.item_group ?? '').trim()).map((i) => ({ id: i.id, name: i.name, group: groupOfName(String(i.name ?? '')) }));
      for (const f of fixes) if (!f.group) throw new Error(`${no}: no product group known for "${f.name}"`);
      for (const f of fixes) await tx`UPDATE scm.purchase_invoice_items SET item_group = ${f.group} WHERE id = ${f.id} AND (item_group IS NULL OR trim(item_group) = '')`;
      const by = new Map();
      for (const i of items) { const g = String(fixes.find((f) => f.id === i.id)?.group ?? i.item_group).trim().toUpperCase(); by.set(g, (by.get(g) ?? 0) + Number(i.line_total_sen ?? 0)); }
      const groups = [...by].map(([g, sen]) => { const a = binds.get(g); if (!a) throw new Error(`${no}: group ${g} has no purchase account`); return { g, a, sen }; });
      const drift = Number(pi.total_sen) - sum(groups, (x) => x.sen);
      if (drift !== 0) groups.reduce((m, x) => (x.sen > m.sen ? x : m)).sen += drift;
      const jeNo = nextJe();
      journals.push({ no: jeNo, date: pi.d, src: 'PI', doc: no, post: true, narration: `Purchase invoice ${no} — ${pi.name}`,
        lines: [...groups.map((x) => ({ a: x.a, dr: x.sen, cr: 0, notes: `Purchases — ${x.g} on ${no}` })), { a: control(pi.code), dr: 0, cr: Number(pi.total_sen), pt: 'SUPPLIER', pc: pi.code, pn: pi.name, notes: `AP for ${no}` }] });
      const note = `Journal ${jeNo} posted on ${pi.d} ${TAG}: ${fixes.length} line(s) had lost their product group (${[...new Set(fixes.map((f) => `${f.name} → ${f.group}`))].join(', ')}), so the posting was refused when Sim saved it on 22/09`;
      audits.push({ entity_type: 'PURCHASE_INVOICE', entity_id: String(pi.id), entity_doc_no: no, action: 'UPDATE', status_snapshot: pi.status, note });
      mended.push({ no, supplier: pi.code, name: pi.name, date: pi.d, sen: Number(pi.total_sen), je: jeNo, fixes: fixes.map((f) => `${f.name} → ${f.group}`) });
    }
  }

  /* ── 7. payments → payment vouchers with their ticks ────────────────────── */
  const billRows = await tx`SELECT 'API' AS k, id, invoice_number AS no, supplier_id, total_sen, paid_sen, status FROM scm.ap_invoices WHERE company_id = ${CO} AND status <> 'CANCELLED'
      UNION ALL SELECT 'PI', id, invoice_number, supplier_id, total_sen, paid_sen, status::text FROM scm.purchase_invoices WHERE company_id = ${CO} AND status::text NOT IN ('CANCELLED', 'DRAFT')`;
  const billBy = new Map(billRows.map((b) => [b.no, b]));
  const billOf = (t) => {
    const no = t.bill.startsWith('NEW:') ? apiBills.find((b) => b.acDoc === t.bill.slice(4))?.no : t.bill;
    const b = no ? billBy.get(no) : null;
    if (!b) throw new Error(`no ERP bill for ${t.bill} (AutoCount ${t.acPi})`);
    return b;
  };
  const pvIds = new Map();
  const marks = POST_ALL ? { status: 'POSTED', posted_at: nowIso, submitted_at: nowIso, submitted_by: ACTOR, checked_at: nowIso, checked_by: ACTOR, approved_at: nowIso, approved_by: ACTOR } : { status: 'DRAFT' };
  for (const r of await tx`INSERT INTO scm.payment_vouchers ${tx(data.pvs.map((p) => ({ company_id: CO, pv_number: p.no, voucher_date: p.date, payee_name: p.payee.slice(0, 200), supplier_id: p.supplier ? supOf(p.supplier).id : null,
    credit_account_code: p.bank, currency: 'MYR', exchange_rate: 1, purpose: p.purpose, notes: p.note, total_sen: p.total, bank_charge_sen: p.bankCharge || 0, ...marks })))} RETURNING id, pv_number`) pvIds.set(r.pv_number, r.id);
  await tx`INSERT INTO scm.payment_voucher_lines ${tx(data.pvs.flatMap((p) => p.lines.map((l, i) => ({ company_id: CO, pv_id: pvIds.get(p.no), line_no: i + 1, description: l.desc,
    debit_account_code: p.kind === 'AP' ? control(p.supplier) : l.acc, amount_sen: l.sen }))))}`;
  const allocs = data.pvs.flatMap((p) => p.ticks.map((t) => { const b = billOf(t); if (String(b.supplier_id) !== String(supOf(p.supplier).id)) throw new Error(`${p.acDoc}: tick on ${b.no} of another supplier`);
    return { company_id: CO, pv_id: pvIds.get(p.no), pi_id: b.k === 'PI' ? b.id : null, ap_invoice_id: b.k === 'API' ? b.id : null, amount_sen: t.sen, applied_sen: 0, from_advance: false }; }));
  const allocRows = allocs.length ? await tx`INSERT INTO scm.pv_allocations ${tx(allocs)} RETURNING id, pv_id, pi_id, ap_invoice_id, amount_sen` : [];
  for (const p of data.pvs) {
    if (sum(p.lines, (l) => l.sen) !== p.total) throw new Error(`${p.acDoc}: lines ≠ total`);
    if (sum(p.ticks, (t) => t.sen) > p.total) throw new Error(`${p.acDoc}: ticks beyond what it pays`);
    audits.push({ entity_type: 'PAYMENT_VOUCHER', entity_id: String(pvIds.get(p.no)), entity_doc_no: p.no, action: 'CREATE', status_snapshot: POST_ALL ? 'POSTED' : 'DRAFT', note: p.note });
    if (!POST_ALL) continue;
    /* Approve's journal, exactly: pvLines (the supplier's own AP-control leg
       carries the party; the bank leg names who was paid) + pvBankChargeLines. */
    const s = p.supplier ? supOf(p.supplier) : null;
    const fee = Number(p.bankCharge || 0);
    const lines = p.lines.map((l) => {
      const acc = p.kind === 'AP' ? control(p.supplier) : l.acc;
      const onControl = p.kind === 'AP' && !!s;
      return { a: acc, dr: l.sen, cr: 0, pt: onControl ? 'SUPPLIER' : null, pc: onControl ? s.code : null, pn: onControl ? (s.name ?? p.payee) : null, notes: `${l.desc ?? 'Payment'} — ${p.no}` };
    });
    lines.push({ a: p.bank, dr: 0, cr: p.total, pt: s ? 'SUPPLIER' : null, pc: s ? s.code : null, pn: s ? s.name : p.payee, notes: `Payment to ${p.payee} — ${p.no}` });
    if (fee > 0) lines.push({ a: PV_BANK_CHARGE_ACCOUNT, dr: fee, cr: 0, notes: `Bank charges — ${p.no}` }, { a: p.bank, dr: 0, cr: fee, notes: `Bank charges — ${p.no}` });
    p.je = nextJe();
    journals.push({ no: p.je, date: p.date, src: 'PV', doc: p.no, post: true, narration: `Payment voucher ${p.no} — ${p.payee} — AutoCount ${p.acDoc} ${TAG}`, lines });
    audits.push({ entity_type: 'PAYMENT_VOUCHER', entity_id: String(pvIds.get(p.no)), entity_doc_no: p.no, action: 'POST', status_snapshot: 'POSTED', note: `GL entry ${p.je}` });
  }
  if (POST_ALL) leaf(PV_BANK_CHARGE_ACCOUNT, 'bank charges');

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

  /* the posted vouchers settle their bills (the database clamps, as on Approve)
     and leave the untaken part as the supplier's advance */
  const advances = [];
  if (POST_ALL) {
    for (const a of allocRows) {
      const [r] = a.ap_invoice_id
        ? await tx`SELECT applied_sen, new_status, reason FROM scm.settle_api_paid_sen(${a.ap_invoice_id}::uuid, ${Number(a.amount_sen)}::bigint)`
        : await tx`SELECT applied_sen, new_status, reason FROM scm.settle_pi_paid_sen(${a.pi_id}::uuid, ${Number(a.amount_sen)}::bigint)`;
      if (Number(r.applied_sen) !== Number(a.amount_sen)) throw new Error(`a tick of RM ${rm(a.amount_sen)} settled only RM ${rm(r.applied_sen)} (${r.reason ?? r.new_status})`);
      await tx`UPDATE scm.pv_allocations SET applied_sen = ${Number(r.applied_sen)} WHERE id = ${a.id}`;
    }
    for (const p of data.pvs.filter((x) => x.kind === 'AP')) {
      const adv = p.total - sum(p.ticks, (t) => t.sen);
      if (adv > 0) advances.push({ company_id: CO, supplier_id: String(supOf(p.supplier).id), pv_id: String(pvIds.get(p.no)), pv_number: p.no, amount_sen: adv, applied_sen: 0 });
    }
    if (advances.length) await tx`INSERT INTO scm.acc_supplier_advances ${tx(advances)}`;
    for (const a of advances) audits.push({ entity_type: 'PAYMENT_VOUCHER', entity_id: a.pv_id, entity_doc_no: a.pv_number, action: 'UPDATE', status_snapshot: 'POSTED',
      note: `Paid RM ${rm(a.amount_sen)} ahead of any invoice — recorded as this supplier's advance, to knock off against invoices to come` });
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
    const paid = POST_ALL ? sum(data.pvs.filter((p) => p.kind === 'AP' && p.supplier === c), (p) => p.total) : 0;
    const want = sum(apiBills.filter((b) => b.supplier === c), (b) => b.total) - sum(scnBills.filter((b) => b.supplier === c), (b) => b.total) + sum(mended.filter((m) => m.supplier === c), (m) => m.sen) - paid;
    const moved = (apAfter.get(c) ?? 0) - (apBefore.get(c) ?? 0);
    if (moved !== want) throw new Error(`${c} moved RM ${rm(moved)} in the books, its papers say RM ${rm(want)}`);
  }
  /* no bill ticked beyond what it owes: what is paid now + what any unposted
     voucher (this import's drafts, or Finance's own) still plans */
  const touched = [...new Set(allocs.map((a) => String(a.ap_invoice_id ?? a.pi_id)))];
  const nowBills = touched.length ? await tx`SELECT id::text AS id, invoice_number AS no, total_sen, paid_sen FROM scm.ap_invoices WHERE id::text = ANY(${touched}::text[])
      UNION ALL SELECT id::text, invoice_number, total_sen, paid_sen FROM scm.purchase_invoices WHERE id::text = ANY(${touched}::text[])` : [];
  const head = touched.length ? await tx`SELECT coalesce(a.ap_invoice_id::text, a.pi_id::text) AS bill, sum(a.amount_sen)::bigint AS planned FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id
      WHERE v.company_id = ${CO} AND v.status::text = 'DRAFT' AND coalesce(a.ap_invoice_id::text, a.pi_id::text) = ANY(${touched}::text[]) GROUP BY 1` : [];
  const plannedBy = new Map(head.map((h) => [h.bill, Number(h.planned)]));
  for (const b of nowBills) {
    const planned = plannedBy.get(b.id) ?? 0;
    if (Number(b.paid_sen) + planned > Number(b.total_sen)) throw new Error(`${b.no}: paid RM ${rm(b.paid_sen)} + planned RM ${rm(planned)} > total RM ${rm(b.total_sen)}`);
  }
  if (POST_ALL) {
    const settled = touched.length ? await tx`SELECT sum(applied_sen)::bigint AS s FROM scm.pv_allocations WHERE id = ANY(${allocRows.map((a) => a.id)}::uuid[])` : [{ s: 0 }];
    if (Number(settled[0].s ?? 0) !== sum(allocs, (a) => a.amount_sen)) throw new Error(`ticks settled RM ${rm(settled[0].s)} of RM ${rm(sum(allocs, (a) => a.amount_sen))}`);
  }

  /* ── 8b. read-back for the owner's 「再三确定」: what the books now hold, as
     the database has it, for an offline check against AutoCount's own GL and
     knock-off listing (VERIFY_DUMP=1) ───────────────────────────────────── */
  if (String(process.env.VERIFY_DUMP || '0') === '1') {
    const jl = await tx`SELECT j.je_no, j.source_type, j.source_doc_no, j.narration, j.posted, l.account_code, l.debit_sen, l.credit_sen, l.party_code
        FROM scm.journal_entries j JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
        WHERE j.company_id = ${CO} AND j.je_no = ANY(${journals.map((j) => j.no)}::text[]) ORDER BY j.je_no, l.line_no`;
    const byJe = new Map();
    for (const r of jl) { if (!byJe.has(r.je_no)) byJe.set(r.je_no, { je: r.je_no, src: r.source_type, doc: r.source_doc_no, narration: r.narration, posted: r.posted, lines: [] }); byJe.get(r.je_no).lines.push([r.account_code, Number(r.debit_sen), Number(r.credit_sen), r.party_code]); }
    for (const j of byJe.values()) emit('JL', j);
    for (const a of await tx`SELECT v.pv_number, v.notes AS pv_notes, v.status::text AS pv_status, a.amount_sen, a.applied_sen, coalesce(x.invoice_number, p.invoice_number) AS bill,
        coalesce(x.notes, p.notes) AS bill_notes, coalesce(x.supplier_invoice_ref, p.supplier_invoice_ref) AS bill_ref, coalesce(x.total_sen, p.total_sen) AS bill_total, coalesce(x.paid_sen, p.paid_sen) AS bill_paid,
        coalesce(x.status, p.status::text) AS bill_status, p.linked_ac_docno AS bill_ac
        FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id LEFT JOIN scm.ap_invoices x ON x.id = a.ap_invoice_id LEFT JOIN scm.purchase_invoices p ON p.id = a.pi_id
        WHERE a.pv_id = ANY(${[...pvIds.values()]}::uuid[])`) {
      emit('AL', { pv: a.pv_number, pvNotes: a.pv_notes, pvStatus: a.pv_status, sen: Number(a.amount_sen), applied: Number(a.applied_sen), bill: a.bill, billNotes: String(a.bill_notes ?? '').slice(0, 200), billRef: a.bill_ref,
        billTotal: Number(a.bill_total), billPaid: Number(a.bill_paid), billStatus: a.bill_status, billAc: a.bill_ac });
    }
    for (const a of await tx`SELECT pv_number, amount_sen, applied_sen FROM scm.acc_supplier_advances WHERE pv_id = ANY(${[...pvIds.values()].map(String)}::text[])`) emit('ADVX', { pv: a.pv_number, sen: Number(a.amount_sen) });
    for (const r of await tx`SELECT party_code AS code, sum(credit_sen - debit_sen)::bigint AS owed FROM scm.v_gl_entries WHERE company_id = ${CO} AND entry_date <= '2026-09-30'
        AND account_code IN (${role.AP}, ${role.AP_OTHER}) AND party_code IS NOT NULL GROUP BY 1`) emit('APAFTER', { code: r.code, owed: Number(r.owed) });
    for (const r of await tx`SELECT party_code AS code, source_type AS src, source_doc_no AS doc, je_no, entry_date::text AS d, sum(credit_sen - debit_sen)::bigint AS net FROM scm.v_gl_entries
        WHERE company_id = ${CO} AND entry_date >= '2026-09-01' AND entry_date <= '2026-09-30' AND NOT opening AND account_code IN (${role.AP}, ${role.AP_OTHER}) AND party_code IS NOT NULL
          AND je_no <> ALL(${journals.map((j) => j.no)}::text[]) GROUP BY 1, 2, 3, 4, 5`) emit('APOWN', { code: r.code, src: r.src, doc: r.doc, je: r.je_no, date: r.d, net: Number(r.net) });
    for (const r of await tx`SELECT account_code AS acc, sum(debit_sen - credit_sen)::bigint AS bal FROM scm.v_gl_entries WHERE company_id = ${CO} AND entry_date <= '2026-09-30' GROUP BY 1`) emit('TBAFTER', { acc: r.acc, bal: Number(r.bal) });
    for (const r of await tx`SELECT account_code AS acc, source_type AS src, sum(debit_sen - credit_sen)::bigint AS net, count(*)::int AS n FROM scm.v_gl_entries
        WHERE company_id = ${CO} AND entry_date >= '2026-09-01' AND entry_date <= '2026-09-30' AND NOT opening AND je_no <> ALL(${journals.map((j) => j.no)}::text[]) GROUP BY 1, 2`) emit('OWNSEP', { acc: r.acc, src: r.src, net: Number(r.net), n: r.n });
  }

  /* ── 9. report ──────────────────────────────────────────────────────────── */
  for (const b of apiBills) emit('DOC', { k: 'API', no: b.no, ac: b.acDoc, supplier: b.supplier, name: supOf(b.supplier).name, ref: b.ref, date: b.date, sen: b.total, replaces: b.replacesCopy, copySen: b.copyTotal,
    accounts: b.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), je: journals.find((j) => j.doc === b.no).no });
  for (const b of scnBills) emit('DOC', { k: 'SCN', no: b.no, ac: b.acDoc, supplier: b.supplier, name: supOf(b.supplier).name, ref: b.ref, date: b.date, sen: b.total, accounts: b.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), je: journals.find((j) => j.doc === b.no).no });
  for (const r of data.receipts) emit('DOC', { k: 'OR', no: r.no, ac: r.acDoc, payer: r.payer, bank: r.bank, date: r.date, sen: sum(r.lines, (l) => l.sen), accounts: r.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), je: journals.find((j) => j.doc === r.no).no });
  for (const j of data.jvs) emit('DOC', { k: 'JV', no: j.no, ac: j.acDoc, date: j.date, sen: sum(j.lines, (l) => l.dr), narration: j.narration, lines: j.lines.length });
  for (const p of data.pvs) emit('DOC', { k: 'PV', no: p.no, ac: p.acDoc, kind: p.kind, date: p.date, bank: p.bank, payee: p.payee, supplier: p.supplier, sen: p.total, charge: p.bankCharge || 0,
    accounts: p.kind === 'AP' ? control(p.supplier) : p.lines.map((l) => `${l.acc} ${rm(l.sen)}`).join('; '), ticks: p.ticks.map((t) => `${billOf(t).no} ${rm(t.sen)} (AutoCount ${t.acPi})`).join('; '), advance: p.advance, je: p.je ?? null });
  for (const s of data.skipped) emit('SKIP', s);
  for (const m of mended) emit('MEND', m);
  if (FIX_UNGROUPED) out(`the ERP's own invoices with no journal: ${mended.length} mended RM ${rm(sum(mended, (m) => m.sen))} (${mended.map((m) => `${m.no} ${m.je}`).join(', ')})`);
  out(`AP invoices ${apiBills.length} RM ${rm(sum(apiBills, (b) => b.total))} posted (${copies.length} replace migrated copies); supplier credit notes ${scnBills.length} RM ${rm(sum(scnBills, (b) => b.total))}; receipts ${data.receipts.length} RM ${rm(sum(data.receipts, (r) => sum(r.lines, (l) => l.sen)))}`);
  const series = [...new Set(data.pvs.map((p) => p.no.replace(/-\d+$/, '')))].map((s) => { const ns = data.pvs.filter((p) => p.no.startsWith(`${s}-`)).map((p) => p.no); return `${ns[0]}…${ns.at(-1)?.slice(-3)} (${ns.length})`; });
  out(`payment vouchers ${data.pvs.length} ${POST_ALL ? 'POSTED' : 'DRAFT'} RM ${rm(sum(data.pvs, (p) => p.total + (p.bankCharge || 0)))} (supplier ${data.pvs.filter((p) => p.kind === 'AP').length}, transfers ${data.pvs.filter((p) => p.kind === 'TRANSFER').length}, other ${data.pvs.filter((p) => p.kind === 'OTHER').length}); ticks ${allocs.length} RM ${rm(sum(allocs, (a) => a.amount_sen))}${POST_ALL ? ` settled; advances ${advances.length} RM ${rm(sum(advances, (a) => a.amount_sen))}` : ''}; numbers ${series.join(', ')}`);
  out(`journal vouchers ${data.jvs.length} ${POST_ALL ? 'POSTED' : 'DRAFT'} RM ${rm(sum(data.jvs, (j) => sum(j.lines, (l) => l.dr)))}; journals ${journals[0]?.no ?? '-'} … ${journals.at(-1)?.no ?? '-'}`);
  out(`VERIFIED: books at 30/09 balance (Dr = Cr RM ${rm(tb[0].dr)}); ${toPost.length} posted journals in the books as written; ${journals.length - toPost.length} drafts outside; ${supCodes.length} suppliers moved by exactly their papers; no bill ticked beyond what it owes${POST_ALL ? '; every tick settled in full' : ''}`);
  out(`left out: ${data.skipped.length} — ${data.skipped.filter((s) => s.why.startsWith('ASK')).length} wait on the owner`);
}

main().catch((e) => { console.error(e); process.exit(1); });
