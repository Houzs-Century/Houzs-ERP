#!/usr/bin/env node
/* Census the AutoCount party codes the ERP holds. READ-ONLY: SELECT only, no
   DDL, no writes, no transaction.

   THE POINT. HC-PO-2608-001 / HC-GR-2608-001 / HC-PI-2608-001 are booked in
   AED_HOUZS against creditor 400-H004, which AutoCount holds as HAO HUA
   FURNITURE. The ERP purchase order behind them names HOOKKA INDUSTRIES SDN.
   BHD. Different company: those documents are on the wrong creditor. That is an
   accounting error, not a technical one, and no layer refused it because no
   layer ever looked.

   THE MECHANISM, traced rather than guessed. readPoHeader
   (src/scm/lib/autocount-outbox.ts) reads scm.suppliers.code through
   supplier_id and sends it as CreditorCode verbatim. The drain's
   /ensure-masters pre-flight then asks CreditorExists(acc) — which is
   `da.GetCreditor(acc) != null` in scripts/autocount-service/AcSyncService.cs —
   and on a hit it records "existed" and `continue`s, DISCARDING the CompanyName
   the ERP sent in the same object without ever comparing it. A code that
   resolves to the wrong company is byte-for-byte indistinguishable from one
   that resolves to the right company, at every layer.

   So the owner's question is the right one: how many more are wrong? The field
   is hand-entered and nothing validates it. This script measures the ERP half.
   The AutoCount half is, on the host:
     SELECT AccNo, CompanyName FROM Creditor
     SELECT AccNo, CompanyName FROM Debtor
   The two halves line up BY CODE, which is why every list below is one line per
   record, code first, sorted by code.

   THIS SCRIPT DOES NOT FIX ANYTHING and must not learn to. Which creditor code
   is correct for HOOKKA INDUSTRIES is the owner's call against the AutoCount
   masters; a wrong "correction" books the documents to a third company.

   LINKED IS NOT PUSHED, and the first run of this census reported only the
   first, which overstates the exposure by two orders of magnitude. A document
   is LINKED when the ERP row and an AutoCount document are paired; most of
   those pairs were made by `import-ac-outstanding-po.mjs` for documents that
   ORIGINATED in the book, where the ERP never chose the creditor and therefore
   cannot have chosen it wrongly. A document is PUSHED when a `sent` outbox row
   says the ERP sent it. PUSHED is the population the owner's question is about.
   Both are printed side by side, everywhere either appears.

   WHAT IT PRINTS, per company:
     1. suppliers with a non-empty code — the code, the ERP's name, and whether
        the supplier has been used on a purchase order that reached AutoCount,
        split LINKED / PUSHED
     2. customers with a non-empty code — the same three facts, against sales
        orders
     3. suppliers and customers with NO code — they cannot reach AutoCount, a
        separate and quieter failure
     5. what the AutoCount-linked documents actually carry — the row to diff
        first, because it is already in the book
   and once, across companies:
     4. any code held by more than one ERP record, in either table — with the
        subset where the rows name DIFFERENT companies called out, because that
        is the half where the code cannot be right for both

   NO CODE COLUMN IS ASSUMED. Both are resolved out of
   information_schema.columns on every run and printed before anything is
   counted. A table or column that is not there is reported and skipped, never
   silently counted as zero — two probes in this directory have already died on
   a wrong table name and reported nothing, and a verdict computed over nothing
   must not read as a pass.

   THE SALES SIDE IS NOT THE SAME DEFECT, and the run says so in its own words.
   composeCreateSo sends the CONSTANT AC_DEBTOR_CODE, never the customer's code
   — read out of src/services/autocount-writeback.ts at runtime here so this
   sentence cannot go stale — so scm.customers' code column has never reached
   the account book. Section 2 measures the ERP master anyway, because "the code
   exists and is unused" and "the code is wrong" are different findings and both
   were asked for.

   STATUS-LIKE COLUMNS ARE ENUMS in this schema (supplier_status, po_status,
   mfg_so_status). COALESCE(col,'') coerces the empty string into the enum and
   throws, so nothing here reads one without ::text. The outbox's own status is
   plain text with a CHECK; it is cast anyway, so a later conversion to an enum
   cannot break this script silently.

   Exit 0 for every legitimate answer, including "no rows" and "no such table".
   Non-zero only for a missing DSN or a database this script could not read.

   RE-RUN: reads only. A second run prints the same report against whatever the
   database says at that moment. Nothing is cached, nothing is written.

     DATABASE_URL=... node scripts/census-autocount-party-codes.mjs
*/
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const ONLY_COMPANY = (process.env.COMPANY || 'all').trim();
const MAX_ROWS = Number(process.env.MAX_ROWS || 1000);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const out = (m = '') => console.log(m);
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARN ${m}`);

const pad = (v, n) => String(v ?? '').padEnd(n);
const clip = (v, n) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const rule = (...widths) => `   ${widths.map((w) => '-'.repeat(w - 1)).join(' ')}`;

/** No-op predicate, so a conditional company filter never has to interpolate an
 *  empty fragment. */
const ALWAYS = () => sql`AND TRUE`;

/** The constant the SO composer actually sends, read from source so this report
 *  cannot drift away from the code. A miss is STATED, never guessed at. */
function acDebtorCode() {
  try {
    const src = readFileSync(new URL('../src/services/autocount-writeback.ts', import.meta.url), 'utf8');
    const m = /export const AC_DEBTOR_CODE\s*=\s*'([^']+)'/.exec(src);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Column names of a table, or an empty set when the relation is absent. */
async function columnsOf(schema, table) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

/** The first candidate that exists, or null. Reported either way. */
function pickColumn(cols, candidates) {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

function capped(rows, label) {
  if (rows.length <= MAX_ROWS) return rows;
  warn(`${label}: ${rows.length} rows, printing the first ${MAX_ROWS} (raise MAX_ROWS to see them all)`);
  return rows.slice(0, MAX_ROWS);
}

/* TWO DIFFERENT QUESTIONS, and the first run of this census answered only the
   looser one — which is the more alarming of the two and the less actionable.

   LINKED = the ERP row and an AutoCount document are paired, by either witness:
   a `linked_ac_docno` on the row, or a `sent` outbox row naming it. That is
   mostly HISTORY. `import-ac-outstanding-po.mjs` populated `linked_ac_docno`
   for documents that ORIGINATED in AutoCount, where the book was the source of
   truth and the ERP copied the link — those cannot carry an ERP mapping error,
   because the ERP never chose the creditor.

   PUSHED = the ERP sent this document to the book, evidenced by a `sent` outbox
   row. This is the population where a wrong supplier code becomes a wrong
   posting, and it is the one to count when asking "how many more are wrong".

   Reporting only LINKED reads as 450 purchase orders at risk when the ERP
   authored a small fraction of them. Both are printed, side by side, and the
   difference is named wherever it appears. */
const reachedPo = (hasOutbox) => (hasOutbox
  ? sql`(po.linked_ac_docno IS NOT NULL AND btrim(po.linked_ac_docno) <> ''
         OR EXISTS (SELECT 1 FROM scm.autocount_outbox o
                     WHERE o.doc_type = 'PO' AND o.doc_no = po.po_number
                       AND o.status::text = 'sent'))`
  : sql`(po.linked_ac_docno IS NOT NULL AND btrim(po.linked_ac_docno) <> '')`);

const reachedSo = (hasOutbox) => (hasOutbox
  ? sql`(so.linked_ac_docno IS NOT NULL AND btrim(so.linked_ac_docno) <> ''
         OR EXISTS (SELECT 1 FROM scm.autocount_outbox o
                     WHERE o.doc_type = 'SO' AND o.doc_no = so.doc_no
                       AND o.status::text = 'sent'))`
  : sql`(so.linked_ac_docno IS NOT NULL AND btrim(so.linked_ac_docno) <> '')`);

/* FALSE, not "unknown", when there is no outbox: with no queue there is no push
   this script can evidence, and an unevidenced push must not read as one. */
const pushedPo = (hasOutbox) => (hasOutbox
  ? sql`EXISTS (SELECT 1 FROM scm.autocount_outbox o
                 WHERE o.doc_type = 'PO' AND o.doc_no = po.po_number
                   AND o.status::text = 'sent')`
  : sql`FALSE`);

const pushedSo = (hasOutbox) => (hasOutbox
  ? sql`EXISTS (SELECT 1 FROM scm.autocount_outbox o
                 WHERE o.doc_type = 'SO' AND o.doc_no = so.doc_no
                   AND o.status::text = 'sent')`
  : sql`FALSE`);

async function main() {
  notice('AutoCount party-code census — READ-ONLY. Diff each list against the book BY CODE.');
  out(`  run at        : ${new Date().toISOString()}`);
  out(`  company filter: ${ONLY_COMPANY}`);
  out(`  max rows/list : ${MAX_ROWS}`);

  const supCols = await columnsOf('scm', 'suppliers');
  const cusCols = await columnsOf('scm', 'customers');
  const poCols = await columnsOf('scm', 'purchase_orders');
  const soCols = await columnsOf('scm', 'mfg_sales_orders');
  const obCols = await columnsOf('scm', 'autocount_outbox');

  const supCode = pickColumn(supCols, ['code']);
  const cusCode = pickColumn(cusCols, ['customer_code', 'code']);

  out();
  out('=== RESOLVED SHAPE — nothing below is assumed ===');
  out(`  scm.suppliers        : ${supCols.size ? `${supCols.size} cols; code column = ${supCode ?? 'NOT FOUND'}; company_id = ${supCols.has('company_id')}` : 'TABLE ABSENT'}`);
  out(`  scm.customers        : ${cusCols.size ? `${cusCols.size} cols; code column = ${cusCode ?? 'NOT FOUND'}; company_id = ${cusCols.has('company_id')}` : 'TABLE ABSENT'}`);
  out(`  scm.purchase_orders  : ${poCols.size ? `${poCols.size} cols; linked_ac_docno = ${poCols.has('linked_ac_docno')}; supplier_id = ${poCols.has('supplier_id')}` : 'TABLE ABSENT'}`);
  out(`  scm.mfg_sales_orders : ${soCols.size ? `${soCols.size} cols; linked_ac_docno = ${soCols.has('linked_ac_docno')}; customer_id = ${soCols.has('customer_id')}` : 'TABLE ABSENT'}`);
  out(`  scm.autocount_outbox : ${obCols.size ? `${obCols.size} cols` : 'TABLE ABSENT'}`);

  const debtor = acDebtorCode();
  out();
  out('=== WHAT ACTUALLY REACHES THE BOOK, BY SIDE ===');
  out('  PURCHASE: readPoHeader sends scm.suppliers.code as CreditorCode, verbatim.');
  out('            /ensure-masters accepts any code the book already holds and never');
  out('            compares the CompanyName the ERP sent alongside it.');
  if (debtor) {
    out(`  SALES   : composeCreateSo sends the CONSTANT AC_DEBTOR_CODE = ${debtor}.`);
    out('            No per-customer code has ever been sent, so section 2 measures the');
    out('            ERP master only — not what AutoCount was told.');
  } else {
    warn('could not read AC_DEBTOR_CODE out of src/services/autocount-writeback.ts.');
    warn('The sales-side statement above is therefore UNVERIFIED on this run.');
  }

  if (!supCols.size && !cusCols.size) {
    notice('neither scm.suppliers nor scm.customers exists here — nothing to census.');
    return;
  }

  const companies = await sql`SELECT id, code, name FROM public.companies ORDER BY id`;
  const wanted = ONLY_COMPANY === 'all'
    ? companies
    : companies.filter((c) => String(c.id) === ONLY_COMPANY || c.code === ONLY_COMPANY);
  if (!wanted.length) {
    warn(`company filter "${ONLY_COMPANY}" matched none of: ${companies.map((c) => `${c.id}=${c.code}`).join(', ')}`);
    return;
  }

  const hasOutbox = obCols.size > 0;
  for (const co of wanted) {
    out();
    out('='.repeat(104));
    out(`COMPANY ${co.id} — ${co.code} (${co.name})`);
    out('='.repeat(104));
    await supplierSection(co, supCols, poCols, supCode, hasOutbox);
    await customerSection(co, cusCols, soCols, cusCode, hasOutbox);
    await noCodeSection(co, supCols, cusCols, supCode, cusCode);
    await documentSection(co, supCols, poCols, soCols, supCode, hasOutbox);
  }

  out();
  out('='.repeat(104));
  out('4. A CODE HELD BY MORE THAN ONE ERP RECORD  — cross-company, so it prints once');
  out('   Two ERP suppliers pointing at one AutoCount creditor is the same defect');
  out('   wearing a different hat. Grouped case-insensitively; the raw spellings are shown.');
  out('='.repeat(104));
  await duplicateSection(supCols, cusCols, supCode, cusCode);

  out();
  notice('census complete. Nothing was written. Match these lists against Creditor / Debtor BY CODE.');
}

async function supplierSection(co, supCols, poCols, supCode, hasOutbox) {
  out();
  out(`1. SUPPLIERS WITH AN AUTOCOUNT CREDITOR CODE  (scm.suppliers.${supCode ?? '?'})`);
  out('   diff against: SELECT AccNo, CompanyName FROM Creditor');
  if (!supCols.size) { out('   scm.suppliers ABSENT — skipped, not reported as zero.'); return; }
  if (!supCode) { out('   no code column resolved — skipped, not reported as zero.'); return; }

  const scoped = supCols.has('company_id');
  if (!scoped) warn('scm.suppliers has no company_id — the list below is every supplier, not this company\'s.');
  const byCo = scoped ? sql`AND s.company_id = ${co.id}` : ALWAYS();
  const canJoin = poCols.size > 0 && poCols.has('supplier_id') && poCols.has('linked_ac_docno');
  if (!canJoin) warn('scm.purchase_orders unusable — the usage columns below are absent, NOT measured as zero.');

  const rows = canJoin
    ? await sql`
        SELECT btrim(s.code) AS code, s.name AS name,
               count(po.id) AS po_all,
               count(po.id) FILTER (WHERE ${reachedPo(hasOutbox)}) AS po_ac,
               count(po.id) FILTER (WHERE ${pushedPo(hasOutbox)}) AS po_push
        FROM scm.suppliers s
        LEFT JOIN scm.purchase_orders po ON po.supplier_id = s.id
        WHERE nullif(btrim(s.code), '') IS NOT NULL ${byCo}
        GROUP BY s.id, s.code, s.name
        ORDER BY btrim(s.code), s.name`
    : await sql`
        SELECT btrim(s.code) AS code, s.name AS name,
               NULL AS po_all, NULL AS po_ac, NULL AS po_push
        FROM scm.suppliers s
        WHERE nullif(btrim(s.code), '') IS NOT NULL ${byCo}
        ORDER BY btrim(s.code), s.name`;

  const used = rows.filter((r) => Number(r.po_ac) > 0).length;
  const pushed = rows.filter((r) => Number(r.po_push) > 0).length;
  out(`   ${rows.length} supplier(s) with a code`
    + (canJoin
      ? `; ${used} linked to a purchase order in AutoCount, of which ${pushed} on a PO the ERP PUSHED.`
      : '; usage not measurable.'));
  if (canJoin) out('   PUSHED is the column that matters: a linked-only PO came FROM the book.');
  out();
  out(`   ${pad('CODE', 18)}${pad('ERP NAME', 54)}${pad('POs', 7)}${pad('LINKED', 9)}PUSHED`);
  out(rule(18, 54, 7, 9, 7));
  for (const r of capped(rows, 'suppliers with a code')) {
    const link = canJoin ? (Number(r.po_ac) > 0 ? String(r.po_ac) : '-') : '?';
    const push = canJoin ? (Number(r.po_push) > 0 ? `YES (${r.po_push})` : '-') : '?';
    out(`   ${pad(r.code, 18)}${pad(clip(r.name, 52), 54)}${pad(r.po_all ?? '?', 7)}${pad(link, 9)}${push}`);
  }
  if (!rows.length) out('   (none)');
}

async function customerSection(co, cusCols, soCols, cusCode, hasOutbox) {
  out();
  out(`2. CUSTOMERS WITH A CODE  (scm.customers.${cusCode ?? '?'})`);
  out('   diff against: SELECT AccNo, CompanyName FROM Debtor');
  out('   READ THE HEADER FIRST: this column is the ERP\'s own minted customer code.');
  out('   It is not an AutoCount debtor account and has never been sent to one.');
  if (!cusCols.size) { out('   scm.customers ABSENT — skipped, not reported as zero.'); return; }
  if (!cusCode) { out('   no code column resolved — skipped, not reported as zero.'); return; }

  const scoped = cusCols.has('company_id');
  if (!scoped) warn('scm.customers has no company_id — the list below is every customer, not this company\'s.');
  const byCo = scoped ? sql`AND c.company_id = ${co.id}` : ALWAYS();
  const canJoin = soCols.size > 0 && soCols.has('customer_id') && soCols.has('linked_ac_docno');
  if (!canJoin) warn('scm.mfg_sales_orders unusable — the usage columns below are absent, NOT measured as zero.');

  const rows = canJoin
    ? await sql`
        SELECT btrim(c.${sql(cusCode)}) AS code, c.name AS name,
               count(so.doc_no) AS so_all,
               count(so.doc_no) FILTER (WHERE ${reachedSo(hasOutbox)}) AS so_ac,
               count(so.doc_no) FILTER (WHERE ${pushedSo(hasOutbox)}) AS so_push
        FROM scm.customers c
        LEFT JOIN scm.mfg_sales_orders so ON so.customer_id = c.id
        WHERE nullif(btrim(c.${sql(cusCode)}), '') IS NOT NULL ${byCo}
        GROUP BY c.id, c.${sql(cusCode)}, c.name
        ORDER BY btrim(c.${sql(cusCode)}), c.name`
    : await sql`
        SELECT btrim(c.${sql(cusCode)}) AS code, c.name AS name,
               NULL AS so_all, NULL AS so_ac, NULL AS so_push
        FROM scm.customers c
        WHERE nullif(btrim(c.${sql(cusCode)}), '') IS NOT NULL ${byCo}
        ORDER BY btrim(c.${sql(cusCode)}), c.name`;

  const used = rows.filter((r) => Number(r.so_ac) > 0).length;
  const pushed = rows.filter((r) => Number(r.so_push) > 0).length;
  out(`   ${rows.length} customer(s) with a code`
    + (canJoin
      ? `; ${used} linked to a sales order in AutoCount, of which ${pushed} on an SO the ERP PUSHED.`
      : '; usage not measurable.'));
  out();
  out(`   ${pad('CODE', 18)}${pad('ERP NAME', 54)}${pad('SOs', 7)}${pad('LINKED', 9)}PUSHED`);
  out(rule(18, 54, 7, 9, 7));
  for (const r of capped(rows, 'customers with a code')) {
    const link = canJoin ? (Number(r.so_ac) > 0 ? String(r.so_ac) : '-') : '?';
    const push = canJoin ? (Number(r.so_push) > 0 ? `YES (${r.so_push})` : '-') : '?';
    out(`   ${pad(r.code, 18)}${pad(clip(r.name, 52), 54)}${pad(r.so_all ?? '?', 7)}${pad(link, 9)}${push}`);
  }
  if (!rows.length) out('   (none)');
}

async function noCodeSection(co, supCols, cusCols, supCode, cusCode) {
  out();
  out('3. RECORDS WITH NO CODE AT ALL — these cannot reach AutoCount');
  if (supCols.size && supCode) {
    const byCo = supCols.has('company_id') ? sql`AND s.company_id = ${co.id}` : ALWAYS();
    const rows = await sql`
      SELECT s.name AS name FROM scm.suppliers s
      WHERE nullif(btrim(coalesce(s.code, '')), '') IS NULL ${byCo}
      ORDER BY s.name`;
    out(`   suppliers with no code: ${rows.length}`);
    for (const r of capped(rows, 'suppliers with no code')) out(`     ${clip(r.name, 84)}`);
  } else {
    out('   suppliers: not measurable (table or code column absent).');
  }
  if (cusCols.size && cusCode) {
    const byCo = cusCols.has('company_id') ? sql`AND c.company_id = ${co.id}` : ALWAYS();
    const rows = await sql`
      SELECT c.name AS name FROM scm.customers c
      WHERE nullif(btrim(coalesce(c.${sql(cusCode)}, '')), '') IS NULL ${byCo}
      ORDER BY c.name`;
    out(`   customers with no code: ${rows.length}`);
    for (const r of capped(rows, 'customers with no code')) out(`     ${clip(r.name, 84)}`);
  } else {
    out('   customers: not measurable (table or code column absent).');
  }
}

async function documentSection(co, supCols, poCols, soCols, supCode, hasOutbox) {
  out();
  out('5. WHAT THE AUTOCOUNT-LINKED DOCUMENTS ACTUALLY CARRY');
  out('   Diff this one first: these are already in the book.');

  if (poCols.size && supCols.size && supCode && poCols.has('supplier_id') && poCols.has('linked_ac_docno')) {
    const byCo = poCols.has('company_id') ? sql`AND po.company_id = ${co.id}` : ALWAYS();
    const rows = await sql`
      SELECT po.po_number AS doc, po.linked_ac_docno AS ac,
             btrim(coalesce(s.code, '')) AS code, s.name AS name,
             (${pushedPo(hasOutbox)}) AS pushed
      FROM scm.purchase_orders po
      LEFT JOIN scm.suppliers s ON s.id = po.supplier_id
      WHERE ${reachedPo(hasOutbox)} ${byCo}
      ORDER BY (${pushedPo(hasOutbox)}) DESC, btrim(coalesce(s.code, '')), po.po_number`;
    const pushedRows = rows.filter((r) => r.pushed === true);
    out();
    out(`   PURCHASE ORDERS LINKED TO AUTOCOUNT: ${rows.length}`);
    out(`   of which the ERP PUSHED: ${pushedRows.length}. The rest came FROM the book`);
    out('   (import-ac-outstanding-po.mjs set the link), so the ERP never chose their creditor.');
    out('   PUSHED rows are listed first — those are the ones a wrong code mis-posts.');
    out(`   ${pad('PUSH', 6)}${pad('CREDITOR', 18)}${pad('ERP SUPPLIER NAME', 44)}${pad('ERP PO', 22)}AC DOC`);
    out(rule(6, 18, 44, 22, 12));
    for (const r of capped(rows, 'AutoCount-linked purchase orders')) {
      out(`   ${pad(r.pushed === true ? 'PUSH' : '-', 6)}${pad(r.code || '(none)', 18)}${pad(clip(r.name, 42), 44)}${pad(clip(r.doc, 20), 22)}${r.ac ?? '(outbox only)'}`);
    }
    if (!rows.length) out('   (none)');
  } else {
    out('   purchase orders: not measurable (table or column absent).');
  }

  if (soCols.size && soCols.has('debtor_code') && soCols.has('linked_ac_docno')) {
    const byCo = soCols.has('company_id') ? sql`AND so.company_id = ${co.id}` : ALWAYS();
    const rows = await sql`
      SELECT btrim(coalesce(so.debtor_code, '')) AS code,
             count(*) AS n,
             count(*) FILTER (WHERE ${pushedSo(hasOutbox)}) AS pushed
      FROM scm.mfg_sales_orders so
      WHERE ${reachedSo(hasOutbox)} ${byCo}
      GROUP BY btrim(coalesce(so.debtor_code, ''))
      ORDER BY 1`;
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    const totalPushed = rows.reduce((a, r) => a + Number(r.pushed), 0);
    out();
    out(`   SALES ORDERS LINKED TO AUTOCOUNT: ${total}, of which the ERP PUSHED: ${totalPushed}.`);
    out('   debtor_code values on the ERP rows:');
    out(`     ${pad('CODE', 18)}${pad('LINKED', 9)}PUSHED`);
    for (const r of rows) out(`     ${pad(r.code || '(empty)', 18)}${pad(r.n, 9)}${r.pushed}`);
    if (!rows.length) out('     (none)');
    out('     The ERP row\'s debtor_code is NOT what was sent — see the constant above.');
  } else {
    out('   sales orders: not measurable (table or column absent).');
  }
}

async function duplicateSection(supCols, cusCols, supCode, cusCode) {
  /* The subset that matters is not "one code, two rows" — the same supplier
     mirrored into both companies' books is expected and harmless. It is "one
     code, two DIFFERENT COMPANIES", because then the code cannot be right for
     both and one of them posts to a stranger. Names are compared with case,
     punctuation and whitespace removed, so `TODERN HOME SDN. BHD.` and
     `TODERN HOME SDN BHD` are the same company and are not flagged. */
  const NORM = (t) => sql`regexp_replace(upper(${t}), '[^A-Z0-9]', '', 'g')`;

  if (supCols.size && supCode) {
    const rows = await sql`
      SELECT upper(btrim(s.code)) AS key, count(*) AS n,
             count(DISTINCT ${NORM(sql`s.name`)}) AS distinct_names,
             string_agg(DISTINCT btrim(s.code), ' / ') AS variants,
             string_agg(s.name || ' [co ' || coalesce(s.company_id::text, '?') || ']', '  |  ') AS names
      FROM scm.suppliers s
      WHERE nullif(btrim(s.code), '') IS NOT NULL
      GROUP BY upper(btrim(s.code))
      HAVING count(*) > 1
      ORDER BY count(DISTINCT ${NORM(sql`s.name`)}) DESC, 1`;
    const clashes = rows.filter((r) => Number(r.distinct_names) > 1);
    out();
    out(`   SUPPLIERS — codes held by more than one row: ${rows.length},`);
    out(`   of which the rows name DIFFERENT companies: ${clashes.length}. Those are listed first`);
    out('   and marked; the rest are one supplier mirrored into both books.');
    for (const r of rows) {
      const mark = Number(r.distinct_names) > 1 ? '  << DIFFERENT COMPANIES' : '';
      out(`     ${pad(r.variants, 20)}x${r.n}${mark}`);
      out(`        ${clip(r.names, 150)}`);
    }
    if (!rows.length) out('     (none)');
  } else {
    out('   suppliers: not measurable (table or code column absent).');
  }

  if (cusCols.size && cusCode) {
    const rows = await sql`
      SELECT upper(btrim(c.${sql(cusCode)})) AS key, count(*) AS n,
             count(DISTINCT ${NORM(sql`c.name`)}) AS distinct_names,
             string_agg(DISTINCT btrim(c.${sql(cusCode)}), ' / ') AS variants,
             string_agg(c.name || ' [co ' || coalesce(c.company_id::text, '?') || ']', '  |  ') AS names
      FROM scm.customers c
      WHERE nullif(btrim(c.${sql(cusCode)}), '') IS NOT NULL
      GROUP BY upper(btrim(c.${sql(cusCode)}))
      HAVING count(*) > 1
      ORDER BY count(DISTINCT ${NORM(sql`c.name`)}) DESC, 1`;
    const clashes = rows.filter((r) => Number(r.distinct_names) > 1);
    out();
    out(`   CUSTOMERS — codes held by more than one row: ${rows.length},`);
    out(`   of which the rows name DIFFERENT people: ${clashes.length}.`);
    for (const r of rows) {
      const mark = Number(r.distinct_names) > 1 ? '  << DIFFERENT NAMES' : '';
      out(`     ${pad(r.variants, 20)}x${r.n}${mark}`);
      out(`        ${clip(r.names, 150)}`);
    }
    if (!rows.length) out('     (none)');
  } else {
    out('   customers: not measurable (table or code column absent).');
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    /* Non-zero is reserved for a database this script could not read. Every
       legitimate answer above — including "no rows" and "no such table" —
       exits 0, because a red job reads as "the check broke" and the answer here
       IS the output. */
    console.error(`census failed: ${e.message}`);
    try { await sql.end(); } catch { /* already closed */ }
    process.exit(1);
  });
