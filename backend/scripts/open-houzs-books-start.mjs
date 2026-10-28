#!/usr/bin/env node
/* open-houzs-books-start.mjs — Houzs Century's (company 1) books start in the ERP
   on 01/09/2026 and open on AutoCount's 31/08 balances (owner 2026-10-28:
   「我在31/08 都在auto count做，31/08 之前我都是soft launch 的。我会在01/09/2026
   当做正式在erp做，所以账的opening也是01/09/2026」; 「1744164.68就当01/09 的opening
   stock，然后每天算closing stock 就可以了」; 「可以，做」 — and 「做之前和我再confirm
   一次」: the plan run of this script is that confirmation).

   NEEDS mig 20261028T2100 (PR #5006): the books-start columns and report views.

   THE SOURCE is scripts/data/houzs-opening-2608.json, built from his exports: the
   New GL (its B/F column IS the 31/08 trial balance), the Creditor Aging as at
   31/08 and the Purchase Invoice Listing (AutoCount PI no ↔ supplier invoice no).

   WHAT IT WRITES, in one transaction:
     1. four ERP supplier codes become AutoCount's (owner 「可以」): BRIGHTSUN
        400-0000 → 400-B006, ECO & GREEN → 405-E002, HOUZS VENTURE → 405-C003,
        HAO HUA SYARIKAT → 405-H004 — the supplier, its journal lines (a 405-x
        code's lines move from 400-0000 to 405-0000, where its papers post now)
        and its supplier credit notes;
     2. what the opening names that the ERP lacks: 190-0000 OPENING BALANCE
        CLEARING (the other side of every opening paper — it comes back to nil),
        any trial-balance account, supplier or other debtor;
     3. the opening papers, each flagged `opening` with its journal: an AP
        invoice per bill on the aging (its own date, its 31/08 outstanding), a
        supplier credit note per credit, a CNY supplier's exchange difference to
        the GL as one more; an other-debtor bill per debtor who owes, an
        other-debtor receipt per debtor who is owed;
     4. the OPENING journal HC-OPENING-2608 on 31/08: every other account at its
        AutoCount B/F — 300-C002 CUSTOMER folded into 440-0000 DEFERRED REVENUE
        (owner 10-27), AutoCount's 600-0000 on STOCKS AT THE BEGINNING by bucket
        (the August close's split), 190-0000 the balance;
     5. the books' start: acc_company_settings.books_start_date 01/09/2026 and
        opening_stock — nothing the ERP dated before 01/09 counts from here;
     6. the ERP's own supplier bills dated by 31/08 (brought-over copies, bills
        keyed here): one on the aging is REPLACED by its opening bill, one off it
        is NOT OWED (owner 「保留这个单但别进我的欠款」) — closed as documents
        (paid = total), kept on file. One whose journal is dated from 01/09 is in
        the books already and is left alone;
     7. payments and credit notes that tick a replaced bill move to its opening
        bill with what they applied — what a posted payment applied beyond what
        AutoCount still owed becomes that payment's advance (owner on Dunlopillo:
        「当预付款，RM14858到时我会自己knock off」). Ticks dated before 01/09 are the
        soft launch and stay; ticks on a not-owed bill are reported, never changed.
   MODE=plan (default): all of it, verified, ROLLED BACK. MODE=apply +
   CONFIRM="OPEN HOUZS 31/08": the same, kept. Refused while an opening stands.
   Bulk SQL, not the handlers: one round trip from the runner is ~0.45 s. */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
const PHRASE = 'OPEN HOUZS 31/08';
const CO = Number(process.env.COMPANY_ID || 1);
const DATA = process.env.DATA || fileURLToPath(new URL('./data/houzs-opening-2608.json', import.meta.url));
const BOOKS_START = '2026-09-01';
const ACTOR = 'Opening import (AutoCount 31/08)';
const TAG = 'Opening 31/08 from AutoCount';
const TB_DOC = 'HC-OPENING-2608';
const CLEARING = { code: '190-0000', name: 'OPENING BALANCE CLEARING', type: 'EQUITY', section: 'RETAINED EARNING' };
const RE = '150-0000';
const DEFERRED = '440-0000';
const CUSTOMER_AC = '300-C002';
const STOCK_AC = '600-0000';
const PARTY_AC = /^(300|305|400|405)-/;
const INT_MAX = 2147483647;
const BUCKETS = ['customer', 'display', 'service', 'showroom', 'others'];
const BUCKET_ROLE = { customer: 'CUSTOMER', display: 'DISPLAY', service: 'SERVICE', showroom: 'SHOWROOM', others: 'OTHERS' };
const BUCKET_DEFAULT = { customer: '0001', display: '0002', service: '0003', showroom: '0004', others: '0005' };
/* Owner 2026-10-28 「可以」: the ERP's code for these four becomes AutoCount's. */
const RECODE = [
  { from: '400-0000', to: '400-B006', like: /BRIGHTSUN/i },
  { from: '5623 8450 2460', to: '405-E002', like: /ECO\s*&\s*GREEN/i },
  { from: '23600599248', to: '405-C003', like: /HOUZS\s+VENTURE/i },
  { from: '511090010014761', to: '405-H004', like: /HAO\s*HUA/i },
];

const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const emit = (kind, o) => console.log(`${kind}|${JSON.stringify(o)}`);
const yymm = (d) => `${d.slice(2, 4)}${d.slice(5, 7)}`;
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const sumOf = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
class Rollback extends Error {}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`MODE=apply needs CONFIRM="${PHRASE}".`); process.exit(2); }
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}, company ${CO}, books start ${BOOKS_START}, opening dated ${data.cutoff}`);
  out(`sources: ${data.sources.join(' | ')}`);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin(async (tx) => {
      await run(tx, data);
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

async function run(tx, data) {
  const CUTOFF = data.cutoff;
  if (CUTOFF !== '2026-08-31') throw new Error(`the data is cut at ${CUTOFF}, not the day before ${BOOKS_START}`);
  const say = out;
  const nowIso = new Date().toISOString();

  /* ── 0. the migration is in, and no opening stands ──────────────────────── */
  const cols = await tx`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'scm'
      AND ((table_name = 'acc_company_settings' AND column_name IN ('books_start_date', 'opening_stock'))
        OR (table_name IN ('journal_entries', 'ap_invoices', 'acc_credit_notes', 'acc_debtor_bills', 'acc_debtor_receipts') AND column_name = 'opening'))`;
  if (cols.length !== 7) throw new Error(`mig 20261028T2100 is not in this database (${cols.length}/7 columns) — deploy PR #5006 first`);
  const co = await tx`SELECT code FROM public.companies WHERE id = ${CO}`;
  if (co[0]?.code !== 'HOUZS') throw new Error(`company ${CO} is ${co[0]?.code}, not HOUZS`);
  const DOC = 'HC-'; // docPrefixForCode('HOUZS'); HOUZS journals are bare JE-YYMM-NNNN
  const settings = await tx`SELECT books_start_date::text AS start FROM scm.acc_company_settings WHERE company_id = ${CO}`;
  if (settings[0]?.start) throw new Error(`the books already start on ${settings[0].start}`);
  const prior = await tx`SELECT
      (SELECT count(*) FROM scm.journal_entries WHERE company_id = ${CO} AND (opening OR source_type = 'OPENING') AND posted AND NOT reversed)::int AS je,
      (SELECT count(*) FROM scm.ap_invoices WHERE company_id = ${CO} AND (opening OR created_by = ${ACTOR}) AND status <> 'CANCELLED')::int AS api,
      (SELECT count(*) FROM scm.acc_credit_notes WHERE company_id = ${CO} AND (opening OR created_by = ${ACTOR}) AND status <> 'CANCELLED')::int AS scn,
      (SELECT count(*) FROM scm.acc_debtor_bills WHERE company_id = ${CO} AND opening AND status <> 'CANCELLED')::int AS odb,
      (SELECT count(*) FROM scm.acc_debtor_receipts WHERE company_id = ${CO} AND opening AND status <> 'CANCELLED')::int AS odr`;
  const p0 = prior[0];
  if (p0.je || p0.api || p0.scn || p0.odb || p0.odr) throw new Error(`an opening already stands (${JSON.stringify(p0)})`);

  /* ── 1. the ERP as it is ────────────────────────────────────────────────── */
  const roleRows = await tx`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${CO}`;
  const role = {
    AR: '300-0000', AR_OTHER: '305-0000', AP: '400-0000', AP_OTHER: '405-0000',
    ...Object.fromEntries(BUCKETS.flatMap((b) => [[`INVENTORY_${BUCKET_ROLE[b]}`, `330-${BUCKET_DEFAULT[b]}`], [`OPENING_STOCK_${BUCKET_ROLE[b]}`, `600-${BUCKET_DEFAULT[b]}`]])),
    ...Object.fromEntries(roleRows.map((r) => [r.role, r.account_code])),
  };
  const apControl = (code) => (String(code).startsWith('405-') ? role.AP_OTHER : role.AP);
  const chart = await tx`SELECT account_code, account_name, account_type, parent_code, is_active, section FROM scm.accounts WHERE company_id = ${CO}`;
  const chartBy = new Map(chart.map((a) => [a.account_code, a]));
  const parents = new Set(chart.map((a) => a.parent_code).filter(Boolean));
  let sups = await tx`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO}`;
  const debtors = await tx`SELECT id, name FROM scm.acc_debtors WHERE company_id = ${CO}`;
  const debtorBy = new Map(debtors.map((d) => [d.name, d]));
  const soft = await tx`SELECT source_type, count(*)::int AS n FROM scm.journal_entries
      WHERE company_id = ${CO} AND posted AND NOT reversed AND reversed_by_je IS NULL AND entry_date < ${BOOKS_START} GROUP BY 1 ORDER BY 2 DESC`;
  say(`ERP now: ${sups.length} suppliers, ${debtors.length} other debtors; soft-launch journals dated before ${BOOKS_START} that the books will stop counting: ${sumOf(soft, (r) => r.n)} (${soft.map((r) => `${r.source_type} ${r.n}`).join(', ')})`);

  /* ── 2. the four supplier codes ─────────────────────────────────────────── */
  const recoded = [];
  for (const r of RECODE) {
    const s = sups.find((x) => String(x.code).trim() === r.from);
    const taken = sups.find((x) => String(x.code).trim() === r.to);
    if (!s) {
      if (taken && r.like.test(taken.name)) { say(`code ${r.to} ${taken.name}: already AutoCount's`); continue; }
      throw new Error(`no supplier with code "${r.from}" to become ${r.to}`);
    }
    if (!r.like.test(s.name)) throw new Error(`supplier "${r.from}" is "${s.name}", not the one to become ${r.to}`);
    if (taken) throw new Error(`${r.to} is already "${taken.name}" — cannot give it to "${s.name}"`);
    const toOther = r.to.startsWith('405-') && !String(s.code).startsWith('405-');
    await tx`UPDATE scm.suppliers SET code = ${r.to}, updated_at = now() WHERE id = ${s.id} AND company_id = ${CO}`;
    const moved = await tx`UPDATE scm.journal_entry_lines
        SET party_code = ${r.to}, account_code = CASE WHEN ${toOther} AND account_code = ${role.AP} THEN ${role.AP_OTHER} ELSE account_code END
      WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${s.code}
      RETURNING account_code`;
    const notes = await tx`UPDATE scm.acc_credit_notes SET party_code = ${r.to}, updated_at = now()
      WHERE company_id = ${CO} AND kind = 'SCN' AND party_code = ${s.code} RETURNING id`;
    const onOther = moved.filter((m) => m.account_code === role.AP_OTHER).length;
    await tx`INSERT INTO scm.entity_audit_log ${tx({ company_id: CO, entity_type: 'SUPPLIER', entity_id: String(s.id), entity_doc_no: r.to, action: 'UPDATE',
      actor_name_snapshot: ACTOR, field_changes: tx.json([{ field: 'code', from: s.code, to: r.to }]), status_snapshot: null, source: 'script',
      note: `${TAG}: the ERP code ${s.code} becomes AutoCount's ${r.to} (owner 2026-10-28) — ${moved.length} journal lines${toOther ? ` (${onOther} now on ${role.AP_OTHER})` : ''}, ${notes.length} credit notes follow` })}`;
    recoded.push({ name: s.name, from: s.code, to: r.to, lines: moved.length, onOther, notes: notes.length });
  }
  /* Any other column that keeps a supplier's code as text: counted, never guessed at. */
  const codeCols = await tx`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'scm'
      AND column_name IN ('party_code', 'supplier_code', 'payee_code', 'creditor_code', 'vendor_code') AND data_type IN ('text', 'character varying')
      AND table_name NOT IN ('journal_entry_lines', 'acc_credit_notes')
      AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'scm' AND table_type = 'BASE TABLE')`;
  const strays = [];
  for (const c of codeCols) {
    for (const r of recoded) {
      const n = await tx.unsafe(`SELECT count(*)::int AS n FROM scm.${c.table_name} WHERE ${c.column_name} = $1`, [r.from]);
      if (n[0].n) strays.push(`${c.table_name}.${c.column_name} = "${r.from}" ×${n[0].n}`);
    }
  }
  for (const r of recoded) {
    const n = await tx`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE company_id = ${CO} AND party_code = ${r.from} AND coalesce(party_type, '') <> 'SUPPLIER'`;
    if (n[0].n) strays.push(`journal_entry_lines.party_code = "${r.from}" (not a supplier line) ×${n[0].n}`);
  }
  sups = await tx`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO}`;
  const supBy = new Map(sups.map((s) => [s.code, s]));

  /* ── 3. what the opening adds ───────────────────────────────────────────── */
  const newAccounts = [];
  if (!chartBy.has(CLEARING.code)) newAccounts.push({ company_id: CO, account_code: CLEARING.code, account_name: CLEARING.name, account_type: CLEARING.type, parent_code: null, is_active: true, section: CLEARING.section });
  else if (parents.has(CLEARING.code) || chartBy.get(CLEARING.code).is_active === false) throw new Error(`${CLEARING.code} is on the chart but not a live leaf`);
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
    if (chartBy.get(t.code)?.is_active === false) throw new Error(`${t.code} is deactivated in the ERP chart`);
  }
  const stockCode = Object.fromEntries(BUCKETS.map((b) => [b, role[`OPENING_STOCK_${BUCKET_ROLE[b]}`]]));
  for (const b of BUCKETS) {
    const a = chartBy.get(stockCode[b]);
    if (!a || parents.has(stockCode[b]) || a.is_active === false) throw new Error(`the ${b} opening-stock account ${stockCode[b]} is not a live leaf on the chart`);
  }
  const newSuppliers = data.newSuppliers.filter((s) => !supBy.has(s.code));
  const newDebtors = data.otherDebtors.filter((d) => !debtorBy.has(d.erpName)).map((d) => ({ company_id: CO, name: d.erpName, notes: `${TAG}: AutoCount ${d.acCode} ${d.acName}`, created_by: ACTOR }));

  /* Every line of the aging becomes an opening paper, by its sign — the ERP's
     own copy of the same bill, if it holds one, is replaced (step 6). */
  const bills = [], credits = [];
  for (const a of data.aging) {
    if (!a.myrSen) continue;
    const fc = a.fcSen != null ? ` (CNY ${rm(a.fcSen)})` : '';
    const what = a.type === 'IN' ? `AutoCount ${a.acDoc ?? ''}` : a.type === 'PV' ? `AutoCount payment not knocked off ${a.ref}` : `AutoCount debit note ${a.ref}`;
    const row = { code: a.code, date: a.date, ref: a.type === 'IN' ? (a.ref || null) : null, amt: Math.abs(a.myrSen), acDoc: a.acDoc ?? null,
      replaces: a.erpCopy ?? a.skipInBooks ?? a.conflictErp ?? null,
      note: `${TAG}: ${what}${a.type === 'IN' && a.ref ? ` — supplier invoice ${a.ref}` : ''}${fc}${a.acDesc ? ` — ${a.acDesc}` : ''}` };
    (a.myrSen > 0 ? bills : credits).push(row);
  }
  /* Each supplier's papers must come to its AutoCount GL balance; only a CNY
     supplier may differ, by the exchange difference — one more paper. */
  const owedByCode = new Map();
  for (const b of bills) owedByCode.set(b.code, (owedByCode.get(b.code) ?? 0) + b.amt);
  for (const c of credits) owedByCode.set(c.code, (owedByCode.get(c.code) ?? 0) - c.amt);
  const cnySuppliers = new Set(data.aging.filter((a) => a.cur !== 'MYR').map((a) => a.code));
  const fxRows = [];
  for (const [code, owed] of Object.entries(data.creditorOwed)) {
    const diff = owed - (owedByCode.get(code) ?? 0);
    if (diff === 0) continue;
    if (!cnySuppliers.has(code)) throw new Error(`supplier ${code}: AutoCount GL owes ${rm(owed)} but its aging lines come to ${rm(owedByCode.get(code) ?? 0)}`);
    (diff > 0 ? bills : credits).push({ code, date: CUTOFF, ref: null, amt: Math.abs(diff), acDoc: null, replaces: null, note: `${TAG}: exchange difference to the AutoCount GL balance at 31/08 (CNY supplier)` });
    fxRows.push(`${code} ${diff > 0 ? 'bill' : 'credit'} RM ${rm(Math.abs(diff))}`);
  }
  for (const code of owedByCode.keys()) if (!(code in data.creditorOwed)) throw new Error(`supplier ${code} has aging lines but no GL balance`);
  const debtorBills = data.otherDebtors.filter((d) => d.sen > 0).map((d) => ({ ...d, date: CUTOFF, ref: d.acCode }));
  const debtorCredits = data.otherDebtors.filter((d) => d.sen < 0).map((d) => ({ ...d, date: CUTOFF, ref: d.acCode, amt: -d.sen }));

  /* The opening stock by bucket: AutoCount's figure, split as the ERP's own
     August close split its stock (the engine's shelves) — whole sen, the
     largest remainders taking the odd sen so the buckets add back exactly. */
  const tbBy = new Map(data.tb.map((t) => [t.code, t.bfSen]));
  const S0 = tbBy.get(STOCK_AC) ?? 0;
  const augClose = await tx`SELECT l.account_code, sum(l.debit_sen)::bigint AS sen FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.source_type = 'STOCKADJ' AND j.source_doc_no = ${`STOCKADJ-${CO}-2026-08`} AND j.posted AND NOT j.reversed AND l.debit_sen > 0 GROUP BY 1`;
  const invCode = Object.fromEntries(BUCKETS.map((b) => [role[`INVENTORY_${BUCKET_ROLE[b]}`], b]));
  const engineAug = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const r of augClose) if (invCode[r.account_code]) engineAug[invCode[r.account_code]] += Number(r.sen);
  const engineAugTotal = sumOf(BUCKETS, (b) => engineAug[b]);
  const openingStock = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  if (engineAugTotal > 0) {
    const raw = BUCKETS.map((b) => ({ b, exact: (S0 * engineAug[b]) / engineAugTotal }));
    for (const x of raw) openingStock[x.b] = Math.floor(x.exact);
    let left = S0 - sumOf(BUCKETS, (b) => openingStock[b]);
    for (const x of [...raw].sort((p, q) => (q.exact - Math.floor(q.exact)) - (p.exact - Math.floor(p.exact)))) { if (left <= 0) break; openingStock[x.b] += 1; left -= 1; }
  } else openingStock.customer = S0;
  if (sumOf(BUCKETS, (b) => openingStock[b]) !== S0) throw new Error('the opening stock split does not add back');
  const stockJson = Object.fromEntries(BUCKETS.filter((b) => openingStock[b] !== 0).map((b) => [b, openingStock[b]]));

  /* ── 4. numbers: claim each series' block once ──────────────────────────── */
  /* The live max per series is the floor (a JE number is unique across companies,
     and nextJeNo reads its floor across them too). */
  const floorsOf = async (table, col, like) => new Map((await tx.unsafe(
    `SELECT substring(${col} from '^(.*)-[0-9]+$') AS series, max(substring(${col} from '-([0-9]+)$')::int) AS n
       FROM scm.${table} WHERE ${col} LIKE $1${table === 'journal_entries' ? '' : ' AND company_id = $2'} GROUP BY 1`, table === 'journal_entries' ? [like] : [like, CO]))
    .map((r) => [r.series, Number(r.n)]));
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
  };
  await numberAll(bills, (r) => `${DOC}API-${yymm(r.date)}`, await floorsOf('ap_invoices', 'invoice_number', `${DOC}API-%`), 3);
  await numberAll(credits, (r) => `${DOC}SCN-${yymm(r.date)}`, await floorsOf('acc_credit_notes', 'note_number', `${DOC}SCN-%`), 3);
  await numberAll(debtorBills, (r) => `${DOC}ODB-${yymm(r.date)}`, await floorsOf('acc_debtor_bills', 'bill_number', `${DOC}ODB-%`), 3);
  await numberAll(debtorCredits, (r) => `${DOC}ODR-${yymm(r.date)}`, await floorsOf('acc_debtor_receipts', 'receipt_number', `${DOC}ODR-%`), 3);

  /* ── 5. the masters ─────────────────────────────────────────────────────── */
  if (newAccounts.length) await tx`INSERT INTO scm.accounts ${tx(newAccounts)}`;
  const supRows = newSuppliers.map((s) => ({ company_id: CO, code: s.code, name: s.name, currency: s.currency || 'MYR', for_purchasing: false }));
  if (supRows.length) for (const s of await tx`INSERT INTO scm.suppliers ${tx(supRows)} RETURNING id, code, name`) supBy.set(s.code, s);
  if (newDebtors.length) for (const d of await tx`INSERT INTO scm.acc_debtors ${tx(newDebtors)} RETURNING id, name`) debtorBy.set(d.name, d);
  for (const r of [...bills, ...credits]) if (!supBy.has(r.code)) throw new Error(`supplier ${r.code} missing after the master writes`);

  /* ── 6. the opening papers ──────────────────────────────────────────────── */
  const apiBy = new Map();
  for (const part of chunk(bills, 800)) {
    const rows = part.map((b) => ({ company_id: CO, invoice_number: b.no, supplier_id: supBy.get(b.code).id, supplier_invoice_ref: b.ref, invoice_date: b.date,
      currency: 'MYR', exchange_rate: 1, total_sen: b.amt, paid_sen: 0, status: 'POSTED', notes: b.note, created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR, opening: true }));
    for (const r of await tx`INSERT INTO scm.ap_invoices ${tx(rows)} RETURNING id, invoice_number`) apiBy.set(r.invoice_number, r.id);
  }
  for (const part of chunk(bills, 1500)) {
    await tx`INSERT INTO scm.ap_invoice_lines ${tx(part.map((b) => ({ company_id: CO, invoice_id: apiBy.get(b.no), line_no: 1, description: b.note.slice(0, 500), debit_account_code: CLEARING.code, amount_sen: b.amt })))}`;
  }
  for (const b of bills) b.id = apiBy.get(b.no);
  const scnBy = new Map();
  for (const part of chunk(credits, 800)) {
    const rows = part.map((c) => { const s = supBy.get(c.code); return { company_id: CO, note_number: c.no, kind: 'SCN', party_type: 'SUPPLIER', party_code: c.code, party_name: s.name, supplier_id: s.id,
      note_date: c.date, total_sen: c.amt, reason: c.note.slice(0, 300), notes: c.note, status: 'POSTED', created_by: ACTOR, posted_at: nowIso, posted_by: ACTOR, opening: true }; });
    for (const r of await tx`INSERT INTO scm.acc_credit_notes ${tx(rows)} RETURNING id, note_number`) scnBy.set(r.note_number, r.id);
  }
  for (const part of chunk(credits, 1500)) {
    await tx`INSERT INTO scm.acc_credit_note_lines ${tx(part.map((c) => ({ company_id: CO, note_id: scnBy.get(c.no), line_no: 1, description: c.note.slice(0, 500), account_code: CLEARING.code, amount_sen: c.amt })))}`;
  }
  if (debtorBills.length) {
    const ids = new Map();
    for (const r of await tx`INSERT INTO scm.acc_debtor_bills ${tx(debtorBills.map((d) => ({ company_id: CO, bill_number: d.no, debtor_id: debtorBy.get(d.erpName).id, bill_date: d.date,
      total_sen: d.sen, received_sen: 0, status: 'POSTED', notes: `${TAG}: AutoCount ${d.acCode} ${d.acName}`, created_by: ACTOR, opening: true })))} RETURNING id, bill_number`) ids.set(r.bill_number, r.id);
    await tx`INSERT INTO scm.acc_debtor_bill_lines ${tx(debtorBills.map((d) => ({ company_id: CO, bill_id: ids.get(d.no), line_no: 1, description: `${TAG}: AutoCount ${d.acCode}`, credit_account_code: CLEARING.code, amount_sen: d.sen })))}`;
  }
  if (debtorCredits.length) {
    await tx`INSERT INTO scm.acc_debtor_receipts ${tx(debtorCredits.map((d) => ({ company_id: CO, receipt_number: d.no, debtor_id: debtorBy.get(d.erpName).id, receipt_date: d.date,
      bank_account_code: CLEARING.code, total_sen: d.amt, status: 'POSTED', approved_at: nowIso, approved_by: ACTOR, posted_at: nowIso,
      notes: `${TAG}: AutoCount ${d.acCode} ${d.acName} — owed by us at 31/08, not yet knocked off`, created_by: ACTOR, opening: true })))}`;
  }

  /* ── 7. the journals, every one an opening one ──────────────────────────── */
  const jes = [];
  const supName = (code) => supBy.get(code).name;
  for (const b of bills) jes.push({ source: 'API', doc: b.no, date: b.date, narration: `AP invoice ${b.no} — ${supName(b.code)}${b.ref ? ` (${b.ref})` : ''} — ${TAG}`,
    lines: [{ a: CLEARING.code, dr: b.amt, cr: 0, notes: b.note.slice(0, 300) }, { a: apControl(b.code), dr: 0, cr: b.amt, pt: 'SUPPLIER', pc: b.code, pn: supName(b.code), notes: `AP invoice ${b.no}` }] });
  for (const c of credits) jes.push({ source: 'SCN', doc: c.no, date: c.date, narration: `Supplier credit note ${c.no} — ${supName(c.code)} — ${TAG}`,
    lines: [{ a: apControl(c.code), dr: c.amt, cr: 0, pt: 'SUPPLIER', pc: c.code, pn: supName(c.code), notes: `Supplier credit note ${c.no}` }, { a: CLEARING.code, dr: 0, cr: c.amt, notes: c.note.slice(0, 300) }] });
  for (const d of debtorBills) jes.push({ source: 'ODB', doc: d.no, date: d.date, narration: `Debtor bill ${d.no} — ${d.erpName} — ${TAG}`,
    lines: [{ a: role.AR_OTHER, dr: d.sen, cr: 0, pt: 'ODEBTOR', pn: d.erpName, notes: `Other debtor ${d.erpName} — ${d.no}` }, { a: CLEARING.code, dr: 0, cr: d.sen, notes: `${TAG}: AutoCount ${d.acCode}` }] });
  for (const d of debtorCredits) jes.push({ source: 'ODR', doc: d.no, date: d.date, narration: `Debtor receipt ${d.no} — ${d.erpName} — ${TAG}`,
    lines: [{ a: CLEARING.code, dr: d.amt, cr: 0, notes: `${TAG}: AutoCount ${d.acCode}` }, { a: role.AR_OTHER, dr: 0, cr: d.amt, pt: 'ODEBTOR', pn: d.erpName, notes: `Other debtor settlement — ${d.no}` }] });

  /* The OPENING journal: every other account at its AutoCount B/F. */
  const target = new Map();
  for (const t of data.tb) if (!PARTY_AC.test(t.code) && t.code !== STOCK_AC) target.set(t.code, t.bfSen);
  target.set(DEFERRED, (tbBy.get(DEFERRED) ?? 0) + (tbBy.get(CUSTOMER_AC) ?? 0));
  for (const b of BUCKETS) if (openingStock[b]) target.set(stockCode[b], openingStock[b]);
  const tbLines = [];
  for (const [code, t] of target) {
    if (t === 0) continue;
    const why = code === DEFERRED ? ` + 300-C002 CUSTOMER ${rm(tbBy.get(CUSTOMER_AC) ?? 0)} (debtor aging 0, owner 10-27)` : Object.values(stockCode).includes(code) ? ` (600-0000 ${rm(S0)} by the August close's buckets)` : '';
    tbLines.push({ a: code, dr: Math.max(t, 0), cr: Math.max(-t, 0), notes: `${TAG}: AutoCount B/F${why}` });
  }
  const tbNet = sumOf(tbLines, (l) => l.dr - l.cr);
  if (tbNet !== 0) tbLines.push({ a: CLEARING.code, dr: Math.max(-tbNet, 0), cr: Math.max(tbNet, 0), notes: `${TAG}: the creditors and other debtors, carried by their opening papers` });
  jes.push({ source: 'OPENING', doc: TB_DOC, date: CUTOFF, narration: `Opening balances at 31/08/2026 from AutoCount (trial balance B/F; creditors and other debtors by their papers) — ${TAG}`, lines: tbLines });

  for (const j of jes) {
    j.dr = sumOf(j.lines, (l) => l.dr); j.cr = sumOf(j.lines, (l) => l.cr);
    if (j.dr !== j.cr) throw new Error(`${j.source} ${j.doc} unbalanced ${j.dr} / ${j.cr}`);
    if (j.dr > INT_MAX) throw new Error(`${j.source} ${j.doc} total ${j.dr} exceeds the integer column`);
    for (const l of j.lines) if (l.dr > INT_MAX || l.cr > INT_MAX || (l.dr > 0 && l.cr > 0) || l.dr < 0 || l.cr < 0) throw new Error(`${j.doc} bad line ${JSON.stringify(l)}`);
  }
  const controls = new Set([role.AR, role.AR_OTHER, role.AP, role.AP_OTHER]);
  for (const l of tbLines) if (controls.has(l.a)) throw new Error(`the OPENING journal names the control ${l.a}`);
  await numberAll(jes, (j) => `JE-${yymm(j.date)}`, await floorsOf('journal_entries', 'je_no', 'JE-%'), 4);
  const jeIds = new Map();
  for (const part of chunk(jes, 800)) {
    const rows = part.map((j) => ({ company_id: CO, je_no: j.no, entry_date: j.date, source_type: j.source, source_doc_no: j.doc, narration: j.narration,
      total_debit_sen: j.dr, total_credit_sen: j.cr, posted: false, opening: true }));
    for (const r of await tx`INSERT INTO scm.journal_entries ${tx(rows)} RETURNING id, je_no`) jeIds.set(r.je_no, r.id);
  }
  const lineRows = jes.flatMap((j) => j.lines.map((l, i) => ({ company_id: CO, journal_entry_id: jeIds.get(j.no), line_no: i + 1, account_code: l.a,
    debit_sen: l.dr, credit_sen: l.cr, party_type: l.pt ?? null, party_code: l.pc ?? null, party_name: l.pn ?? null, notes: l.notes ?? null })));
  for (const part of chunk(lineRows, 1500)) await tx`INSERT INTO scm.journal_entry_lines ${tx(part)}`;
  for (const part of chunk([...jeIds.values()], 1000)) await tx`UPDATE scm.journal_entries SET posted = true, posted_at = now() WHERE id = ANY(${part}::uuid[])`;
  for (const part of chunk(jes.filter((j) => j.source === 'SCN'), 1000)) {
    await tx`UPDATE scm.acc_credit_notes n SET je_no = v.je_no FROM (SELECT unnest(${part.map((j) => j.doc)}::text[]) AS note_number, unnest(${part.map((j) => j.no)}::text[]) AS je_no) v
      WHERE n.company_id = ${CO} AND n.note_number = v.note_number`;
  }

  /* ── 8. the books start ─────────────────────────────────────────────────── */
  await tx`INSERT INTO scm.acc_company_settings ${tx({ company_id: CO, books_start_date: BOOKS_START, opening_stock: tx.json(stockJson), updated_at: nowIso, updated_by: ACTOR })}
    ON CONFLICT (company_id) DO UPDATE SET books_start_date = EXCLUDED.books_start_date, opening_stock = EXCLUDED.opening_stock, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`;

  /* ── 9. the ERP's own supplier bills dated by 31/08 ─────────────────────── */
  const replacing = new Map(bills.filter((b) => b.replaces).map((b) => [b.replaces, b]));
  const erpBills = await tx`
    SELECT 'PI' AS k, p.id, p.invoice_number AS no, s.code AS supplier, p.supplier_invoice_ref AS ref, p.invoice_date::text AS date, p.currency, p.exchange_rate::float8 AS rate,
           p.total_sen, p.paid_sen, p.status::text AS status, coalesce(p.migrated_no_stock, false) AS migrated
      FROM scm.purchase_invoices p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
     WHERE p.company_id = ${CO} AND p.status::text <> 'CANCELLED' AND (p.invoice_date <= ${CUTOFF} OR p.invoice_number = ANY(${[...replacing.keys()]}::text[]))
    UNION ALL
    SELECT 'API', a.id, a.invoice_number, s.code, a.supplier_invoice_ref, a.invoice_date::text, a.currency, a.exchange_rate::float8,
           a.total_sen, a.paid_sen, a.status, false
      FROM scm.ap_invoices a LEFT JOIN scm.suppliers s ON s.id = a.supplier_id
     WHERE a.company_id = ${CO} AND a.status <> 'CANCELLED' AND NOT a.opening AND (a.invoice_date <= ${CUTOFF} OR a.invoice_number = ANY(${[...replacing.keys()]}::text[]))`;
  const jeOf = new Map((await tx`SELECT source_type || ':' || source_doc_no AS key, entry_date::text AS d FROM scm.journal_entries
      WHERE company_id = ${CO} AND source_type IN ('PI', 'API') AND posted AND NOT reversed AND reversed_by_je IS NULL
        AND source_doc_no = ANY(${erpBills.map((b) => b.no)}::text[])`).map((r) => [r.key, r.d]));
  for (const no of replacing.keys()) if (!erpBills.some((b) => b.no === no)) say(`! the aging names ERP paper ${no} to replace, but it is not on file (cancelled?) — its opening bill stands alone`);
  const inBooks = [], drafts = [], toClose = [];
  for (const b of erpBills) {
    b.je = jeOf.get(`${b.k}:${b.no}`) ?? null;
    b.by = replacing.get(b.no) ?? null;
    if (b.status === 'DRAFT') { drafts.push(b); continue; }
    if (b.je && b.je >= BOOKS_START) {
      if (b.by) throw new Error(`${b.no} is replaced by opening bill ${b.by.no} but its own journal is dated ${b.je}, inside the books — reverse it first`);
      inBooks.push(b);
      continue;
    }
    toClose.push(b);
  }

  /* ── 10. ticks on them ──────────────────────────────────────────────────── */
  const ids = (k) => toClose.filter((b) => b.k === k).map((b) => b.id);
  const billById = new Map(toClose.map((b) => [String(b.id), b]));
  const pvTicks = await tx`SELECT a.id, a.pv_id, a.pi_id, a.ap_invoice_id, a.amount_sen, a.applied_sen, a.from_advance,
        v.pv_number, v.status::text AS pv_status, v.voucher_date::text AS pv_date, v.currency AS pv_currency, v.supplier_id AS pv_supplier, v.purpose::text AS purpose
      FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id
     WHERE (a.pi_id = ANY(${ids('PI')}::uuid[]) OR a.ap_invoice_id = ANY(${ids('API')}::uuid[])) AND v.status::text <> 'CANCELLED'
     ORDER BY v.voucher_date, v.pv_number`;
  const cnTicks = await tx`SELECT k.id, k.note_id, k.purchase_invoice_id, k.ap_invoice_id, k.amount_sen, k.applied_sen, n.note_number, n.status, n.note_date::text AS note_date
      FROM scm.acc_credit_note_allocations k JOIN scm.acc_credit_notes n ON n.id = k.note_id
     WHERE (k.purchase_invoice_id = ANY(${ids('PI')}::uuid[]) OR k.ap_invoice_id = ANY(${ids('API')}::uuid[])) AND n.status <> 'CANCELLED'
     ORDER BY n.note_date, n.note_number`;
  const owedLeft = new Map(bills.map((b) => [b.no, b.amt]));
  const myr = (b, sen) => (b.k === 'PI' && String(b.currency ?? 'MYR').toUpperCase() !== 'MYR' ? Math.round(Number(sen) * Number(b.rate || 1)) : Number(sen));
  const moved = [], kept = [], advances = new Map(), refused = [];
  const consider = (t, kind) => {
    const bill = billById.get(String(t.pi_id ?? t.purchase_invoice_id ?? t.ap_invoice_id));
    const date = kind === 'PV' ? t.pv_date : t.note_date;
    const posted = kind === 'PV' ? t.pv_status === 'POSTED' : t.status === 'POSTED';
    const doc = kind === 'PV' ? t.pv_number : t.note_number;
    const base = { kind, id: t.id, doc, status: kind === 'PV' ? t.pv_status : t.status, date, from: bill.no, fromCur: bill.currency, plannedRaw: Number(t.amount_sen), appliedRaw: Number(t.applied_sen) };
    if (posted && date < BOOKS_START) return; // the soft launch: history, outside the books
    if (!bill.by) { kept.push({ ...base, why: 'bill not owed (AutoCount has it settled or never had it)' }); return; }
    const o = bill.by;
    const applied = myr(bill, t.applied_sen);
    const planned = myr(bill, t.amount_sen);
    if (!posted && bill.k === 'PI' && String(bill.currency ?? 'MYR').toUpperCase() !== 'MYR') { refused.push({ ...base, to: o.no, why: 'a draft in a foreign currency on a replaced bill — move it by hand' }); return; }
    const left = owedLeft.get(o.no);
    let take = applied, excess = 0;
    if (posted) {
      take = Math.min(applied, left);
      excess = applied - take;
      owedLeft.set(o.no, left - take);
      if (excess > 0) {
        if (kind !== 'PV' || t.purpose !== 'SUPPLIER_PAYMENT' || !t.pv_supplier || String(t.pv_currency ?? 'MYR').toUpperCase() !== 'MYR') {
          refused.push({ ...base, to: o.no, why: `applied RM ${rm(applied)} but AutoCount owed RM ${rm(left)} — the excess cannot become an advance here` });
          owedLeft.set(o.no, left);
          return;
        }
        advances.set(t.pv_id, { pv_id: t.pv_id, pv_number: t.pv_number, supplier_id: t.pv_supplier, sen: (advances.get(t.pv_id)?.sen ?? 0) + excess });
      }
    }
    moved.push({ ...base, to: o.no, toId: o.id, ac: o.acDoc, owed: o.amt, applied, planned: posted ? take : planned, take: posted ? take : 0, excess, posted });
  };
  for (const t of pvTicks) consider(t, 'PV');
  for (const t of cnTicks) consider(t, 'SCN');
  const pvMoves = moved.filter((m) => m.kind === 'PV');
  const cnMoves = moved.filter((m) => m.kind === 'SCN');
  if (pvMoves.length) {
    await tx`UPDATE scm.pv_allocations a SET pi_id = NULL, ap_invoice_id = v.api, amount_sen = v.amt, applied_sen = v.app
      FROM (SELECT unnest(${pvMoves.map((m) => m.id)}::uuid[]) AS id, unnest(${pvMoves.map((m) => m.toId)}::uuid[]) AS api,
                   unnest(${pvMoves.map((m) => m.planned)}::bigint[]) AS amt, unnest(${pvMoves.map((m) => m.take)}::bigint[]) AS app) v WHERE a.id = v.id`;
  }
  if (cnMoves.length) {
    await tx`UPDATE scm.acc_credit_note_allocations k SET purchase_invoice_id = NULL, ap_invoice_id = v.api, amount_sen = v.amt, applied_sen = v.app
      FROM (SELECT unnest(${cnMoves.map((m) => m.id)}::uuid[]) AS id, unnest(${cnMoves.map((m) => m.toId)}::uuid[]) AS api,
                   unnest(${cnMoves.map((m) => Math.max(m.planned, 1))}::bigint[]) AS amt, unnest(${cnMoves.map((m) => m.take)}::bigint[]) AS app) v WHERE k.id = v.id`;
  }
  const paidOn = new Map();
  for (const m of moved) if (m.take > 0) paidOn.set(m.toId, (paidOn.get(m.toId) ?? 0) + m.take);
  if (paidOn.size) {
    await tx`UPDATE scm.ap_invoices a SET paid_sen = v.paid, updated_at = now(), status = CASE WHEN v.paid >= a.total_sen THEN 'PAID' ELSE 'PARTIALLY_PAID' END
      FROM (SELECT unnest(${[...paidOn.keys()]}::uuid[]) AS id, unnest(${[...paidOn.values()]}::bigint[]) AS paid) v WHERE a.id = v.id`;
  }
  for (const a of advances.values()) {
    const had = await tx`SELECT id, amount_sen, applied_sen FROM scm.acc_supplier_advances WHERE pv_id = ${String(a.pv_id)}`;
    if (had.length) await tx`UPDATE scm.acc_supplier_advances SET amount_sen = amount_sen + ${a.sen}, updated_at = now() WHERE id = ${had[0].id}`;
    else await tx`INSERT INTO scm.acc_supplier_advances ${tx({ company_id: CO, supplier_id: String(a.supplier_id), pv_id: String(a.pv_id), pv_number: a.pv_number, amount_sen: a.sen, applied_sen: 0 })}`;
  }
  const audit = moved.map((m) => ({ company_id: CO, entity_type: m.kind === 'PV' ? 'PAYMENT_VOUCHER' : 'CREDIT_NOTE', entity_id: String(m.kind === 'PV' ? pvTicks.find((t) => t.id === m.id).pv_id : cnTicks.find((t) => t.id === m.id).note_id),
    entity_doc_no: m.doc, action: 'UPDATE', actor_name_snapshot: ACTOR, field_changes: tx.json([{ field: 'allocation', from: m.from, to: m.to }]), status_snapshot: m.status, source: 'script',
    note: `${TAG}: the tick on ${m.from} moved to its opening bill ${m.to} (AutoCount ${m.ac ?? '-'})${m.excess ? `; RM ${rm(m.excess)} beyond what AutoCount still owed becomes this payment's advance` : ''}` }));
  for (const part of chunk(audit, 500)) await tx`INSERT INTO scm.entity_audit_log ${tx(part)}`;
  const over = [...new Set(moved.filter((m) => !m.posted).map((m) => m.to))].map((no) => {
    const plannedSen = sumOf(moved.filter((m) => !m.posted && m.to === no), (m) => m.planned);
    return { no, plannedSen, leftSen: owedLeft.get(no), bill: bills.find((b) => b.no === no) };
  }).filter((x) => x.plannedSen > x.leftSen);

  /* Close the ERP's own papers: replaced, or not owed. Kept on file. */
  const closing = toClose.filter((b) => b.by || Number(b.paid_sen) < Number(b.total_sen) || b.status !== 'PAID')
    .map((b) => ({ b, note: b.by ? `Replaced by opening bill ${b.by.no} (${TAG}, AutoCount ${b.by.acDoc ?? 'aging'} RM ${rm(b.by.amt)})` : `Not owed in the books: dated before ${BOOKS_START} and not on AutoCount's creditor aging at 31/08 (${TAG})` }));
  for (const k of ['PI', 'API']) {
    const part = closing.filter((c) => c.b.k === k);
    for (const p of chunk(part, 1000)) {
      if (k === 'PI') await tx`UPDATE scm.purchase_invoices x SET paid_sen = x.total_sen, status = 'PAID', updated_at = now(), notes = concat_ws(E'\n', nullif(x.notes, ''), v.note)
          FROM (SELECT unnest(${p.map((c) => c.b.id)}::uuid[]) AS id, unnest(${p.map((c) => c.note)}::text[]) AS note) v WHERE x.id = v.id AND x.company_id = ${CO}`;
      else await tx`UPDATE scm.ap_invoices x SET paid_sen = x.total_sen, status = 'PAID', updated_at = now(), notes = concat_ws(E'\n', nullif(x.notes, ''), v.note)
          FROM (SELECT unnest(${p.map((c) => c.b.id)}::uuid[]) AS id, unnest(${p.map((c) => c.note)}::text[]) AS note) v WHERE x.id = v.id AND x.company_id = ${CO}`;
      await tx`INSERT INTO scm.entity_audit_log ${tx(p.map((c) => ({ company_id: CO, entity_type: k === 'PI' ? 'PURCHASE_INVOICE' : 'AP_INVOICE', entity_id: String(c.b.id), entity_doc_no: c.b.no, action: 'UPDATE',
        actor_name_snapshot: ACTOR, field_changes: tx.json([{ field: 'paidSen', from: Number(c.b.paid_sen), to: Number(c.b.total_sen) }, { field: 'status', from: c.b.status, to: 'PAID' }]),
        status_snapshot: 'PAID', source: 'script', note: c.note })))}`;
    }
  }

  /* ── 11. verify, inside the transaction, through the books' own views ──── */
  const bad = [];
  const at31 = new Map((await tx`SELECT account_code AS code, sum(debit_sen - credit_sen)::bigint AS bal FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= ${CUTOFF} AND NOT reversed AND reversed_by_je IS NULL GROUP BY 1`).map((r) => [r.code, Number(r.bal)]));
  for (const [code, t] of target) if ((at31.get(code) ?? 0) !== t) bad.push(`${code} at 31/08 is ${rm(at31.get(code) ?? 0)}, want ${rm(t)}`);
  for (const [code, v] of at31) if (!target.has(code) && !controls.has(code) && code !== CLEARING.code && v !== 0) bad.push(`${code} carries ${rm(v)} at 31/08 that the opening does not name`);
  if ((at31.get(CLEARING.code) ?? 0) !== 0) bad.push(`${CLEARING.code} is ${rm(at31.get(CLEARING.code))} at 31/08, want nil`);
  const total31 = sumOf([...at31.values()], (v) => v);
  if (total31 !== 0) bad.push(`the books do not balance at 31/08: ${rm(total31)}`);
  const clearingAll = await tx`SELECT coalesce(sum(debit_sen - credit_sen), 0)::bigint AS bal FROM scm.v_gl_entries WHERE company_id = ${CO} AND account_code = ${CLEARING.code} AND NOT reversed AND reversed_by_je IS NULL`;
  if (Number(clearingAll[0].bal) !== 0) bad.push(`${CLEARING.code} is ${rm(clearingAll[0].bal)} over all dates, want nil`);
  const owedAfter = new Map((await tx`SELECT party_code AS code, sum(credit_sen - debit_sen)::bigint AS owed FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= ${CUTOFF} AND NOT reversed AND reversed_by_je IS NULL AND account_code IN (${role.AP}, ${role.AP_OTHER}) GROUP BY 1`).map((r) => [r.code, Number(r.owed)]));
  for (const code of new Set([...Object.keys(data.creditorOwed), ...owedAfter.keys()])) {
    const want = data.creditorOwed[code] ?? 0;
    if ((owedAfter.get(code) ?? 0) !== want) bad.push(`supplier ${code ?? '(none)'} owed ${rm(owedAfter.get(code) ?? 0)} at 31/08, want AutoCount ${rm(want)}`);
  }
  const odAfter = new Map((await tx`SELECT party_name AS name, sum(debit_sen - credit_sen)::bigint AS bal FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= ${CUTOFF} AND NOT reversed AND reversed_by_je IS NULL AND account_code = ${role.AR_OTHER} GROUP BY 1`).map((r) => [r.name, Number(r.bal)]));
  for (const d of data.otherDebtors) if ((odAfter.get(d.erpName) ?? 0) !== d.sen) bad.push(`other debtor ${d.erpName} is ${rm(odAfter.get(d.erpName) ?? 0)} at 31/08, want ${rm(d.sen)}`);
  for (const [name, v] of odAfter) if (v !== 0 && !data.otherDebtors.some((d) => d.erpName === name)) bad.push(`other debtor ${name} carries ${rm(v)} at 31/08 that AutoCount does not`);
  const arAt31 = at31.get(role.AR) ?? 0;
  if (arAt31 !== 0) bad.push(`customers (${role.AR}) carry ${rm(arAt31)} at 31/08, want nil (debtor aging 0)`);
  const stillOpen = await tx`SELECT count(*)::int AS n, coalesce(sum(total_sen - paid_sen), 0)::bigint AS sen FROM (
      SELECT total_sen, paid_sen FROM scm.purchase_invoices WHERE company_id = ${CO} AND status::text NOT IN ('CANCELLED', 'PAID', 'DRAFT') AND invoice_date <= ${CUTOFF}
      UNION ALL SELECT total_sen, paid_sen FROM scm.ap_invoices WHERE company_id = ${CO} AND status NOT IN ('CANCELLED', 'PAID', 'DRAFT') AND invoice_date <= ${CUTOFF} AND NOT opening) x`;

  /* What the books read from 01/09 that the soft launch leaves behind. */
  const sep = new Map((await tx`SELECT account_code AS code, sum(debit_sen - credit_sen)::bigint AS bal FROM scm.v_gl_entries
      WHERE company_id = ${CO} AND entry_date <= '2026-09-30' AND NOT reversed AND reversed_by_je IS NULL
        AND account_code IN ('326-0000', '327-0000', ${role.AR}, '400-0001', ${DEFERRED}, '509-0000') GROUP BY 1`).map((r) => [r.code, Number(r.bal)]));
  const transitSoft = await tx`SELECT l.account_code AS code, sum(l.debit_sen - l.credit_sen)::bigint AS bal FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date < ${BOOKS_START} AND l.account_code IN ('326-0000', '327-0000') GROUP BY 1`;
  const stmts = await tx`SELECT account_code, count(*)::int AS n, min(period_from)::text AS f, max(period_from)::text AS t FROM scm.acc_bank_statements WHERE company_id = ${CO} GROUP BY 1 ORDER BY 1`;

  /* ── 12. the report ─────────────────────────────────────────────────────── */
  say(`supplier codes: ${recoded.map((r) => `${r.name} ${r.from} → ${r.to} (${r.lines} journal lines${r.onOther ? `, ${r.onOther} onto ${role.AP_OTHER}` : ''}, ${r.notes} credit notes)`).join('; ') || 'none'}${strays.length ? ` | other columns still holding an old code: ${strays.join('; ')}` : ''}`);
  say(`new accounts: ${newAccounts.map((a) => `${a.account_code} ${a.account_name}`).join('; ') || 'none'}`);
  say(`new suppliers: ${supRows.map((s) => `${s.code} ${s.name}`).join('; ') || 'none'}`);
  say(`new other debtors: ${newDebtors.map((d) => d.name).join('; ') || 'none'}`);
  say(`opening AP invoices: ${bills.length} RM ${rm(sumOf(bills, (b) => b.amt))} (${bills.filter((b) => b.replaces).length} replace an ERP paper)`);
  say(`opening supplier credit notes: ${credits.length} RM ${rm(sumOf(credits, (c) => c.amt))}`);
  say(`exchange differences: ${fxRows.join('; ') || 'none'}`);
  say(`opening other-debtor bills: ${debtorBills.length} RM ${rm(sumOf(debtorBills, (d) => d.sen))}; receipts (debtors we owe): ${debtorCredits.map((d) => `${d.no} ${d.erpName} RM ${rm(d.amt)}`).join('; ') || 'none'}`);
  say(`opening stock RM ${rm(S0)} by bucket: ${BUCKETS.map((b) => `${b} ${rm(openingStock[b])}`).join(', ')} (the ERP's August close: ${BUCKETS.map((b) => `${b} ${rm(engineAug[b])}`).join(', ')}; total ${rm(engineAugTotal)})`);
  say(`journals: ${jes.length} (${['API', 'SCN', 'ODB', 'ODR'].map((k) => `${jes.filter((j) => j.source === k).length} ${k}`).join(', ')}, 1 OPENING ${jes.at(-1).no} with ${tbLines.length} lines RM ${rm(jes.at(-1).dr)})`);
  say(`ERP supplier papers dated by 31/08: ${erpBills.length}; closed ${closing.length} (${closing.filter((c) => c.b.by).length} replaced by their opening bill, ${closing.filter((c) => !c.b.by).length} not owed); already closed ${toClose.length - closing.length}; drafts left ${drafts.length}${drafts.length ? ': ' + drafts.map((b) => `${b.no} ${b.supplier} RM ${rm(b.total_sen)}`).join('; ') : ''}; still open after ${stillOpen[0].n} RM ${rm(stillOpen[0].sen)}`);
  say(`kept in the books (journal dated from ${BOOKS_START}): ${inBooks.map((b) => `${b.no} ${b.supplier} RM ${rm(b.total_sen)} dated ${b.date}, booked ${b.je}${b.ref ? ` (${b.ref})` : ''}`).join('; ') || 'none'}`);
  say(`not owed, closed: ${closing.filter((c) => !c.b.by && !c.b.migrated).map((c) => `${c.b.no} ${c.b.supplier} RM ${rm(c.b.total_sen)}${c.b.ref ? ` (${c.b.ref})` : ''}`).join('; ') || 'none'}; + ${closing.filter((c) => !c.b.by && c.b.migrated).length} brought-over copies AutoCount had settled`);
  say(`ticks moved to an opening bill: ${pvMoves.length} payment ticks (${[...new Set(pvMoves.map((m) => m.doc))].join(', ') || '-'}), ${cnMoves.length} credit-note ticks; advances made: ${[...advances.values()].map((a) => `${a.pv_number} RM ${rm(a.sen)}`).join('; ') || 'none'}`);
  for (const k of kept) say(`! ${k.doc} (${k.status}, ${k.date}) ticks ${k.from} RM ${rm(k.plannedRaw)} — ${k.why}: left as it is`);
  for (const r of refused) say(`! ${r.doc} (${r.status}) ticks ${r.from} → ${r.to}: ${r.why}`);
  for (const x of over) say(`! ${x.no} (AutoCount ${x.bill.acDoc ?? '-'}, ${x.bill.code}): AutoCount still owed RM ${rm(x.leftSen)} but the drafts plan RM ${rm(x.plannedSen)}`);
  say(`books from 01/09 at 30/09: ${['326-0000', '327-0000', role.AR, '400-0001', DEFERRED, '509-0000'].map((c) => `${c} ${rm(sep.get(c) ?? 0)}`).join(', ')} | soft-launch card/online money left in transit at 31/08 (now outside the books): ${transitSoft.map((r) => `${r.code} ${rm(r.bal)}`).join(', ') || 'none'}`);
  say(`bank statements filed for company ${CO}: ${stmts.map((s) => `${s.account_code} ×${s.n} ${s.f}..${s.t}`).join('; ') || 'none'}`);
  for (const l of tbLines) emit('TB', { a: l.a, name: chartBy.get(l.a)?.account_name ?? newAccounts.find((x) => x.account_code === l.a)?.account_name ?? '', dr: l.dr, cr: l.cr, ac: tbBy.get(l.a) ?? null, after: at31.get(l.a) ?? 0 });
  for (const b of bills) emit('DOC', { k: 'API', no: b.no, code: b.code, name: supBy.get(b.code).name, date: b.date, ref: b.ref, sen: b.amt, ac: b.acDoc, replaces: b.replaces, paid: b.amt - (owedLeft.get(b.no) ?? b.amt) });
  for (const c of credits) emit('DOC', { k: 'SCN', no: c.no, code: c.code, name: supBy.get(c.code).name, date: c.date, sen: c.amt, note: c.note });
  for (const d of debtorBills) emit('DOC', { k: 'ODB', no: d.no, name: d.erpName, date: d.date, sen: d.sen, ac: d.acCode });
  for (const d of debtorCredits) emit('DOC', { k: 'ODR', no: d.no, name: d.erpName, date: d.date, sen: d.amt, ac: d.acCode });
  for (const c of closing) emit('CLOSE', { k: c.b.k, no: c.b.no, supplier: c.b.supplier, date: c.b.date, ref: c.b.ref, sen: Number(c.b.total_sen), paid: Number(c.b.paid_sen), migrated: c.b.migrated, by: c.b.by?.no ?? null, note: c.note });
  for (const b of inBooks) emit('KEEP', { k: b.k, no: b.no, supplier: b.supplier, date: b.date, booked: b.je, ref: b.ref, sen: Number(b.total_sen) });
  for (const m of moved) emit('TICK', { kind: m.kind, doc: m.doc, status: m.status, date: m.date, from: m.from, to: m.to, ac: m.ac, owed: m.owed, applied: m.applied, planned: m.planned, take: m.take, excess: m.excess });
  for (const k of kept) emit('KEPTTICK', k);
  for (const r of refused) emit('REFUSED', r);
  for (const code of new Set([...Object.keys(data.creditorOwed), ...owedAfter.keys()])) if (code) emit('SUP', { code, name: supBy.get(code)?.name ?? '', ac: data.creditorOwed[code] ?? 0, after: owedAfter.get(code) ?? 0,
    bills: bills.filter((b) => b.code === code).length, billSen: sumOf(bills.filter((b) => b.code === code), (b) => b.amt), credits: credits.filter((c) => c.code === code).length, creditSen: sumOf(credits.filter((c) => c.code === code), (c) => c.amt) });
  say(bad.length ? `VERIFY FAILED (${bad.length}):` : `VERIFY: at 31/08 every account is AutoCount's (150-0000 ${rm(at31.get(RE) ?? 0)}), every supplier and other debtor is AutoCount's, customers nil, ${CLEARING.code} nil, the books balance.`);
  for (const b of bad.slice(0, 60)) say(`  ✗ ${b}`);
  if (bad.length) throw new Error(`verification failed — ${bad.length} difference(s); nothing kept`);
}

main().catch((e) => { console.error(e); process.exit(1); });
