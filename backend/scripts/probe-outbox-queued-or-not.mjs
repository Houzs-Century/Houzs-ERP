#!/usr/bin/env node
// READ-ONLY. "Did this document ever get an outbox row?" — answered in COUNTS
// AND BOOLEANS ONLY, so the answer is safe to read in a PUBLIC Actions log.
//
// WHY A SECOND SCRIPT AND NOT why-no-outbox-row.mjs. That one answers the same
// question and answers it well, but it prints every document NUMBER and every
// skip reason verbatim — and `last_error` on a refusal quotes real item codes.
// THIS REPOSITORY IS PUBLIC, ACTIONS LOGS INCLUDED, so that script can only be
// run when the owner has decided the exposure is acceptable. This one is
// written so that decision never has to be made: it emits statuses, ops,
// booleans and counts, and NOTHING that names a customer, a document, an item
// or an amount. A document is identified by the PARAMETERS you dispatch with
// (company, window) and, within the window, by an ORDINAL — "the newest one",
// "the second newest" — never by its number.
//
// THE QUESTION IT EXISTS FOR (owner, 2026-08-19): the queue health report
// itemises PENDING, FAILED and SKIPPED rows and prints `sent` only as a total.
// So for a document that is not in the failure list, "it is one of the sent
// ones" and "it never got a row at all" are indistinguishable — and those are
// opposite facts. The second is strictly worse: a failure at least leaves a
// record, while a document that was never offered is invisible in BOTH systems.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no writes, no transaction.
// Idempotent and side-effect free; re-run it as often as you like.
//
//   COMPANY_ID=1 DAYS=3 node backend/scripts/probe-outbox-queued-or-not.mjs
//
// SINCE defaults to the write-back switch's own `updated_at`, because a
// document saved before the switch moved CANNOT have a row (every enqueue
// returns early while the flag is off — autocount-outbox.ts enqueueAcOp) and
// counting those as "never queued" would drown the real class in cutover noise.
// DAYS overrides it with a plain window when you want a narrower one.
//
// ENUM TRAP (inherited from the other audits here): the document status columns
// are ENUMS, so COALESCE(col,'') coerces '' INTO the enum and throws. Every
// status is read ::text first.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const DAYS = process.env.DAYS ? Number(process.env.DAYS) : null;
/* How many of the newest documents get their own boolean line in section E.
   Small on purpose: an ordinal list is only readable while it is short, and the
   census in C/D is what answers the general question. */
const RECENT = Math.min(Number(process.env.RECENT || 10), 50);

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const iso = (d) => (d?.toISOString?.() ?? (d == null ? '(null)' : String(d)));
const yn = (b) => (b ? 'yes' : 'no');

/**
 * The six ERP document tables and the op(s) that that document's OWN creation
 * should have produced. Mirrors why-no-outbox-row.mjs — deliberately the same
 * table, because two censuses that disagree about which op belongs to which
 * document type would be worse than one.
 *
 * `docType` rather than a doc_no lookup: scm.sales_invoices and
 * scm.purchase_invoices BOTH number in `invoice_number`, so matching on doc_no
 * alone would cross-wire an IV with a PI.
 */
const DOCS = [
  { label: 'Sales orders', table: 'mfg_sales_orders', idCol: 'doc_no', noCol: 'doc_no', docType: 'SO', chainOps: ['create_so'] },
  { label: 'Purchase orders', table: 'purchase_orders', idCol: 'id', noCol: 'po_number', docType: 'PO', chainOps: ['create_po', 'so_to_po'] },
  { label: 'Delivery orders', table: 'delivery_orders', idCol: 'id', noCol: 'do_number', docType: 'DO', chainOps: ['so_to_do'] },
  { label: 'Goods received notes', table: 'grns', idCol: 'id', noCol: 'grn_number', docType: 'GR', chainOps: ['po_to_gr'] },
  { label: 'Sales invoices', table: 'sales_invoices', idCol: 'id', noCol: 'invoice_number', docType: 'IV', chainOps: ['do_to_iv'] },
  { label: 'Purchase invoices', table: 'purchase_invoices', idCol: 'id', noCol: 'invoice_number', docType: 'PI', chainOps: ['gr_to_pi'] },
];

/** Which of a table's columns exist, so an optional one is read rather than
 *  guessed. mig 0305 renamed every `_centi` money column to `_sen`, so the
 *  money column is resolved and not assumed. */
async function columnsOf(table) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

/** A — the switch, and when it last moved. The VALUE is a scope list, not a
 *  secret, and it is the first gate every enqueue hits. */
async function dumpSwitch() {
  notice('A — the write-back switch (scm.app_config)');
  const rows = await sql`
    SELECT value, updated_at FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
  if (!rows.length) {
    notice('  ROW ABSENT -> the flag parser fails CLOSED. Nothing is queued for any company.');
    return null;
  }
  const raw = String(rows[0].value ?? '').trim().toLowerCase();
  /* Same grammar as autocount-writeback-flag.ts: 'all', or a comma-separated
     company id list. Anything else — including a stray space — is OFF. */
  const on = raw === 'all' || /^[0-9]+(\s*,\s*[0-9]+)*$/.test(raw);
  const mine = raw === 'all' || raw.split(',').map((s) => s.trim()).includes(String(COMPANY_ID));
  notice(`  value=${JSON.stringify(rows[0].value)} -> ${on ? 'ON' : 'OFF'}; for company ${COMPANY_ID}: ${mine ? 'ON' : 'OFF'}`);
  notice(`  last changed: ${iso(rows[0].updated_at)}`);
  notice('  A DOCUMENT SAVED BEFORE THAT TIMESTAMP CANNOT HAVE A ROW — every enqueue returns');
  notice('  early while the flag is off and writes nothing. The row keeps only its LATEST');
  notice('  value, so this BOUNDS the answer, it does not prove it.');
  return rows[0].updated_at ?? null;
}

/** B — the outbox, as counts. No document is named. */
async function dumpCensus() {
  console.log('');
  notice(`B — scm.autocount_outbox for company ${COMPANY_ID}, counted by doc type / op / status`);
  const counts = await sql`
    SELECT doc_type, op, status::text AS status, count(*)::int AS n
      FROM scm.autocount_outbox WHERE company_id = ${COMPANY_ID}
     GROUP BY doc_type, op, status ORDER BY doc_type, op, status`;
  const total = counts.reduce((a, r) => a + r.n, 0);
  notice(`  ${total} row(s) total`);
  if (!total) {
    notice('  EMPTY. The table is append-only, so empty means NOTHING WAS EVER ENQUEUED for');
    notice('  this company — not "drained". Read that against the switch in section A.');
  }
  console.log('');
  console.log(`${pad('TYPE', 5)} ${pad('OP', 12)} ${pad('STATUS', 9)} N`);
  for (const r of counts) console.log(`${pad(r.doc_type, 5)} ${pad(r.op, 12)} ${pad(r.status, 9)} ${r.n}`);
}

/**
 * The outbox rows for one doc type, keyed by BOTH doc_no and doc_id.
 *
 * doc_id is the second chance: a document renumbered after enqueue would
 * otherwise read as never-queued, and that is the one wrong answer this script
 * must not give.
 */
async function outboxIndexFor(docType) {
  const rows = await sql`
    SELECT doc_no, doc_id, op, status::text AS status
      FROM scm.autocount_outbox
     WHERE company_id = ${COMPANY_ID} AND doc_type = ${docType}`;
  const byNo = new Map();
  const byId = new Map();
  for (const r of rows) {
    if (!byNo.has(r.doc_no)) byNo.set(r.doc_no, []);
    byNo.get(r.doc_no).push(r);
    if (r.doc_id) {
      const k = String(r.doc_id);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(r);
    }
  }
  return { byNo, byId };
}

/**
 * The single word for a document's chain rows.
 *
 * ORDER MATTERS AND IT IS NOT ALPHABETICAL: `sent` beats everything, because a
 * document that reached AutoCount once is in the account book no matter how
 * many refusals preceded it. That is exactly the confusion this whole probe
 * exists to remove — the failed rows for the owner's first two orders are the
 * RECORD of refusals that were later re-queued and sent.
 */
function verdictOf(rows) {
  if (!rows.length) return 'NO-ROW';
  if (rows.some((r) => r.status === 'sent')) return 'sent';
  if (rows.some((r) => r.status === 'pending')) return 'pending';
  if (rows.some((r) => r.status === 'failed')) return 'failed';
  if (rows.some((r) => r.status === 'skipped')) return 'skipped';
  return 'other';
}

/** C — per document type, the coverage census over the window. Counts only. */
async function dumpCoverage(spec, since) {
  const cols = await columnsOf(spec.table);
  if (!cols.size) { notice(`  scm.${spec.table} does not exist — skipped`); return null; }
  if (!cols.has('company_id')) {
    notice(`  scm.${spec.table} has NO company_id — cannot scope, skipped rather than reported wrong`);
    return null;
  }
  const hasStatus = cols.has('status');
  const hasCreated = cols.has('created_at');
  const hasLinked = cols.has('linked_ac_docno');
  if (!hasCreated) {
    notice(`  scm.${spec.table} has NO created_at — the window cannot be applied, so this type is`);
    notice('  reported over EVERY row instead. Say so rather than silently widen it.');
  }
  if (!hasLinked) notice(`  scm.${spec.table} has NO linked_ac_docno — mig 0277 should have added it; report this`);

  const docs = await sql`
    SELECT ${sql(spec.idCol)} AS row_id,
           ${sql(spec.noCol)} AS doc_no,
           ${hasStatus ? sql`status::text` : sql`NULL::text`} AS status,
           ${hasCreated ? sql`created_at` : sql`NULL::timestamptz`} AS created_at,
           ${hasLinked ? sql`linked_ac_docno` : sql`NULL::text`} AS linked_ac_docno
      FROM scm.${sql(spec.table)}
     WHERE company_id = ${COMPANY_ID}
       ${hasCreated && since ? sql`AND created_at >= ${since}` : sql`AND true`}`;

  const { byNo, byId } = await outboxIndexFor(spec.docType);
  /* status -> verdict -> n. The document's own status is on the axis because
     "no row" is CORRECT for a DRAFT (the enqueue sits behind an asDraft gate)
     and a defect for a live one, and folding the two together would hide it. */
  const grid = new Map();
  const bump = (k) => grid.set(k, (grid.get(k) ?? 0) + 1);
  let cutover = 0;
  const naked = [];
  for (const d of docs) {
    const rows = byNo.get(d.doc_no) ?? byId.get(String(d.row_id)) ?? [];
    const chain = rows.filter((r) => spec.chainOps.includes(r.op));
    /* A cutover-imported document ALREADY exists in AutoCount, and both
       enqueueSoCreate and enqueuePoCreate bail on a populated linked_ac_docno
       ON PURPOSE — creating it again would duplicate it in the live book. It
       is counted on its own line rather than left in "no row", where it would
       be the overwhelming majority and would bury the real class. */
    const isCutover = !chain.length && !!d.linked_ac_docno;
    if (isCutover) { cutover += 1; continue; }
    const v = verdictOf(chain);
    bump(`${d.status ?? '(n/a)'} ${v} ${rows.length && !chain.length ? 'other-ops-only' : ''}`);
    if (v === 'NO-ROW') naked.push(d);
  }

  console.log('');
  notice(`C${spec.docType} — ${spec.label}: ${docs.length} document(s) in the window`);
  notice(`  ${cutover} carry a linked_ac_docno and no chain row -> cutover-imported, correctly never queued`);
  console.log(`${pad('DOC STATUS', 16)} ${pad('CHAIN ROW', 10)} ${pad('OTHER OPS', 15)} N`);
  for (const [k, n] of [...grid.entries()].sort()) {
    const [st, v, other] = k.split(' ');
    console.log(`${pad(st, 16)} ${pad(v, 10)} ${pad(other || '-', 15)} ${n}`);
  }
  return { spec, docs, naked, byNo, byId };
}

/**
 * D — THE SHAPE QUESTION, for sales orders only.
 *
 * A zero-value, all-lines-FOC order is exactly the shape a "nothing to invoice"
 * shortcut would skip, so it gets its own cross-tab: does an order with no
 * billable value queue like any other, or does it silently not?
 *
 * NO AMOUNT IS PRINTED — only the boolean "the grand total is zero" and "every
 * live line carries a zero unit price". Both are properties of the SHAPE, not
 * figures from a customer's order.
 */
async function dumpSoShape(coverage, cols) {
  if (!coverage) return null;
  const totalCol = cols.has('total_revenue_sen') ? 'total_revenue_sen'
    : cols.has('total_revenue_centi') ? 'total_revenue_centi' : null;
  const itemCols = await columnsOf('mfg_sales_order_items');
  const priceCol = itemCols.has('unit_price_sen') ? 'unit_price_sen'
    : itemCols.has('unit_price_centi') ? 'unit_price_centi' : null;
  console.log('');
  notice('D — sales orders in the window by SHAPE (booleans only; no amount is printed)');
  if (!totalCol || !priceCol) {
    console.log('::error::SECTION D CANNOT RUN — the money column could not be resolved '
      + `(header=${totalCol ?? 'MISSING'}, line=${priceCol ?? 'MISSING'}). `
      + 'This part of the answer is MISSING, not empty.');
    return null;
  }
  notice(`  money columns resolved: header ${totalCol}, line ${priceCol}`);

  const docNos = coverage.docs.map((d) => String(d.doc_no));
  if (!docNos.length) { notice('  no sales orders in the window'); return null; }
  /* An IN list is bounded, and a section that quietly answered over a PREFIX of
     the window would be the same lie as a health script that hides `sent`. Say
     so and stop rather than narrow the question without saying. */
  if (docNos.length > 2000) {
    console.log(`::error::SECTION D CANNOT RUN — ${docNos.length} sales orders in the window is `
      + 'past the 2000-row IN-list cap. Narrow it with the `days` input and re-dispatch. '
      + 'This part of the answer is MISSING, not empty.');
    return null;
  }
  const lineFacts = await sql`
    SELECT doc_no,
           count(*)::int                                              AS n_lines,
           count(*) FILTER (WHERE coalesce(${sql(priceCol)}, 0) <> 0)::int AS n_priced
      FROM scm.mfg_sales_order_items
     WHERE doc_no IN ${sql(docNos)}
       ${itemCols.has('cancelled') ? sql`AND coalesce(cancelled, false) = false` : sql`AND true`}
     GROUP BY doc_no`;
  const byDoc = new Map(lineFacts.map((r) => [r.doc_no, r]));

  const totals = await sql`
    SELECT doc_no, coalesce(${sql(totalCol)}, 0) = 0 AS zero_total
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY_ID} AND doc_no IN ${sql(docNos)}`;
  const zeroByDoc = new Map(totals.map((r) => [r.doc_no, r.zero_total]));

  const grid = new Map();
  for (const d of coverage.docs) {
    const rows = coverage.byNo.get(d.doc_no) ?? coverage.byId.get(String(d.row_id)) ?? [];
    const chain = rows.filter((r) => r.op === 'create_so');
    if (!chain.length && d.linked_ac_docno) continue; // cutover, counted in C
    const lf = byDoc.get(String(d.doc_no));
    const key = [
      d.status ?? '(n/a)',
      `zeroTotal=${yn(zeroByDoc.get(String(d.doc_no)) === true)}`,
      `allLinesZeroPrice=${yn(!!lf && lf.n_lines > 0 && lf.n_priced === 0)}`,
      verdictOf(chain),
    ].join(' ');
    grid.set(key, (grid.get(key) ?? 0) + 1);
  }
  console.log('');
  console.log(`${pad('DOC STATUS', 16)} ${pad('ZERO TOTAL', 16)} ${pad('ALL LINES RM0', 24)} ${pad('create_so', 10)} N`);
  for (const [k, n] of [...grid.entries()].sort()) {
    const [st, zt, az, v] = k.split(' ');
    console.log(`${pad(st, 16)} ${pad(zt, 16)} ${pad(az, 24)} ${pad(v, 10)} ${n}`);
  }
  return { byDoc, zeroByDoc };
}

/**
 * E — the newest sales orders, ONE LINE EACH, by ORDINAL.
 *
 * This is what answers "did the one he just saved queue". It is safe in a
 * public log because the only identifiers are the ordinal and the dispatch
 * parameters: #1 is the newest sales order in this company in this window, and
 * whoever dispatched the run is the person who knows which order that is.
 */
function dumpRecent(coverage, shape) {
  if (!coverage) return;
  console.log('');
  notice(`E — the ${RECENT} newest sales orders in the window, by ordinal. No document is named.`);
  notice('  #1 is the newest. "outbox" is every row this document has, op/status, chain ops first.');
  const sorted = [...coverage.docs].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  }).slice(0, RECENT);
  console.log('');
  console.log(`${pad('#', 4)} ${pad('CREATED', 22)} ${pad('DOC STATUS', 16)} ${pad('LINES', 6)} `
    + `${pad('ZERO TOTAL', 11)} ${pad('ALL RM0', 8)} ${pad('LINKED_AC', 10)} OUTBOX ROWS`);
  sorted.forEach((d, i) => {
    const rows = coverage.byNo.get(d.doc_no) ?? coverage.byId.get(String(d.row_id)) ?? [];
    const lf = shape?.byDoc?.get(String(d.doc_no));
    const summary = rows.length
      ? rows.map((r) => `${r.op}/${r.status}`).sort().join(' + ')
      : '*** NO OUTBOX ROW AT ALL ***';
    console.log(`${pad(`#${i + 1}`, 4)} ${pad(iso(d.created_at), 22)} ${pad(d.status ?? '(n/a)', 16)} `
      + `${pad(lf ? lf.n_lines : '?', 6)} `
      + `${pad(shape ? yn(shape.zeroByDoc.get(String(d.doc_no)) === true) : '?', 11)} `
      + `${pad(lf ? yn(lf.n_lines > 0 && lf.n_priced === 0) : '?', 8)} `
      + `${pad(d.linked_ac_docno ? 'yes' : 'no', 10)} ${summary}`);
  });
}

/** F — the silent class, across all six types, as one number per type. */
function dumpSilent(all) {
  console.log('');
  console.log('================================================================');
  notice('F — DOCUMENTS WITH NO CHAIN-OP ROW AND NO AUTOCOUNT LINK');
  console.log('================================================================');
  notice('  These exist in the ERP and the ERP never even ASKED AutoCount about them.');
  notice('  There is no failed row, no skip reason and no error text for any of them.');
  notice('  A DRAFT among them is the DESIGNED behaviour (the enqueue sits behind an');
  notice('  asDraft gate and confirm is what queues it), so the split by status is the');
  notice('  answer, not the total. They are counted, never filtered: deciding for the');
  notice('  reader which absence is legitimate is how a real one gets hidden.');
  console.log('');
  console.log(`${pad('TYPE', 5)} ${pad('DOC STATUS', 18)} N`);
  let grand = 0;
  for (const cov of all) {
    if (!cov) continue;
    const by = new Map();
    for (const d of cov.naked) {
      const k = String(d.status ?? '(n/a)');
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...by.entries()].sort()) {
      console.log(`${pad(cov.spec.docType, 5)} ${pad(k, 18)} ${n}`);
      grand += n;
    }
    if (!by.size) console.log(`${pad(cov.spec.docType, 5)} ${pad('(none)', 18)} 0`);
  }
  notice(`  TOTAL with no chain row and no AutoCount link, in the window: ${grand}`);
}

/**
 * Run one section, and make a section that DID NOT RUN impossible to read as a
 * clean one. A bare try/catch that carried on would turn a broken section into
 * silence, and silence here looks exactly like "nothing to report".
 */
async function section(name, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    console.log(`::error::SECTION ${name} COULD NOT RUN — ${e?.message ?? e}. `
      + 'Everything else is still true; this part of the answer is MISSING, not empty.');
    console.error(e);
    return fallback;
  }
}

async function main() {
  notice(`company ${COMPANY_ID} — READ ONLY, SELECTs only. Counts and booleans only: no document`);
  notice('number, customer, address or amount is printed, because this log is PUBLIC.');
  const switchedAt = await section('A (the switch)', dumpSwitch, null);
  const since = DAYS != null
    ? new Date(Date.now() - DAYS * 86_400_000)
    : (switchedAt ? new Date(switchedAt) : null);
  notice(`  WINDOW: documents created on or after ${since ? iso(since) : '(no bound — every row)'}`
    + `${DAYS != null ? ` (DAYS=${DAYS})` : ' (the switch\'s own updated_at)'}`);

  await section('B (the outbox census)', dumpCensus, null);

  const all = [];
  for (const spec of DOCS) {
    all.push(await section(`C${spec.docType} (${spec.label})`, () => dumpCoverage(spec, since), null));
  }
  const soCov = all[0];
  const soCols = await section('D prep (SO columns)', () => columnsOf('mfg_sales_orders'), new Set());
  const shape = await section('D (the SO shape cross-tab)', () => dumpSoShape(soCov, soCols), null);
  await section('E (the newest orders, by ordinal)', () => dumpRecent(soCov, shape), null);
  await section('F (the silent class)', () => dumpSilent(all), null);

  console.log('');
  notice('G — HOW TO READ THIS');
  notice('  A chain row of `sent` means the document IS in the account book, even if the same');
  notice('  document also carries failed or skipped rows — those are the record of refusals');
  notice('  that were later re-queued. `sent` therefore wins in every verdict above.');
  notice('  NO-ROW is the silent class: nothing failed, because nothing was ever asked.');
  notice('  The gates that write NOTHING are, in source:');
  notice('    autocount-outbox.ts enqueueAcOp     — companyId null, or the write-back flag off');
  notice('    autocount-outbox.ts enqueueSoCreate — header unreadable, or a populated linked_ac_docno');
  notice('    autocount-outbox.ts noteReadFailure — an error that is NOT one of the eight refusal');
  notice('                                          classes and not AcReadError returns before');
  notice('                                          writing the skipped row (and before logging)');
  notice('    autocount-outbox.ts enqueueEdit     — no linked_ac_docno and no PENDING originating op');
  notice('    mfg-sales-orders.ts POST /          — the enqueue sits inside `if (asDraft !== true)`');
  notice('    mfg-purchase-orders.ts POST / and POST /from-sos — the same shape for a DRAFT PO');
}

main()
  /* Exit 0 for every legitimate answer, including an empty queue: the ANSWER is
     the output and a red job reads as "the check broke". Only an unreachable
     database is non-zero. */
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
