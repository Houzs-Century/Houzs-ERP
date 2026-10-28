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
     6. THE RECONCILIATION WORKSHEET — the deliverable. One row per ERP supplier
        that carries a code, BOTH companies together, sorted by code, as a
        markdown table with two EMPTY columns for the book's AccNo and
        CompanyName. It exists because the owner's instruction is 「全部 erp 的
        creditorcode 换跟 autocount 的一样」 and nothing can be changed until
        every pair has been established and approved one at a time. Section 1
        is the same population arranged for DIAGNOSIS, per company; this is the
        same population arranged for a HUMAN TO FILL IN.

   NOTHING IN SECTION 6 GUESSES A BOOK NAME, and it must never learn to. This
   script cannot reach AED_HOUZS. A fuzzy match between an ERP trading name and
   a book's registered name is exactly the reasoning that put HC-PO-2608-001 on
   HAO HUA FURNITURE, so the two book columns are left EMPTY on purpose and the
   owner fills them from the host's own
     SELECT AccNo, CompanyName FROM Creditor ORDER BY AccNo
   The three FLAGS section 6 does raise are computed from the ERP side ALONE —
   two ERP rows disagreeing with each other, a name carrying no registered-entity
   suffix, and a code whose letter is not the ERP name's initial. Each says
   "look here", none says what the answer is.

   IT ALSO SPELLS OUT THE CHANGE EACH ROW WOULD TAKE, AND DOES NOT RUN IT. A
   MATCH KEY column (upper-case, non-alphanumerics removed) so "the same name"
   is a stated rule rather than a judgement, and per row the four values the
   statement needs — id, company_id, the code as measured, and the AccNo still
   to be filled in. The statement itself is written out ONCE, in the comment on
   updatePlanSection, and never emitted as runnable text: audit:release-
   discipline failed this file the first time it was, and it was right to. A row
   whose code is on a document the ERP already PUSHED prints as BLOCKED instead —
   400-H004 is exactly that case and re-pointing it silently would orphan
   HC-PO-2608-001's link. NOTHING IN THIS SCRIPT WRITES, and nothing in it may
   learn to; the repair is a separate script with all four release-discipline
   parts, and it does not exist yet.

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
   Non-zero only for a missing DSN, a database this script could not read, or a
   SELF-TEST FAILURE — section 6's two matchers are checked against worked
   examples before the database is opened, and a matcher that cannot match must
   refuse to report rather than report a clean flag column. A verdict computed
   over nothing must never read as a pass.

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

/* ── SECTION 6's THREE FLAGS, and the self-test that has to pass first ──────
   Each flag is computed from the ERP side ALONE. None of them says what the
   right answer is; each says "a human has to look at this row". */

/** Case, punctuation and whitespace removed. `TODERN HOME SDN. BHD.` and
 *  `TODERN HOME SDN BHD` are the same company and must not read as a clash.
 *  Mirrors the SQL normaliser section 4 uses; section 6 re-checks its own
 *  clash set against section 4's and warns if the two ever disagree. */
const normName = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* THE BOOK USUALLY CARRIES THE FULL REGISTERED NAME and the ERP often carries
   what the office calls the supplier. A name with no registered-entity suffix
   is therefore the shape most likely to need a human's eye when it is lined up
   against `Creditor.CompanyName` — not because it is wrong, but because it
   cannot be matched by eye with any confidence.

   The list errs toward NOT flagging. A false positive costs the owner a row he
   did not need to look at; a false negative costs him nothing he was not going
   to check anyway, because every one of these 56 rows is getting read. */
const REGISTERED_SUFFIXES = [
  'SDNBHD', 'SENDIRIANBERHAD', 'BERHAD', 'BHD',
  'PLT', 'LLP', 'ENTERPRISE', 'TRADING',
  'PTELTD', 'COLTD', 'COMPANYLIMITED', 'LIMITED', 'LTD',
  'INC', 'CORPORATION', 'CORP', 'GMBH', 'PTY',
];
const looksLikeTradingName = (name) => {
  const n = normName(name);
  if (!n) return false;
  return !REGISTERED_SUFFIXES.some((suffix) => n.endsWith(suffix));
};

/* THE CODE'S LETTER IS PART OF THE CODE. Every AutoCount party account in this
   book is `<control>-<letter><nnn>`, and the letter is the company name's
   initial. That is an OBSERVED regularity in the data, not a rule this script
   knows AutoCount enforces — so the run prints how many rows obey it beside how
   many do not, and the reader judges the rule's strength from its own base rate
   rather than from this comment. A code whose letter is not the ERP name's
   initial is a row where the code and the name were probably never about the
   same company. */
const CODE_SHAPE = /^\d{3}-([A-Za-z])\d+$/;
const initialOf = (name) => {
  const m = /[A-Za-z]/.exec(String(name ?? ''));
  return m ? m[0].toUpperCase() : null;
};
/** true = agrees, false = disagrees, null = not measurable on this row. */
const codeLetterAgrees = (code, name) => {
  const m = CODE_SHAPE.exec(String(code ?? '').trim());
  const first = initialOf(name);
  if (!m || !first) return null;
  return m[1].toUpperCase() === first;
};

/* A CHECKER THAT CANNOT MATCH REPORTS A CLEAN RUN, and this repo has paid for
   that three times in one day. Both matchers above are checked against worked
   examples BEFORE the database is opened, and a failure refuses the whole run
   rather than printing an empty FLAGS column that reads as "nothing to look
   at". The fixtures are matcher tests, not data tests: they assert what the
   pattern does, so they keep their meaning when the supplier list changes. */
function selfTest() {
  const failures = [];
  const check = (label, got, want) => {
    if (got !== want) failures.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  for (const [name, want] of [
    ['ARMANI SOFA SDN. BHD.', false],
    ['NAKI SDN BHD', false],
    ['M&N FURNITURE TRADING SDN. BHD', false],
    ['DIGLANT MANUFACTURING SDN BHD.', false],
    ['RED SOFA PLT', false],
    ['LUCCA DESIGN ENTERPRISE', false],
    ['GUANGDONG DIGLANT FURNITURE INDUSTRIAL CO.LTD', false],
    ['NANTONG YOURUI TEXTILE CO., LTD.', false],
    ["JIAXING LEE'S TEXTILE CO LTD", false],
    ['GOLDEN MODERN SOFA', true],
    ['JIUWUYISAN FURNITURE (9513)', true],
    ['', false],
  ]) check(`looksLikeTradingName(${JSON.stringify(name)})`, looksLikeTradingName(name), want);

  for (const [code, name, want] of [
    ['400-A001', 'AEROFOAM BEDDING (1969) SDN BHD', true],
    ['400-D001', 'Dunlopillo (M) SDN BHD', true],
    ['405-N001', 'NANTONG YOURUI TEXTILE CO., LTD.', true],
    ['400-S002', 'VARIASI IMPIAN SDN BHD', false],
    ['400-M002', 'M&N FURNITURE TRADING SDN. BHD', true],
    ['not-a-code', 'ANYTHING SDN BHD', null],
    ['400-A001', '', null],
  ]) check(`codeLetterAgrees(${JSON.stringify(code)}, ${JSON.stringify(name)})`, codeLetterAgrees(code, name), want);

  check('normName folds punctuation',
    normName('TODERN HOME SDN. BHD.') === normName('TODERN HOME SDN BHD'), true);
  check('normName keeps different companies apart',
    normName('LUCCA DESIGN ENTERPRISE') === normName('LEATHERSOFA INDUSTRIES SDN BHD'), false);

  return failures;
}

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
  const clashKeys = await duplicateSection(supCols, cusCols, supCode, cusCode);

  await worksheetSection(supCols, poCols, supCode, hasOutbox, wanted, clashKeys);

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

/** Returns the set of UPPER-CASED supplier codes whose ERP rows name DIFFERENT
 *  companies. Section 6 recomputes the same set in JS from its own rows and
 *  warns if the two disagree — one rule, two implementations, checked against
 *  each other rather than trusted to stay in step. */
async function duplicateSection(supCols, cusCols, supCode, cusCode) {
  /* The subset that matters is not "one code, two rows" — the same supplier
     mirrored into both companies' books is expected and harmless. It is "one
     code, two DIFFERENT COMPANIES", because then the code cannot be right for
     both and one of them posts to a stranger. Names are compared with case,
     punctuation and whitespace removed, so `TODERN HOME SDN. BHD.` and
     `TODERN HOME SDN BHD` are the same company and are not flagged. */
  const NORM = (t) => sql`regexp_replace(upper(${t}), '[^A-Z0-9]', '', 'g')`;
  /* null = NOT MEASURED, which is a different answer from "measured, none".
     Section 6 says which of the two it got rather than printing zero clashes
     over a table it never read. */
  let supplierClashKeys = null;

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
    supplierClashKeys = new Set(clashes.map((r) => String(r.key)));
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
  return supplierClashKeys;
}

/* ── 6. THE RECONCILIATION WORKSHEET — the deliverable ─────────────────────
   Section 1 prints the same suppliers per company, arranged for diagnosis.
   This prints them arranged for a HUMAN TO FILL IN: both companies in one
   table, sorted by code so the rows line up against `Creditor` read in the
   same order, as markdown so it pastes into a PR, an issue or a spreadsheet
   without reformatting.

   THE LAST TWO COLUMNS ARE EMPTY AND STAY EMPTY. This script cannot reach
   AED_HOUZS. Guessing a book name from an ERP name is the exact reasoning that
   put HC-PO-2608-001 on HAO HUA FURNITURE, and a wrong "correction" books the
   documents to a third company. The owner pairs them; nothing here does. */
async function worksheetSection(supCols, poCols, supCode, hasOutbox, companies, clashKeys) {
  out();
  out('='.repeat(104));
  out('6. RECONCILIATION WORKSHEET  — one row per ERP supplier that carries a code');
  out('   Both companies, sorted by code. THE BOOK COLUMNS ARE EMPTY ON PURPOSE: fill them');
  out('   from the host with  SELECT AccNo, CompanyName FROM Creditor ORDER BY AccNo');
  out('   Nothing below infers, guesses or fuzzy-matches a book name.');
  out('='.repeat(104));
  out();
  out('   THE OWNER\'S RULE for what happens after this table is filled in:');
  out('     「把我们 ERP 里面的 creditor code 换成 AutoCount 的，如果你看到一样的名字就换」');
  out('     1. the name matches ONE creditor  -> set scm.suppliers.code to that AccNo');
  out('     2. the name matches NO creditor   -> leave it, list it. It may need a creditor');
  out('        opened in AutoCount first, which is the owner\'s decision, not a repair\'s.');
  out('     3. the name matches MORE THAN ONE -> leave it, list it. Picking one books the');
  out('        documents to a third company.');
  out('   NO REPAIR IS IN THIS SCRIPT and none may be added to it. This measures.');
  out();
  out('   "THE SAME NAME" IS A RULE, NOT A JUDGEMENT — the MATCH KEY column is that rule');
  out('   applied: upper-case, then every character that is not A-Z or 0-9 removed. So the');
  out('   book\'s `SDN. BHD.` equals the ERP\'s `SDN BHD`, `CO., LTD.` equals `CO LTD`, and');
  out('   `M&N` equals `MN`. Apply the SAME fold to Creditor.CompanyName and compare the two');
  out('   keys character for character. Nothing looser is a match: not a shared prefix, not');
  out('   a dropped suffix, not SENDIRIAN BERHAD against SDN BHD, not initials. Everything');
  out('   that is not character-identical after the fold belongs in bucket 2 or 3, by hand.');
  out('   It is the same fold section 4 runs in SQL and the same one AcSyncService.NormParty');
  out('   runs on the host, so all three agree by construction.');

  if (!supCols.size) { out('   scm.suppliers ABSENT — skipped, not reported as zero.'); return; }
  if (!supCode) { out('   no code column resolved — skipped, not reported as zero.'); return; }

  const scoped = supCols.has('company_id');
  if (!scoped) warn('scm.suppliers has no company_id — the CO column below is empty for every row.');
  const canJoin = poCols.size > 0 && poCols.has('supplier_id') && poCols.has('linked_ac_docno');
  if (!canJoin) warn('scm.purchase_orders unusable — POs / LINKED / PUSHED are "?" below, NOT zero.');

  const all = canJoin
    ? await sql`
        SELECT s.id AS id, s.company_id AS company_id, btrim(s.code) AS code, s.name AS name,
               count(po.id) AS po_all,
               count(po.id) FILTER (WHERE ${reachedPo(hasOutbox)}) AS po_ac,
               count(po.id) FILTER (WHERE ${pushedPo(hasOutbox)}) AS po_push
        FROM scm.suppliers s
        LEFT JOIN scm.purchase_orders po ON po.supplier_id = s.id
        WHERE nullif(btrim(s.code), '') IS NOT NULL
        GROUP BY s.id, s.company_id, s.code, s.name
        ORDER BY btrim(s.code), s.company_id, s.name`
    : await sql`
        SELECT s.id AS id, s.company_id AS company_id, btrim(s.code) AS code, s.name AS name,
               NULL AS po_all, NULL AS po_ac, NULL AS po_push
        FROM scm.suppliers s
        WHERE nullif(btrim(s.code), '') IS NOT NULL
        ORDER BY btrim(s.code), s.company_id, s.name`;

  /* Filtered in JS rather than in the WHERE clause so the CLASH set below is
     always computed over EVERY company — a code held by company 1 and company 2
     under two different names is still a clash when the run asks for only one
     of them, and hiding the other half would report it as clean. */
  const wantedIds = new Set(companies.map((c) => Number(c.id)));
  const rows = all.filter((r) => !scoped || wantedIds.has(Number(r.company_id)));

  /* The same rule section 4 ran in SQL, run here in JS over every row. The two
     are compared below; a disagreement is a finding, not something to bridge. */
  const byCode = new Map();
  for (const r of all) {
    const key = String(r.code ?? '').toUpperCase();
    if (!byCode.has(key)) byCode.set(key, new Set());
    byCode.get(key).add(normName(r.name));
  }
  const jsClashKeys = new Set([...byCode].filter(([, names]) => names.size > 1).map(([k]) => k));

  if (clashKeys == null) {
    warn('section 4 did not measure supplier clashes on this run, so the CLASH flag below is this section\'s own count only.');
  } else {
    const only4 = [...clashKeys].filter((k) => !jsClashKeys.has(k));
    const only6 = [...jsClashKeys].filter((k) => !clashKeys.has(k));
    if (only4.length || only6.length) {
      warn(`section 4 and section 6 disagree about which codes clash — 4 only: ${only4.join(', ') || '(none)'}; 6 only: ${only6.join(', ') || '(none)'}. One of the two normalisers is wrong; do not trust the FLAGS column until it is settled.`);
    }
  }

  /* One ERP company under two different codes. Not asked for and not a clash —
     it can be legitimate — but it is the other half of the same question and it
     is free to compute here. Exact normalised name only; no fuzzy matching. */
  const byName = new Map();
  for (const r of all) {
    const key = normName(r.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(String(r.code ?? '').toUpperCase());
  }
  const multiCoded = [...byName].filter(([, codes]) => codes.size > 1);

  const flagsOf = (r) => {
    const f = [];
    if (jsClashKeys.has(String(r.code ?? '').toUpperCase())) f.push('CLASH');
    if (looksLikeTradingName(r.name)) f.push('SHORT');
    if (codeLetterAgrees(r.code, r.name) === false) f.push('LETTER');
    return f;
  };

  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|');
  const printed = capped(rows, 'reconciliation worksheet');
  out();
  out('| CODE | CO | ERP SUPPLIER NAME | MATCH KEY | POs | LINKED | PUSHED | FLAGS | BOOK AccNo | BOOK CompanyName |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of printed) {
    const link = canJoin ? (Number(r.po_ac) > 0 ? String(r.po_ac) : '-') : '?';
    const push = canJoin ? (Number(r.po_push) > 0 ? `YES (${r.po_push})` : '-') : '?';
    const pos = canJoin ? String(r.po_all ?? 0) : '?';
    out(`| ${cell(r.code)} | ${cell(r.company_id ?? '')} | ${cell(r.name)} | ${cell(normName(r.name))} | ${pos} | ${link} | ${push} | ${flagsOf(r).join(' ')} | | |`);
  }
  if (!rows.length) out('| (none) | | | | | | | | | |');

  const companyLabel = companies.map((c) => `${c.id}=${c.code}`).join(', ');
  out();
  out(`   ${rows.length} row(s). CO: ${companyLabel}.`);
  out('   LINKED = an AutoCount document is paired with the ERP row. PUSHED = the ERP sent it,');
  out('   and PUSHED is the column a wrong code actually mis-posts.');

  /* THE FLAGS ARE POINTERS, NOT VERDICTS, and each one prints its own base rate
     so the reader can see how much the flag is worth on this data rather than
     taking a comment's word for it. */
  const clashed = rows.filter((r) => flagsOf(r).includes('CLASH'));
  const shortNamed = rows.filter((r) => flagsOf(r).includes('SHORT'));
  const measurableLetter = rows.filter((r) => codeLetterAgrees(r.code, r.name) !== null);
  const letterOff = measurableLetter.filter((r) => codeLetterAgrees(r.code, r.name) === false);

  out();
  out('   FLAGS — each says "a human has to look at this row". None says what the answer is.');
  out();
  out(`   CLASH  (${clashed.length} row(s)) — this code is held by ERP rows naming DIFFERENT`);
  out('          companies, so it cannot be right for both. One of them posts to a stranger.');
  for (const key of [...jsClashKeys].sort()) {
    const holders = all.filter((r) => String(r.code ?? '').toUpperCase() === key);
    out(`          ${pad(key, 12)}${holders.map((h) => `${h.name} [co ${h.company_id ?? '?'}]`).join('   |   ')}`);
  }
  if (!jsClashKeys.size) out('          (none)');

  out();
  out(`   SHORT  (${shortNamed.length} of ${rows.length}) — the ERP name carries no registered-entity`);
  out('          suffix (SDN BHD, BHD, PLT, ENTERPRISE, TRADING, LTD, CO LTD, ...), and the book');
  out('          usually holds the full registered name. Not wrong — unmatchable by eye.');
  for (const r of shortNamed) out(`          ${pad(r.code, 12)}${r.name} [co ${r.company_id ?? '?'}]`);
  if (!shortNamed.length) out('          (none)');

  out();
  out(`   LETTER (${letterOff.length} of ${measurableLetter.length} measurable) — the code's letter is not the ERP`);
  out(`          name's initial. ${measurableLetter.length - letterOff.length} of ${measurableLetter.length} rows DO agree, which is the base rate that`);
  out('          makes the exceptions worth reading. It is an observed regularity in this data,');
  out('          not a rule this script knows AutoCount enforces.');
  for (const r of letterOff) out(`          ${pad(r.code, 12)}${r.name} [co ${r.company_id ?? '?'}]`);
  if (!letterOff.length) out('          (none)');

  out();
  out(`   ALSO — one ERP company name under more than one code: ${multiCoded.length}.`);
  out('          Not a clash and possibly legitimate; listed because it is the mirror image');
  out('          of CLASH and the owner is pairing both directions in one pass.');
  for (const [nameKey, codes] of multiCoded) {
    const holders = all.filter((r) => normName(r.name) === nameKey);
    out(`          ${[...codes].sort().join(' / ')}  ${holders.map((h) => `${h.name} [co ${h.company_id ?? '?'}]`).join('   |   ')}`);
  }
  if (!multiCoded.length) out('          (none)');

  updatePlanSection(printed, canJoin);
}

/* THE WRITE, SPELLED OUT AND NOT RUN — AND NOT EMITTED AS SQL EITHER.
   Printing what each row would need makes the review concrete and makes the
   eventual repair a COPY of something a human already read, instead of fresh
   reasoning applied to production at 2am.

   IT IS PRINTED AS PARAMETERS, NOT AS A STATEMENT, and that is the check
   working rather than a compromise. `audit:release-discipline` scans every
   backend/scripts/*.mjs that opens a database for a SQL write verb, and it
   FAILED this file the first time the per-row `UPDATE ... SET` was emitted as
   text. It was right to: a read-only diagnostic that hands you 56 ready-to-run
   write statements is one paste away from being a repair with none of the four
   parts, and shaping the string to slip past the matcher would forge exactly
   the evidence that gate exists to produce. So the statement lives ONCE, in the
   comment below where it cannot execute, and each row prints the four values
   that fill it in.

     UPDATE scm.suppliers
        SET code = :new_accno
      WHERE id = :id
        AND company_id = :co
        AND btrim(code) = :code_now;

   THAT PREDICATE IS A COMPARE-AND-SWAP, deliberately. `id` alone would hit the
   row and is not enough to be safe: `company_id` belongs on the write because
   in this schema the predicate IS the tenant boundary (the SCM client is
   service-role and bypasses RLS), and `btrim(code) = :code_now` means a row
   somebody has already re-coded updates ZERO rows instead of being clobbered by
   a plan taken before their change.

   A ROW ON A PUSHED DOCUMENT IS NOT OFFERED AT ALL. 400-H004 is exactly that
   case: HC-PO-2608-001 is in the book against it, and re-pointing the code
   without a person deciding what happens to that document orphans the link. The
   line prints as BLOCKED so it is visible rather than missing. */
function updatePlanSection(rows, canJoin) {
  out();
  out('   WHAT EACH ROW WOULD NEED — PARAMETERS ONLY. Nothing here is executed, and this');
  out('   script emits no runnable write SQL by design (audit:release-discipline, and the');
  out('   comment above this function). The one statement they fill in is in that comment.');
  out('     new_accno = the BOOK AccNo column above, still empty');
  out('     code_now  = the code as measured on this run, so a row someone else has already');
  out('                 re-coded updates ZERO rows instead of being clobbered');
  out('   A row whose name lands in bucket 2 or 3 has no change to make at all. Delete its');
  out('   line rather than inventing an AccNo for it.');
  out();
  out(`   ${pad('', 9)}${pad('CO', 4)}${pad('CODE_NOW', 12)}${pad('NEW_ACCNO', 12)}${pad('ID', 40)}ERP NAME`);
  for (const r of rows) {
    if (canJoin && Number(r.po_push) > 0) {
      out(`   ${pad('BLOCKED', 9)}${pad(r.company_id ?? '?', 4)}${pad(r.code, 12)}`
        + `${Number(r.po_push)} PUSHED document(s) in the book — re-pointing orphans their link, a person decides first`);
      continue;
    }
    out(`   ${pad('PLAN', 9)}${pad(r.company_id ?? '?', 4)}${pad(r.code, 12)}${pad('<AccNo>', 12)}${pad(r.id, 40)}${r.name}`);
  }
  if (!rows.length) out('   (no rows)');
  out();
  out('   WHEN SOMEONE BUILDS THAT REPAIR it is a backend/scripts WRITE and carries all four');
  out('   release-discipline parts: a MODE/APPLY gate defaulting to plan, a CONFIRM phrase on');
  out('   the apply path, a verification that re-reads on a FRESH connection and asserts the');
  out('   SHAPE (a row count is not a shape), and a RE-RUN: line in its header. It must also');
  out('   refuse, loudly, to touch any supplier whose code is on a document already pushed.');
}

/* BEFORE THE DATABASE IS OPENED. A matcher that cannot match reports a clean
   run, so section 6's two patterns are checked against worked examples first
   and a failure refuses the whole report rather than printing an empty FLAGS
   column that reads as "nothing to look at here". */
const selfTestFailures = selfTest();
if (selfTestFailures.length) {
  console.error('section 6 matcher self-test FAILED — refusing to report a flag column computed from a dead pattern:');
  for (const f of selfTestFailures) console.error(`  ${f}`);
  process.exit(2);
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
