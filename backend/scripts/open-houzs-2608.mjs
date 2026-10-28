#!/usr/bin/env node
/* open-houzs-2608.mjs — Houzs Century's (company 1) books open on 31/08/2026 from
   AutoCount's own figures (owner 2026-10-06: 「开账放01/09，我过后慢慢补数据」;
   2026-10-28: 「可以先做开31/08的账先，但是要小心supplier part … 不要duplicate
   录入哦」, 「做之前和我再confirm 一次」).

   THE SOURCE is scripts/data/houzs-opening-2608.json, built from his exports:
   the New GL (its B/F column IS the 31/08 trial balance), the Creditor Aging as
   at 31/08 (one row per open bill / unapplied payment / debit note) and the
   Purchase Invoice Listing (AutoCount PI no ↔ the supplier's invoice no).

   WHAT IT WRITES (every document an ordinary one of its kind, so the screens,
   the aging and the self-check read them as they read any other):
     1. a clearing account 190-0000 OPENING BALANCE (AUTOCOUNT 31/08), and any
        account the trial balance names that the chart lacks;
     2. the suppliers and other debtors the opening names that the ERP lacks
        (AutoCount 400-H004 HAO HUA → 405-H004, owner 2026-10-28);
     3. ONE AP INVOICE per open AutoCount bill on the aging, at its 31/08
        outstanding, dated the bill's own date, Dr 190-0000 / Cr the supplier —
        except a bill the ERP's books already carry at the same amount;
        ONE SUPPLIER CREDIT NOTE per unapplied payment / debit note, Dr the
        supplier / Cr 190-0000; a CNY supplier's lines at the RM the 10-27 aging
        printed, its exchange difference to the GL as one more bill or credit;
     4. ONE OTHER-DEBTOR BILL per other debtor AutoCount says owes (Dr 305 /
        Cr 190-0000); a debtor AutoCount owes sits on the opening journal;
     5. the OPENING journal 'HC-OPENING-2608' on 31/08: every other account to
        its AutoCount balance (the ERP's own balance there subtracted, so nothing
        counts twice), 150-0000 RETAINED EARNING included; 300-C002 CUSTOMER
        folded into 440-0000 DEFERRED REVENUE (owner 10-27), less what the ERP
        already holds for customers (300-0000 per customer, 326-0000 card money)
        so the customers' total is AutoCount's. Stock is the ERP's own (the
        balance sheet reads the stock engine), so AutoCount's 600-0000 is not
        posted. 190-0000 keeps what is left: the opening documents' clearing
        nets to nil and the rest is the ERP's own difference at the cutover —
        its stock, its entries before 01/09, its own bills;
     6. the purchase invoices brought over from AutoCount (migrated, never in
        these books): each one on the aging is REPLACED by its opening bill and
        each one off it was settled in AutoCount — both marked PAID, so no bill
        stays open twice.

   MODE=plan (default): all of it inside one transaction, verified, ROLLED BACK.
   MODE=apply + CONFIRM="OPEN HOUZS 31/08": the same, kept.
   Env: DATABASE_URL, COMPANY_ID (1), DATA, CLOSE_SETTLED (1 = also mark the
   copies AutoCount settled; 0 = only the replaced ones), CONFLICT_OPEN (1 = an
   aging bill the ERP keeps at a different amount under the same supplier
   invoice no gets its opening bill too; 0 = leave it to the ERP's own).
   RE-RUN: refused while an OPENING journal or an opening document stands.
   Bulk SQL, not the handlers: one round trip from the runner is ~0.45 s
   (probe-db-latency.mjs), and ~1,100 documents through the handlers is ~95 min. */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'OPEN HOUZS 31/08';
const CO = Number(process.env.COMPANY_ID || 1);
const DATA = process.env.DATA || fileURLToPath(new URL('./data/houzs-opening-2608.json', import.meta.url));
const CLOSE_SETTLED = process.env.CLOSE_SETTLED !== '0';
const CONFLICT_OPEN = process.env.CONFLICT_OPEN !== '0';
const ACTOR = 'Opening import (AutoCount 31/08)';
const TAG = 'Opening 31/08 from AutoCount';
const TB_DOC = 'HC-OPENING-2608';
const CLEARING = { code: '190-0000', name: 'OPENING BALANCE (AUTOCOUNT 31/08)', type: 'EQUITY', section: 'RETAINED EARNING' };
const RE = '150-0000';
const DEFERRED = '440-0000';
const CUSTOMER_AC = '300-C002';
const STOCK_AC = '600-0000';
const TRANSIT = '326-0000';
const PARTY_AC = /^(300|305|400|405)-/;
const INT_MAX = 2147483647;

const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const yymm = (d) => `${d.slice(2, 4)}${d.slice(5, 7)}`;
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
class Rollback extends Error {}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`MODE=apply needs CONFIRM="${PHRASE}".`); process.exit(2); }
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  const CUTOFF = data.cutoff;
  out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}, company ${CO}, cutoff ${CUTOFF}, close settled copies ${CLOSE_SETTLED}, conflict bills opened ${CONFLICT_OPEN}`);
  out(`sources: ${data.sources.join(' | ')}`);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin(async (tx) => {
      await run(tx, data, CUTOFF);
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

async function run(tx, data, CUTOFF) {
  const report = [];
  const say = (s) => { report.push(s); out(s); };

  /* ── 0. refuse a second opening ─────────────────────────────────────────── */
  const prior = await tx`SELECT je_no FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'OPENING' AND posted AND NOT reversed LIMIT 1`;
  if (prior.length) throw new Error(`an OPENING journal already stands (${prior[0].je_no}) — reverse it first`);
  const priorDocs = await tx`SELECT
      (SELECT count(*) FROM scm.ap_invoices WHERE company_id = ${CO} AND created_by = ${ACTOR} AND status <> 'CANCELLED')::int AS api,
      (SELECT count(*) FROM scm.acc_credit_notes WHERE company_id = ${CO} AND created_by = ${ACTOR} AND status <> 'CANCELLED')::int AS scn`;
  if (priorDocs[0].api || priorDocs[0].scn) throw new Error(`opening documents already stand (${priorDocs[0].api} AP invoices, ${priorDocs[0].scn} credit notes)`);

  /* ── 1. the ERP as it is ────────────────────────────────────────────────── */
  const co = await tx`SELECT code FROM public.companies WHERE id = ${CO}`;
  if (co[0]?.code !== 'HOUZS') throw new Error(`company ${CO} is ${co[0]?.code}, not HOUZS`);
  const DOC = 'HC-'; // docPrefixForCode('HOUZS'); HOUZS journals are bare (jePrefixForCode)
  const roleRows = await tx`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${CO}`;
  const role = { AR: '300-0000', AR_OTHER: '305-0000', AP: '400-0000', AP_OTHER: '405-0000', ...Object.fromEntries(roleRows.map((r) => [r.role, r.account_code])) };
  const apControl = (code) => (String(code).startsWith('405-') ? role.AP_OTHER : role.AP);
  const chart = await tx`SELECT account_code, account_name, account_type, parent_code, is_active, section FROM scm.accounts WHERE company_id = ${CO}`;
  const chartBy = new Map(chart.map((a) => [a.account_code, a]));
  const parents = new Set(chart.map((a) => a.parent_code).filter(Boolean));
  const sups = await tx`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO}`;
  const supBy = new Map(sups.map((s) => [s.code, s]));
  const debtors = await tx`SELECT id, name FROM scm.acc_debtors WHERE company_id = ${CO}`;
  const debtorBy = new Map(debtors.map((d) => [d.name, d]));
  const bal = await tx`SELECT l.account_code AS code, sum(l.debit_sen - l.credit_sen)::bigint AS bal
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date <= ${CUTOFF}
      GROUP BY 1`;
  const erpBal = new Map(bal.map((r) => [r.code, Number(r.bal)]));
  const apParty = await tx`SELECT l.party_code AS code, sum(l.credit_sen - l.debit_sen)::bigint AS owed
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date <= ${CUTOFF}
        AND l.account_code IN (${role.AP}, ${role.AP_OTHER}) GROUP BY 1`;
  const erpOwed = new Map(apParty.map((r) => [r.code, Number(r.owed)]));
  /* Every brought-over copy dated by the cutoff, and any copy the aging names whatever its date. */
  const agingCopies = [...new Set(data.aging.map((a) => a.erpCopy).filter(Boolean))];
  const migrated = await tx`SELECT id, invoice_number, linked_ac_docno, total_sen, paid_sen, status::text AS status, invoice_date::text AS date
      FROM scm.purchase_invoices WHERE company_id = ${CO} AND migrated_no_stock AND status::text <> 'CANCELLED'
        AND (invoice_date <= ${CUTOFF} OR invoice_number = ANY(${agingCopies}::text[]))`;
  /* The ERP's own in-book bills dated by the cutoff: kept as they stand. */
  const inBook = await tx`SELECT 'PI' AS k, p.invoice_number AS no, s.code AS supplier, p.total_sen, p.paid_sen, p.invoice_date::text AS date, p.supplier_invoice_ref AS ref
      FROM scm.purchase_invoices p JOIN scm.suppliers s ON s.id = p.supplier_id
      WHERE p.company_id = ${CO} AND NOT coalesce(p.migrated_no_stock, false) AND p.status::text NOT IN ('CANCELLED', 'DRAFT') AND p.invoice_date <= ${CUTOFF}
    UNION ALL
    SELECT 'API', a.invoice_number, s.code, a.total_sen, a.paid_sen, a.invoice_date::text, a.supplier_invoice_ref
      FROM scm.ap_invoices a JOIN scm.suppliers s ON s.id = a.supplier_id
      WHERE a.company_id = ${CO} AND a.status NOT IN ('CANCELLED', 'DRAFT') AND a.invoice_date <= ${CUTOFF}`;
  const piJe = await tx`SELECT source_doc_no AS no, total_debit_sen AS myr FROM scm.journal_entries
      WHERE company_id = ${CO} AND source_type IN ('PI', 'API') AND posted AND NOT reversed AND reversed_by_je IS NULL AND entry_date <= ${CUTOFF}`;
  const inBookMyr = new Map(piJe.map((r) => [r.no, Number(r.myr)]));
  say(`ERP now: ${sups.length} suppliers, ${debtors.length} other debtors, ${migrated.length} migrated purchase invoices dated by ${CUTOFF}, ${inBook.length} in-book bills dated by ${CUTOFF}`);

  /* ── 2. what the opening adds ───────────────────────────────────────────── */
  const newAccounts = [];
  if (!chartBy.has(CLEARING.code)) newAccounts.push({ company_id: CO, account_code: CLEARING.code, account_name: CLEARING.name, account_type: CLEARING.type, parent_code: null, is_active: true, section: CLEARING.section });
  for (const t of data.tb) {
    if (PARTY_AC.test(t.code) || t.code === STOCK_AC || chartBy.has(t.code)) continue;
    /* placed beside its nearest leaf sibling: same type, section and header */
    const sib = chart.filter((a) => a.account_code.slice(0, 3) === t.code.slice(0, 3) && !parents.has(a.account_code)).sort((a, b) => b.account_code.localeCompare(a.account_code))[0];
    if (!sib) throw new Error(`no sibling to place ${t.code} ${t.name} in the chart`);
    newAccounts.push({ company_id: CO, account_code: t.code, account_name: t.name, account_type: sib.account_type, parent_code: sib.parent_code ?? null, is_active: true, section: sib.section });
  }
  for (const t of data.tb) {
    if (PARTY_AC.test(t.code) || t.code === STOCK_AC) continue;
    if (parents.has(t.code)) throw new Error(`${t.code} is a parent header in the ERP chart — the opening cannot post to it`);
    const a = chartBy.get(t.code);
    if (a && a.is_active === false) throw new Error(`${t.code} is deactivated in the ERP chart`);
  }
  const newSuppliers = data.newSuppliers.filter((s) => !supBy.has(s.code));
  const newDebtors = data.otherDebtors.filter((d) => !debtorBy.has(d.erpName)).map((d) => ({ company_id: CO, name: d.erpName, notes: `${TAG}: AutoCount ${d.acCode} ${d.acName}`, created_by: ACTOR }));

  /* Bills and credits from the aging, by sign: owed → AP invoice; owed back → credit note. */
  const bills = [], credits = [];
  const skipped = [], conflicts = [];
  for (const a of data.aging) {
    if (a.skipInBooks) { skipped.push(a); continue; }
    if (a.conflictErp) { conflicts.push(a); if (!CONFLICT_OPEN) continue; }
    const fc = a.fcSen != null ? ` (CNY ${rm(a.fcSen)})` : '';
    const what = a.type === 'IN' ? `AutoCount ${a.acDoc ?? ''}` : a.type === 'PV' ? `AutoCount payment not knocked off ${a.ref}` : `AutoCount debit note ${a.ref}`;
    const row = { code: a.code, date: a.date, ref: a.type === 'IN' ? (a.ref || null) : null, amt: Math.abs(a.myrSen),
      note: `${TAG}: ${what}${a.type === 'IN' && a.ref ? ` — supplier invoice ${a.ref}` : ''}${fc}${a.acDesc ? ` — ${a.acDesc}` : ''}`, copy: a.erpCopy, acDoc: a.acDoc };
    if (a.myrSen > 0) bills.push(row); else if (a.myrSen < 0) credits.push(row);
  }
  /* Each supplier's opening must come to its AutoCount GL balance: the aging's
     lines + what the ERP's books already carry for the skipped bills. Only a CNY
     supplier may differ (the exchange difference); anything else stops the run. */
  const owedByCode = new Map();
  const addOwed = (c, v) => owedByCode.set(c, (owedByCode.get(c) ?? 0) + v);
  for (const b of bills) addOwed(b.code, b.amt);
  for (const c of credits) addOwed(c.code, -c.amt);
  for (const a of skipped) addOwed(a.code, inBookMyr.get(a.skipInBooks) ?? 0);
  const cnySuppliers = new Set(data.aging.filter((a) => a.cur !== 'MYR').map((a) => a.code));
  const fxRows = [];
  for (const [code, owed] of Object.entries(data.creditorOwed)) {
    const diff = owed - (owedByCode.get(code) ?? 0);
    if (diff === 0) continue;
    const isConflictSupplier = conflicts.some((c) => c.code === code);
    if (!cnySuppliers.has(code) && !isConflictSupplier) throw new Error(`supplier ${code}: AutoCount GL owes ${rm(owed)} but its aging lines come to ${rm(owedByCode.get(code) ?? 0)}`);
    if (!cnySuppliers.has(code)) { say(`! ${code}: aging vs GL differ by RM ${rm(diff)} (the conflict bill)`); continue; }
    const r = { code, date: CUTOFF, ref: null, amt: Math.abs(diff), note: `${TAG}: exchange difference to the AutoCount GL balance at 31/08 (CNY supplier)`, copy: null, acDoc: null };
    (diff > 0 ? bills : credits).push(r);
    fxRows.push(`${code} ${diff > 0 ? 'bill' : 'credit'} RM ${rm(Math.abs(diff))}`);
  }

  /* Other debtors: owed → a bill; owed back → a line on the opening journal. */
  const debtorBills = data.otherDebtors.filter((d) => d.sen > 0);
  const debtorCredits = data.otherDebtors.filter((d) => d.sen < 0);

  /* ── 3. numbers: claim each series' block once ──────────────────────────── */
  const floorsOf = async (table, col, like) => new Map((await tx.unsafe(
    `SELECT substring(${col} from '^(.*)-[0-9]+$') AS series, max(substring(${col} from '-([0-9]+)$')::int) AS n
       FROM scm.${table} WHERE company_id = $1 AND ${col} LIKE $2 GROUP BY 1`, [CO, like])).map((r) => [r.series, Number(r.n)]));
  const apiFloor = await floorsOf('ap_invoices', 'invoice_number', `${DOC}API-%`);
  const scnFloor = await floorsOf('acc_credit_notes', 'note_number', `${DOC}SCN-%`);
  const odbFloor = await floorsOf('acc_debtor_bills', 'bill_number', `${DOC}ODB-%`);
  const jeFloor = await floorsOf('journal_entries', 'je_no', 'JE-%');
  const claim = async (series, floor, n) => {
    const r = await tx`INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source)
        VALUES (${series}, ${floor + 1 + n}, ${`self-seeded by the 31/08 opening import from the live max (${floor})`})
        ON CONFLICT (series) DO UPDATE SET next_n = GREATEST(c.next_n, ${floor + 1}) + ${n}, updated_at = now()
        RETURNING next_n - ${n} AS first`;
    return Number(r[0].first);
  };
  const numberAll = async (rows, seriesOf, floors, pad) => {
    const bySeries = new Map();
    for (const r of rows) { const s = seriesOf(r); if (!bySeries.has(s)) bySeries.set(s, []); bySeries.get(s).push(r); }
    for (const [s, rs] of [...bySeries].sort()) {
      rs.sort((a, b) => a.date.localeCompare(b.date) || String(a.ref ?? '').localeCompare(String(b.ref ?? '')));
      const first = await claim(s, floors.get(s) ?? 0, rs.length);
      rs.forEach((r, i) => { r.no = `${s}-${String(first + i).padStart(pad, '0')}`; });
    }
    return bySeries.size;
  };
  await numberAll(bills, (r) => `${DOC}API-${yymm(r.date)}`, apiFloor, 3);
  await numberAll(credits, (r) => `${DOC}SCN-${yymm(r.date)}`, scnFloor, 3);
  const odbRows = debtorBills.map((d) => ({ ...d, date: CUTOFF, ref: d.acCode }));
  await numberAll(odbRows, (r) => `${DOC}ODB-${yymm(r.date)}`, odbFloor, 3);

  /* ── 4. write the masters ───────────────────────────────────────────────── */
  if (newAccounts.length) await tx`INSERT INTO scm.accounts ${tx(newAccounts)}`;
  const supRows = newSuppliers.map((s) => ({ company_id: CO, code: s.code, name: s.name, currency: s.currency || 'MYR', for_purchasing: false }));
  if (supRows.length) for (const s of await tx`INSERT INTO scm.suppliers ${tx(supRows)} RETURNING id, code, name`) supBy.set(s.code, s);
  if (newDebtors.length) for (const d of await tx`INSERT INTO scm.acc_debtors ${tx(newDebtors)} RETURNING id, name`) debtorBy.set(d.name, d);
  for (const r of [...bills, ...credits]) if (!supBy.has(r.code)) throw new Error(`supplier ${r.code} missing after the master writes`);

  /* ── 5. the documents ───────────────────────────────────────────────────── */
  const nowIso = new Date().toISOString();
  const apiIds = new Map();
  for (const part of chunk(bills, 800)) {
    const rows = part.map((b) => ({ company_id: CO, invoice_number: b.no, supplier_id: supBy.get(b.code).id, supplier_invoice_ref: b.ref, invoice_date: b.date,
      currency: 'MYR', exchange_rate: 1, total_sen: b.amt, paid_sen: 0, status: 'POSTED', notes: b.note, created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR }));
    for (const r of await tx`INSERT INTO scm.ap_invoices ${tx(rows)} RETURNING id, invoice_number`) apiIds.set(r.invoice_number, r.id);
  }
  for (const part of chunk(bills, 1500)) {
    await tx`INSERT INTO scm.ap_invoice_lines ${tx(part.map((b) => ({ company_id: CO, invoice_id: apiIds.get(b.no), line_no: 1, description: b.note.slice(0, 500), debit_account_code: CLEARING.code, amount_sen: b.amt })))}`;
  }
  const scnIds = new Map();
  for (const part of chunk(credits, 800)) {
    const rows = part.map((c) => { const s = supBy.get(c.code); return { company_id: CO, note_number: c.no, kind: 'SCN', party_type: 'SUPPLIER', party_code: c.code, party_name: s.name, supplier_id: s.id,
      note_date: c.date, total_sen: c.amt, reason: c.note.slice(0, 300), notes: c.note, status: 'POSTED', created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR }; });
    for (const r of await tx`INSERT INTO scm.acc_credit_notes ${tx(rows)} RETURNING id, note_number`) scnIds.set(r.note_number, r.id);
  }
  for (const part of chunk(credits, 1500)) {
    await tx`INSERT INTO scm.acc_credit_note_lines ${tx(part.map((c) => ({ company_id: CO, note_id: scnIds.get(c.no), line_no: 1, description: c.note.slice(0, 500), account_code: CLEARING.code, amount_sen: c.amt })))}`;
  }
  const odbIds = new Map();
  if (odbRows.length) {
    const rows = odbRows.map((d) => ({ company_id: CO, bill_number: d.no, debtor_id: debtorBy.get(d.erpName).id, bill_date: d.date, total_sen: d.sen, received_sen: 0, status: 'POSTED', notes: `${TAG}: AutoCount ${d.acCode} ${d.acName}`, created_by: ACTOR }));
    for (const r of await tx`INSERT INTO scm.acc_debtor_bills ${tx(rows)} RETURNING id, bill_number`) odbIds.set(r.bill_number, r.id);
    await tx`INSERT INTO scm.acc_debtor_bill_lines ${tx(odbRows.map((d) => ({ company_id: CO, bill_id: odbIds.get(d.no), line_no: 1, description: `${TAG}: AutoCount ${d.acCode}`, credit_account_code: CLEARING.code, amount_sen: d.sen })))}`;
  }

  /* ── 6. the journals ────────────────────────────────────────────────────── */
  const jes = [];
  const supName = (code) => supBy.get(code).name;
  for (const b of bills) jes.push({ source: 'API', doc: b.no, date: b.date, narration: `AP invoice ${b.no} — ${supName(b.code)}${b.ref ? ` (${b.ref})` : ''} — ${TAG}`,
    lines: [{ a: CLEARING.code, dr: b.amt, cr: 0, notes: b.note.slice(0, 300) }, { a: apControl(b.code), dr: 0, cr: b.amt, pt: 'SUPPLIER', pc: b.code, pn: supName(b.code), notes: `AP invoice ${b.no}` }] });
  for (const c of credits) jes.push({ source: 'SCN', doc: c.no, date: c.date, narration: `Supplier credit note ${c.no} — ${supName(c.code)} — ${TAG}`,
    lines: [{ a: apControl(c.code), dr: c.amt, cr: 0, pt: 'SUPPLIER', pc: c.code, pn: supName(c.code), notes: `Supplier credit note ${c.no}` }, { a: CLEARING.code, dr: 0, cr: c.amt, notes: c.note.slice(0, 300) }] });
  for (const d of odbRows) jes.push({ source: 'ODB', doc: d.no, date: d.date, narration: `Other debtor bill ${d.no} — ${d.erpName} — ${TAG}`,
    lines: [{ a: role.AR_OTHER, dr: d.sen, cr: 0, pt: 'ODEBTOR', pn: d.erpName, notes: `Other debtor ${d.erpName} — ${d.no}` }, { a: CLEARING.code, dr: 0, cr: d.sen, notes: `${TAG}: AutoCount ${d.acCode}` }] });

  /* The opening journal: every other account to its AutoCount balance. */
  const tbLines = [];
  const acBf = new Map(data.tb.map((t) => [t.code, t.bfSen]));
  const target = new Map();
  for (const t of data.tb) {
    if (PARTY_AC.test(t.code) || t.code === STOCK_AC) continue;
    target.set(t.code, t.bfSen);
  }
  /* 300-C002 folds into deferred revenue; what the ERP holds for customers stays. */
  const deferredTarget = (acBf.get(DEFERRED) ?? 0) + (acBf.get(CUSTOMER_AC) ?? 0) - (erpBal.get(role.AR) ?? 0) - (erpBal.get(TRANSIT) ?? 0);
  target.set(DEFERRED, deferredTarget);
  for (const [code, t] of target) {
    const line = t - (erpBal.get(code) ?? 0);
    if (line !== 0) tbLines.push({ a: code, dr: Math.max(line, 0), cr: Math.max(-line, 0), notes: `${TAG}: AutoCount ${rm(acBf.get(code) ?? 0)}${code === DEFERRED ? ' + 300-C002 CUSTOMER, less the ERP\'s own customer balances' : ''}` });
  }
  for (const d of debtorCredits) tbLines.push({ a: role.AR_OTHER, dr: 0, cr: -d.sen, pt: 'ODEBTOR', pn: d.erpName, notes: `${TAG}: AutoCount ${d.acCode} ${d.acName}` });
  /* 190-0000 takes what is left: the opening documents' clearing comes back to
     nil, and what remains is the ERP's own difference at the cutover — its stock
     valuation, its own entries before 01/09 (the July/August stock close above
     all), its own bills — so 150-0000 RETAINED EARNING reads AutoCount's. */
  /* The journal balances itself on 190-0000; with the documents' own 190 lines that
     leaves 190 holding exactly the ERP's difference at the cutover. */
  const tbNet = tbLines.reduce((s, l) => s + l.dr - l.cr, 0);
  if (tbNet !== 0) tbLines.push({ a: CLEARING.code, dr: Math.max(-tbNet, 0), cr: Math.max(tbNet, 0), notes: `${TAG}: the opening documents back to nil; the rest is the ERP's own difference at the cutover (its stock, its entries before 01/09, its own bills)` });
  jes.push({ source: 'OPENING', doc: TB_DOC, date: CUTOFF, narration: `Opening balances at 31/08/2026 from AutoCount (trial balance B/F; creditors by the aging) — ${TAG}`, lines: tbLines });

  for (const j of jes) {
    j.dr = j.lines.reduce((s, l) => s + l.dr, 0); j.cr = j.lines.reduce((s, l) => s + l.cr, 0);
    if (j.dr !== j.cr) throw new Error(`${j.source} ${j.doc} unbalanced ${j.dr} / ${j.cr}`);
    if (j.dr > INT_MAX) throw new Error(`${j.source} ${j.doc} total ${j.dr} exceeds the integer column`);
    for (const l of j.lines) if (l.dr > INT_MAX || l.cr > INT_MAX || (l.dr > 0 && l.cr > 0) || l.dr < 0 || l.cr < 0) throw new Error(`${j.doc} bad line ${JSON.stringify(l)}`);
  }
  await numberAll(jes, (j) => `JE-${yymm(j.date)}`, jeFloor, 4);
  const jeIds = new Map();
  for (const part of chunk(jes, 800)) {
    const rows = part.map((j) => ({ company_id: CO, je_no: j.no, entry_date: j.date, source_type: j.source, source_doc_no: j.doc, narration: j.narration, total_debit_sen: j.dr, total_credit_sen: j.cr, posted: false }));
    for (const r of await tx`INSERT INTO scm.journal_entries ${tx(rows)} RETURNING id, je_no`) jeIds.set(r.je_no, r.id);
  }
  const lineRows = jes.flatMap((j) => j.lines.map((l, i) => ({ company_id: CO, journal_entry_id: jeIds.get(j.no), line_no: i + 1, account_code: l.a,
    debit_sen: l.dr, credit_sen: l.cr, party_type: l.pt ?? null, party_code: l.pc ?? null, party_name: l.pn ?? null, notes: l.notes ?? null })));
  for (const part of chunk(lineRows, 1500)) await tx`INSERT INTO scm.journal_entry_lines ${tx(part)}`;
  for (const part of chunk([...jeIds.values()], 1000)) await tx`UPDATE scm.journal_entries SET posted = true, posted_at = now() WHERE id = ANY(${part}::uuid[])`;
  const scnJe = jes.filter((j) => j.source === 'SCN');
  for (const part of chunk(scnJe, 1000)) {
    await tx`UPDATE scm.acc_credit_notes n SET je_no = v.je_no FROM (SELECT unnest(${part.map((j) => j.doc)}::text[]) AS note_number, unnest(${part.map((j) => j.no)}::text[]) AS je_no) v
      WHERE n.company_id = ${CO} AND n.note_number = v.note_number`;
  }

  /* ── 7. the brought-over purchase invoices: none stays open ─────────────── */
  const replacedBy = new Map(bills.filter((b) => b.copy).map((b) => [b.copy, b]));
  const closing = migrated.filter((m) => m.total_sen > m.paid_sen || m.status !== 'PAID')
    .map((m) => { const b = replacedBy.get(m.invoice_number); return b ? { m, note: `Replaced by opening bill ${b.no} (${TAG}, AutoCount ${b.acDoc})` } : CLOSE_SETTLED ? { m, note: `Settled in AutoCount by 31/08 — not on its creditor aging (${TAG})` } : null; })
    .filter(Boolean);
  for (const part of chunk(closing, 1000)) {
    await tx`UPDATE scm.purchase_invoices p SET paid_sen = p.total_sen, status = 'PAID', updated_at = now(),
        notes = concat_ws(E'\n', nullif(p.notes, ''), v.note)
      FROM (SELECT unnest(${part.map((c) => c.m.id)}::uuid[]) AS id, unnest(${part.map((c) => c.note)}::text[]) AS note) v
      WHERE p.id = v.id AND p.company_id = ${CO}`;
    await tx`INSERT INTO scm.entity_audit_log ${tx(part.map((c) => ({ company_id: CO, entity_type: 'PURCHASE_INVOICE', entity_id: String(c.m.id), entity_doc_no: c.m.invoice_number, action: 'UPDATE',
      actor_name_snapshot: ACTOR, field_changes: tx.json([{ field: 'paidSen', from: Number(c.m.paid_sen), to: Number(c.m.total_sen) }, { field: 'status', from: c.m.status, to: 'PAID' }]),
      status_snapshot: 'PAID', source: 'script', note: c.note })))}`;
  }

  /* ── 8. verify, inside the transaction ──────────────────────────────────── */
  const after = new Map((await tx`SELECT l.account_code AS code, sum(l.debit_sen - l.credit_sen)::bigint AS bal
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date <= ${CUTOFF}
      GROUP BY 1`).map((r) => [r.code, Number(r.bal)]));
  const tbTotal = [...after.values()].reduce((s, v) => s + v, 0);
  const bad = [];
  for (const [code, t] of target) if ((after.get(code) ?? 0) !== t) bad.push(`${code} is ${rm(after.get(code) ?? 0)}, want ${rm(t)}`);
  if (tbTotal !== 0) bad.push(`the books do not balance at ${CUTOFF}: ${rm(tbTotal)}`);
  const owedAfter = new Map((await tx`SELECT l.party_code AS code, sum(l.credit_sen - l.debit_sen)::bigint AS owed
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date <= ${CUTOFF}
        AND l.account_code IN (${role.AP}, ${role.AP_OTHER}) GROUP BY 1`).map((r) => [r.code, Number(r.owed)]));
  const supplierLines = [];
  for (const code of new Set([...Object.keys(data.creditorOwed), ...owedAfter.keys()])) {
    if (!code) continue;
    const want = data.creditorOwed[code] ?? 0;
    const got = owedAfter.get(code) ?? 0;
    const erpOnly = inBook.filter((b) => b.supplier === code && !skipped.some((s) => s.skipInBooks === b.no) && !conflicts.some((c) => c.conflictErp === b.no))
      .reduce((s, b) => s + (inBookMyr.get(b.no) ?? 0), 0);
    const conflictErp = conflicts.filter((c) => c.code === code).reduce((s, c) => s + (inBookMyr.get(c.conflictErp) ?? 0), 0);
    if (got !== want + erpOnly + conflictErp) bad.push(`supplier ${code} owed ${rm(got)}, want AutoCount ${rm(want)} + ERP-only ${rm(erpOnly)} + conflict ${rm(conflictErp)}`);
    if (erpOnly || conflictErp) supplierLines.push(`${code}: AutoCount ${rm(want)}, ERP's own bills on top ${rm(erpOnly + conflictErp)} → ${rm(got)}`);
  }
  const odAfter = new Map((await tx`SELECT l.party_name AS name, sum(l.debit_sen - l.credit_sen)::bigint AS bal
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date <= ${CUTOFF}
        AND l.account_code = ${role.AR_OTHER} GROUP BY 1`).map((r) => [r.name, Number(r.bal)]));
  for (const d of data.otherDebtors) if ((odAfter.get(d.erpName) ?? 0) !== d.sen) bad.push(`other debtor ${d.erpName} is ${rm(odAfter.get(d.erpName) ?? 0)}, want ${rm(d.sen)}`);
  const closedSet = new Set(closing.map((c) => c.m.invoice_number));
  for (const b of bills.filter((x) => x.copy && !closedSet.has(x.copy))) { const m = migrated.find((x) => x.invoice_number === b.copy); say(`! copy ${b.copy} (AutoCount ${b.acDoc}) on the aging is not being closed: ${m ? `${m.status}, paid ${rm(m.paid_sen)} of ${rm(m.total_sen)}, dated ${m.date}` : 'not found (cancelled?)'}`); }
  const stillOpen = await tx`SELECT count(*)::int AS n FROM scm.purchase_invoices WHERE company_id = ${CO} AND migrated_no_stock AND status::text NOT IN ('CANCELLED', 'PAID') AND invoice_date <= ${CUTOFF}`;

  /* ── 9. the report ──────────────────────────────────────────────────────── */
  const sum = (xs) => xs.reduce((s, x) => s + x.amt, 0);
  say(`new accounts: ${newAccounts.map((a) => `${a.account_code} ${a.account_name}`).join('; ') || 'none'}`);
  say(`new suppliers: ${supRows.map((s) => `${s.code} ${s.name}`).join('; ') || 'none'}`);
  say(`new other debtors: ${newDebtors.map((d) => d.name).join('; ') || 'none'}`);
  say(`opening AP invoices: ${bills.length} RM ${rm(sum(bills))} (${bills[0]?.no ?? '-'} … ; ${bills.filter((b) => b.copy).length} replace a brought-over copy)`);
  say(`opening supplier credit notes: ${credits.length} RM ${rm(sum(credits))}`);
  say(`exchange differences: ${fxRows.join('; ') || 'none'}`);
  say(`other debtor bills: ${odbRows.length} RM ${rm(odbRows.reduce((s, d) => s + d.sen, 0))}; owed back on the journal: ${debtorCredits.map((d) => `${d.erpName} RM ${rm(-d.sen)}`).join('; ') || 'none'}`);
  say(`kept, already in the books at the same amount: ${skipped.map((s) => `${s.skipInBooks} (AutoCount ${s.acDoc})`).join('; ') || 'none'}`);
  say(`CONFLICT — the ERP keeps another amount under the same supplier invoice: ${conflicts.map((c) => `${c.conflictErp} ERP RM ${rm(inBookMyr.get(c.conflictErp) ?? 0)} vs AutoCount ${c.acDoc} RM ${rm(c.myrSen)} (${c.code} ${c.ref})`).join('; ') || 'none'}`);
  const own = inBook.filter((b) => !skipped.some((s) => s.skipInBooks === b.no) && !conflicts.some((c) => c.conflictErp === b.no));
  say(`ERP's own bills in its books at 31/08 that AutoCount does not have on its aging (kept as owed): ${own.filter((b) => inBookMyr.has(b.no)).map((b) => `${b.no} ${b.supplier} RM ${rm(inBookMyr.get(b.no))}${b.ref ? ` (${b.ref})` : ''}`).join('; ') || 'none'}`);
  say(`ERP bills dated by 31/08 but booked after it (not part of the opening): ${own.filter((b) => !inBookMyr.has(b.no)).map((b) => `${b.no} ${b.supplier} RM ${rm(b.total_sen)} dated ${b.date}${b.ref ? ` (${b.ref})` : ''}`).join('; ') || 'none'}`);
  for (const l of supplierLines) say(`  ${l}`);
  say(`brought-over purchase invoices marked PAID: ${closing.length} (${closing.filter((c) => c.note.startsWith('Replaced')).length} replaced by an opening bill, ${closing.filter((c) => c.note.startsWith('Settled')).length} settled in AutoCount); still open after: ${stillOpen[0].n}`);
  say(`journals: ${jes.length} (${jes.filter((j) => j.source === 'API').length} API, ${jes.filter((j) => j.source === 'SCN').length} SCN, ${jes.filter((j) => j.source === 'ODB').length} ODB, 1 OPENING ${jes.at(-1).no} with ${tbLines.length} lines RM ${rm(jes.at(-1).dr)})`);
  say('opening journal lines:');
  for (const l of tbLines) say(`  ${l.a} ${(chartBy.get(l.a)?.account_name ?? newAccounts.find((a) => a.account_code === l.a)?.account_name ?? '').slice(0, 36).padEnd(36)} ${l.dr ? 'Dr ' + rm(l.dr) : 'Cr ' + rm(l.cr)}${l.pn ? ' — ' + l.pn : ''} | ERP before ${rm(erpBal.get(l.a) ?? 0)} → after ${rm(after.get(l.a) ?? 0)}`);
  say(`stock: the ERP's own 330 at 31/08 = RM ${rm([...after].filter(([c]) => c.startsWith('330-')).reduce((s, [, v]) => s + v, 0))}; AutoCount 600-0000 RM ${rm(acBf.get(STOCK_AC) ?? 0)} not posted`);
  say(`deferred revenue 440-0000 after: RM ${rm(after.get(DEFERRED) ?? 0)} (AutoCount 440 ${rm(acBf.get(DEFERRED) ?? 0)} + 300-C002 ${rm(acBf.get(CUSTOMER_AC) ?? 0)}; ERP keeps 300-0000 ${rm(erpBal.get(role.AR) ?? 0)} and 326-0000 ${rm(erpBal.get(TRANSIT) ?? 0)})`);
  say(`retained earnings 150-0000 after: RM ${rm(after.get(RE) ?? 0)} (AutoCount ${rm(acBf.get(RE) ?? 0)}); 190-0000 after: RM ${rm(after.get(CLEARING.code) ?? 0)} = the ERP's own difference at the cutover`);
  const pnlBefore = [...erpBal].filter(([c]) => /^[5-9]/.test(c)).reduce((s, [, v]) => s + v, 0);
  say(`  of which: the ERP's own profit & loss before 01/09 RM ${rm(pnlBefore)} (Dr+ / Cr−; stock close included), stock 330 RM ${rm([...after].filter(([c]) => c.startsWith('330-')).reduce((s, [, v]) => s + v, 0))} vs AutoCount ${rm(acBf.get(STOCK_AC) ?? 0)}`);
  for (const b of bills) console.log(`DOC|${JSON.stringify({ k: 'API', no: b.no, code: b.code, name: supBy.get(b.code).name, date: b.date, ref: b.ref, sen: b.amt, ac: b.acDoc, copy: b.copy, note: b.note })}`);
  for (const c of credits) console.log(`DOC|${JSON.stringify({ k: 'SCN', no: c.no, code: c.code, name: supBy.get(c.code).name, date: c.date, ref: c.ref, sen: c.amt, note: c.note })}`);
  for (const d of odbRows) console.log(`DOC|${JSON.stringify({ k: 'ODB', no: d.no, name: d.erpName, date: d.date, sen: d.sen, ac: d.acCode })}`);
  for (const l of tbLines) console.log(`TB|${JSON.stringify({ a: l.a, name: chartBy.get(l.a)?.account_name ?? newAccounts.find((x) => x.account_code === l.a)?.account_name ?? '', dr: l.dr, cr: l.cr, pn: l.pn ?? null, before: erpBal.get(l.a) ?? 0, after: after.get(l.a) ?? 0, ac: acBf.get(l.a) ?? null })}`);
  for (const c of closing) console.log(`COPY|${JSON.stringify({ no: c.m.invoice_number, ac: c.m.linked_ac_docno, date: c.m.date, sen: Number(c.m.total_sen), note: c.note })}`);
  for (const code of new Set([...Object.keys(data.creditorOwed), ...owedAfter.keys()])) if (code) console.log(`SUP|${JSON.stringify({ code, name: supBy.get(code)?.name ?? '', ac: data.creditorOwed[code] ?? 0, before: erpOwed.get(code) ?? 0, after: owedAfter.get(code) ?? 0, bills: bills.filter((b) => b.code === code).length, billSen: bills.filter((b) => b.code === code).reduce((s, b) => s + b.amt, 0), credits: credits.filter((c) => c.code === code).length, creditSen: credits.filter((c) => c.code === code).reduce((s, c) => s + c.amt, 0) })}`);
  say(bad.length ? `VERIFY FAILED (${bad.length}):` : 'VERIFY: every account at its target (150-0000 = AutoCount), books balanced, every supplier and other debtor at AutoCount (+ the ERP\'s own bills listed above).');
  for (const b of bad.slice(0, 60)) say(`  ✗ ${b}`);
  if (bad.length) throw new Error(`verification failed — ${bad.length} difference(s); nothing kept`);
  return report;
}

main().catch((e) => { console.error(e); process.exit(1); });
