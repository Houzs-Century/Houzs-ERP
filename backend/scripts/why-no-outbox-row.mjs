#!/usr/bin/env node
// READ-ONLY. Did this ERP document ever even reach the AutoCount queue?
//
// THE OWNER'S QUESTION, 2026-08-16: he created documents in the ERP and they
// are not in AutoCount. For each of the four conversion chains — SO->PO,
// SO->DO, DO->IV, PO->GR->PI — he wants to know whether the ERP ever OFFERED
// the document to AutoCount at all.
//
// WHY check-autocount-outbox-health.mjs CANNOT ANSWER IT. That script itemises
// the failed, pending, skipped and re-queued rows and prints `sent` only as a
// number in one summary line. It never groups by `op`, so a chain whose rows
// all went through is INVISIBLE in it, and "I cannot see it there" reads as
// "it was never queued". Those are different facts and this script keeps them
// apart: section B prints EVERY row of EVERY status, `sent` included, grouped
// by op, so the four chains can be counted directly.
//
// THE INTERESTING ROW IS THE ONE THAT IS NOT THERE. A document the ERP created
// and never even offered to AutoCount leaves nothing behind — no failed row, no
// skip reason, nothing to search for. CLAUDE.md names that the worst class here
// ("a failure that reaches nobody... the owner reported it as: the button does
// nothing"). Section E is the list of those documents and it is meant to be the
// first thing you look at.
//
// WHAT IT DOES NOT DO. It does not say WHY a row is missing — a script cannot
// read the write-back flag as it stood when the document was saved, and the
// flag row carries only its LATEST value and updated_at. It prints those two
// beside every document's created_at so the reader can compare, and it names
// the gates in source that write nothing (section G). Naming the gate is the
// reader's job with the source in hand; inventing one from a timestamp is
// exactly the story CLAUDE.md forbids.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
//
// RE-RUN: idempotent and side-effect free. Run it as often as you like.
//
//   COMPANY_ID=1 LIMIT=40 node backend/scripts/why-no-outbox-row.mjs
//
// ENUM TRAP (inherited from the other audits here): the document status columns
// are ENUMS, so COALESCE(col,'') coerces '' INTO the enum and throws. Every
// status is read ::text first. scm.autocount_outbox.status is a plain text
// column with a CHECK, and is read ::text anyway so the two read alike.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const LIMIT = Math.min(Number(process.env.LIMIT || 40), 200);
/* The whole outbox for this company is printed, and it is a small table today.
   The cap exists so a future backlog cannot turn a diagnostic into a 50,000
   line log — and it is REPORTED when it bites, because a silently truncated
   census is the same lie as a health script that hides `sent`. */
const OUTBOX_CAP = 2000;

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const iso = (d) => (d?.toISOString?.() ?? (d == null ? '(null)' : String(d)));

/**
 * The six ERP document tables, and how each one is named in the outbox.
 *
 * `docType` is the AutoCount vocabulary the queue is keyed by, and it is the
 * reason this is a table rather than a doc_no lookup: scm.sales_invoices and
 * scm.purchase_invoices BOTH number their documents in `invoice_number`, so a
 * match on doc_no alone would cross-wire an IV with a PI. The outbox index is
 * (company_id, doc_type, doc_no) and this mirrors it exactly.
 *
 * `chainOps` is the op(s) that document's OWN creation should have produced.
 * A document can carry an `edit` or `cancel` row and still never have been
 * offered to AutoCount in the first place, which is why "has any row" and "has
 * its chain row" are counted separately below.
 */
const DOCS = [
  { label: 'Sales orders', table: 'mfg_sales_orders', idCol: 'doc_no', noCol: 'doc_no', docType: 'SO', chainOps: ['create_so'] },
  { label: 'Purchase orders', table: 'purchase_orders', idCol: 'id', noCol: 'po_number', docType: 'PO', chainOps: ['create_po', 'so_to_po'] },
  { label: 'Delivery orders', table: 'delivery_orders', idCol: 'id', noCol: 'do_number', docType: 'DO', chainOps: ['so_to_do'] },
  { label: 'Goods received notes', table: 'grns', idCol: 'id', noCol: 'grn_number', docType: 'GR', chainOps: ['po_to_gr'] },
  { label: 'Sales invoices', table: 'sales_invoices', idCol: 'id', noCol: 'invoice_number', docType: 'IV', chainOps: ['do_to_iv'] },
  { label: 'Purchase invoices', table: 'purchase_invoices', idCol: 'id', noCol: 'invoice_number', docType: 'PI', chainOps: ['gr_to_pi'] },
];

/** The owner's four chains, as the ops that carry them. */
const CHAINS = [
  { n: 1, label: 'Sales order -> Purchase order', ops: ['so_to_po'],
    note: 'create_po is the SAME button falling back to a plain create — counted beside it, never folded in' },
  { n: 2, label: 'Sales order -> Delivery order', ops: ['so_to_do'], note: null },
  { n: 3, label: 'Delivery order -> Invoice', ops: ['do_to_iv'], note: null },
  { n: 4, label: 'Purchase order -> Goods received -> Purchase invoice', ops: ['po_to_gr', 'gr_to_pi'], note: null },
];

/** Which of a table's columns exist, so an optional one is read rather than
 *  guessed. `status` and `created_at` are not uniform across these six. */
async function columnsOf(table) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

/** A — the switch, and WHEN it last moved. */
async function dumpSwitch() {
  notice('A — the write-back switch (scm.app_config)');
  const rows = await sql`
    SELECT value, updated_at FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
  if (!rows.length) {
    notice('  scm.autocount_writeback: ROW ABSENT -> the flag parser fails CLOSED, so nothing is queued at all');
    return null;
  }
  const raw = rows[0].value;
  const v = String(raw ?? '').trim().toLowerCase();
  /* Same grammar as autocount-writeback-flag.ts: 'all', or a comma-separated
     company id list. Anything else — including a stray space — is OFF. */
  const on = v === 'all' || /^[0-9]+(\s*,\s*[0-9]+)*$/.test(v);
  const forThisCompany = v === 'all' || v.split(',').map((s) => s.trim()).includes(String(COMPANY_ID));
  notice(`  scm.autocount_writeback = ${JSON.stringify(raw)} -> ${on ? 'ON' : 'OFF'}`
    + `, and for company ${COMPANY_ID} specifically: ${forThisCompany ? 'ON' : 'OFF'}`);
  notice(`  last changed: ${iso(rows[0].updated_at)}`);
  notice('  A DOCUMENT SAVED BEFORE THAT TIMESTAMP CANNOT HAVE AN OUTBOX ROW: every enqueue');
  notice('  returns early while the flag is off, and it writes nothing when it does.');
  notice('  This row keeps only its LATEST value, so the timestamp bounds the answer, it does not prove it.');
  return rows[0].updated_at ?? null;
}

/** B — THE WHOLE OUTBOX. Every status, `sent` included, grouped by op. */
async function dumpOutbox() {
  console.log('');
  notice('B — the FULL outbox for this company, every state including sent, grouped by op');
  const counts = await sql`
    SELECT op, status::text AS status, count(*)::int AS n
    FROM scm.autocount_outbox WHERE company_id = ${COMPANY_ID}
    GROUP BY op, status ORDER BY op, status`;
  const rows = await sql`
    SELECT id, op, status::text AS status, doc_type, doc_no, doc_id, attempts,
           ac_doc_no, created_at, sent_at, last_error
    FROM scm.autocount_outbox WHERE company_id = ${COMPANY_ID}
    ORDER BY created_at ASC LIMIT ${OUTBOX_CAP}`;
  const total = counts.reduce((a, r) => a + r.n, 0);
  notice(`  ${total} row(s) in scm.autocount_outbox for company ${COMPANY_ID}`);
  if (total > OUTBOX_CAP) {
    notice(`  LISTING TRUNCATED at ${OUTBOX_CAP} — the counts above are exact, the itemisation below is not`);
  }
  if (!total) {
    notice('  EMPTY. The table is append-only, so empty means NOTHING WAS EVER ENQUEUED for this company —');
    notice('  not "drained". Read that against the switch in section A.');
  }

  console.log('');
  console.log(`${pad('OP', 12)} ${pad('STATUS', 9)} ${pad('N', 5)}`);
  for (const r of counts) console.log(`${pad(r.op, 12)} ${pad(r.status, 9)} ${pad(r.n, 5)}`);

  console.log('');
  console.log(`${pad('OP', 12)} ${pad('STATUS', 9)} ${pad('TYPE', 5)} ${pad('DOC_NO', 22)} `
    + `${pad('ATT', 4)} ${pad('AC_DOC_NO', 18)} ${pad('CREATED', 22)} ${pad('SENT', 22)}`);
  for (const r of rows) {
    console.log(`${pad(r.op, 12)} ${pad(r.status, 9)} ${pad(r.doc_type, 5)} ${pad(r.doc_no, 22)} `
      + `${pad(r.attempts, 4)} ${pad(r.ac_doc_no ?? '(none)', 18)} ${pad(iso(r.created_at), 22)} `
      + `${pad(r.sent_at ? iso(r.sent_at) : '(never)', 22)}`);
    if (r.last_error) console.log(`      last_error: ${String(r.last_error).slice(0, 1200)}`);
  }
  return rows;
}

/** C — the four chains, counted off the rows section B just printed. */
function dumpChains(outbox) {
  console.log('');
  notice('C — the four conversion chains, counted');
  const byOp = new Map();
  for (const r of outbox) {
    if (!byOp.has(r.op)) byOp.set(r.op, []);
    byOp.get(r.op).push(r);
  }
  const line = (op) => {
    const rs = byOp.get(op) ?? [];
    if (!rs.length) return `${pad(op, 12)} 0 rows — NEVER QUEUED`;
    const by = {};
    for (const r of rs) by[r.status] = (by[r.status] ?? 0) + 1;
    return `${pad(op, 12)} ${rs.length} row(s): `
      + ['pending', 'sent', 'failed', 'skipped'].map((s) => `${s} ${by[s] ?? 0}`).join(' / ');
  };
  notice(`  root  ${line('create_so')}`);
  for (const ch of CHAINS) {
    notice(`  chain ${ch.n} — ${ch.label}`);
    for (const op of ch.ops) notice(`        ${line(op)}`);
    if (ch.n === 1) notice(`        ${line('create_po')}  <- the fallback shape of the same action`);
    if (ch.note) notice(`        note: ${ch.note}`);
  }
  /* Ops the queue holds that no chain above claims. A new op added to the
     enqueue and not to this list would otherwise vanish from the census, which
     is the exact blind spot this script exists to not repeat. */
  const claimed = new Set(['create_so', 'create_po', ...CHAINS.flatMap((c) => c.ops)]);
  const rest = [...byOp.keys()].filter((op) => !claimed.has(op));
  for (const op of rest) notice(`  other ${line(op)}`);
}

/**
 * D — the documents, beside their outbox row.
 *
 * Returns the ones with NO chain row, for section E to shout about.
 */
async function dumpDocuments(spec, outbox, cols) {
  console.log('');
  notice(`D${spec.docType} — ${spec.label} (scm.${spec.table}), ${LIMIT} most recent in company ${COMPANY_ID}`);
  const hasStatus = cols.has('status');
  const hasCreated = cols.has('created_at');
  const hasLinked = cols.has('linked_ac_docno');
  if (!hasCreated) notice('  no created_at on this table — ordering by document number instead');
  if (!hasLinked) notice('  NO linked_ac_docno COLUMN — mig 0277 should have added it; report this');

  const orderCol = hasCreated ? 'created_at' : spec.noCol;
  const docs = await sql`
    SELECT ${sql(spec.idCol)} AS row_id,
           ${sql(spec.noCol)} AS doc_no,
           ${hasStatus ? sql`status::text` : sql`NULL::text`} AS status,
           ${hasCreated ? sql`created_at` : sql`NULL::timestamptz`} AS created_at,
           ${hasLinked ? sql`linked_ac_docno` : sql`NULL::text`} AS linked_ac_docno
    FROM scm.${sql(spec.table)}
    WHERE company_id = ${COMPANY_ID}
    ORDER BY ${sql(orderCol)} DESC
    LIMIT ${LIMIT}`;
  notice(`  ${docs.length} document(s)`);

  /* Matched on (doc_type, doc_no) — the outbox's own index — with doc_id as a
     second chance, because a document renumbered after enqueue would otherwise
     read as never-queued, and that is the one wrong answer this script must
     not give. */
  const mine = outbox.filter((r) => r.doc_type === spec.docType);
  const byNo = new Map();
  const byId = new Map();
  for (const r of mine) {
    if (!byNo.has(r.doc_no)) byNo.set(r.doc_no, []);
    byNo.get(r.doc_no).push(r);
    if (r.doc_id) {
      if (!byId.has(String(r.doc_id))) byId.set(String(r.doc_id), []);
      byId.get(String(r.doc_id)).push(r);
    }
  }

  const naked = [];
  console.log('');
  console.log(`${pad('DOC_NO', 22)} ${pad('STATUS', 12)} ${pad('CREATED', 22)} ${pad('LINKED_AC', 16)} OUTBOX`);
  for (const d of docs) {
    const rows = byNo.get(d.doc_no) ?? byId.get(String(d.row_id)) ?? [];
    const chain = rows.filter((r) => spec.chainOps.includes(r.op));
    const summary = rows.length
      ? rows.map((r) => `${r.op}/${r.status}/att=${r.attempts}`).join(' + ')
      : '*** NO OUTBOX ROW ***';
    console.log(`${pad(d.doc_no, 22)} ${pad(d.status ?? '(n/a)', 12)} ${pad(iso(d.created_at), 22)} `
      + `${pad(d.linked_ac_docno ?? '(none)', 16)} ${summary}`);
    for (const r of rows) {
      if (r.last_error) console.log(`      ${r.op} last_error: ${String(r.last_error).slice(0, 600)}`);
    }
    if (!chain.length) {
      naked.push({ ...d, docType: spec.docType, label: spec.label, table: spec.table,
        otherOps: rows.map((r) => r.op) });
    }
  }
  return naked;
}

/** E — THE LIST THAT MATTERS. Documents that were never offered to AutoCount. */
function dumpNaked(naked, switchedAt) {
  console.log('');
  console.log('================================================================');
  notice(`E — DOCUMENTS WITH NO OUTBOX ROW FOR THEIR OWN CHAIN OP: ${naked.length}`);
  console.log('================================================================');
  if (!naked.length) {
    notice('  none. Every listed document was offered to AutoCount at least once.');
    return;
  }
  notice('  Each of these exists in the ERP and the ERP never even ASKED AutoCount about it.');
  notice('  There is no failed row, no skip reason and no error text for any of them —');
  notice('  that is what makes this class silent, and why it is printed on its own.');
  console.log('');
  console.log(`${pad('TYPE', 5)} ${pad('DOC_NO', 22)} ${pad('STATUS', 12)} ${pad('CREATED', 22)} `
    + `${pad('LINKED_AC', 16)} ${pad('PRE-SWITCH', 11)} OTHER OPS ON THIS DOC`);
  for (const d of naked) {
    /* Saved before the flag last moved. NOT a verdict — the flag row keeps one
       value and one timestamp, so this bounds the question and does not close
       it. It is printed because it is the single cheapest discriminator
       between "the gate swallowed it" and "the feature was not on yet". */
    const pre = switchedAt && d.created_at
      ? (new Date(d.created_at) < new Date(switchedAt) ? 'YES' : 'no')
      : '(unknown)';
    console.log(`${pad(d.docType, 5)} ${pad(d.doc_no, 22)} ${pad(d.status ?? '(n/a)', 12)} `
      + `${pad(iso(d.created_at), 22)} ${pad(d.linked_ac_docno ?? '(none)', 16)} ${pad(pre, 11)} `
      + `${d.otherOps.length ? d.otherOps.join(', ') : '(none at all)'}`);
  }
  const drafts = naked.filter((d) => String(d.status ?? '').toUpperCase() === 'DRAFT');
  if (drafts.length) {
    notice(`  ${drafts.length} of those are DRAFT. A draft PO is gated OUT of the enqueue on purpose`);
    notice('  (mfg-purchase-orders.ts POST / and POST /from-sos), so a missing row there is the');
    notice('  designed behaviour and confirm is what queues it. They are LISTED, not filtered:');
    notice('  deciding for the reader which absence is legitimate is how a real one gets hidden.');
  }
}

/**
 * F — WHY A PURCHASE ORDER WENT AS create_po RATHER THAN so_to_po.
 *
 * po_transfer_shape is a pure five-gate function over four facts about the PO's
 * lines. The facts are queried here and the gate ORDER is restated, because
 * this probe runs under plain node against the production DSN and cannot import
 * the Worker's TypeScript. That makes it a REPLICA and replicas drift, so the
 * inputs are printed beside the verdict: if the two ever disagree, believe the
 * inputs and re-read scm/shared/po-transfer-shape.ts.
 */
async function dumpPoShape(outbox) {
  console.log('');
  notice('F — for each recent purchase order, would it TRANSFER from its sales order, or fall back to a create?');
  const pos = await sql`
    SELECT id, po_number, status::text AS status, created_at, linked_ac_docno
    FROM scm.purchase_orders WHERE company_id = ${COMPANY_ID}
    ORDER BY created_at DESC LIMIT ${LIMIT}`;
  if (!pos.length) { notice('  no purchase orders in this company'); return; }

  const ids = pos.map((p) => String(p.id));
  /* One pass over the lines of every listed PO. The allocation count is the
     mig-0235 consolidation marker; the sales line's key and doc_no are what a
     transfer is addressed by. LEFT JOIN, so a stock line (so_item_id NULL)
     survives into the count that needs it. */
  const lines = await sql`
    SELECT poi.id, poi.purchase_order_id, poi.so_item_id,
           soi.linked_ac_dtlkey, soi.doc_no AS so_doc_no,
           (SELECT count(*)::int FROM scm.purchase_order_item_allocations a
             WHERE a.purchase_order_item_id = poi.id) AS alloc_n
    FROM scm.purchase_order_items poi
    LEFT JOIN scm.mfg_sales_order_items soi ON soi.id = poi.so_item_id
    WHERE poi.purchase_order_id IN ${sql(ids)}`;

  const byPo = new Map();
  for (const l of lines) {
    const k = String(l.purchase_order_id);
    if (!byPo.has(k)) byPo.set(k, []);
    byPo.get(k).push(l);
  }
  const opOf = new Map();
  for (const r of outbox) {
    if (r.doc_type !== 'PO') continue;
    if (!opOf.has(r.doc_no)) opOf.set(r.doc_no, []);
    opOf.get(r.doc_no).push(`${r.op}/${r.status}`);
  }

  for (const p of pos) {
    const ls = byPo.get(String(p.id)) ?? [];
    const actual = opOf.get(p.po_number)?.join(' + ') ?? '(NO OUTBOX ROW)';
    if (!ls.length) {
      notice(`  ${p.po_number} [${p.status}]: 0 lines -> create ("the purchase order has no lines"). outbox: ${actual}`);
      continue;
    }
    const consolidated = ls.filter((l) => Number(l.alloc_n) > 0).length;
    const forStock = ls.filter((l) => l.so_item_id == null).length;
    /* Mirrors the TS: a key is present only when it parses finite AND > 0. */
    const keyOk = (l) => { const k = Number(l.linked_ac_dtlkey); return Number.isFinite(k) && k > 0; };
    const keyless = ls.filter((l) => l.so_item_id != null && !keyOk(l)).length;
    const keys = ls.map((l) => Number(l.linked_ac_dtlkey));
    const dupKeys = new Set(keys).size !== keys.length;
    const sources = [...new Set(ls.map((l) => String(l.so_doc_no ?? '').trim()))];

    let verdict;
    if (consolidated) verdict = `create — ${consolidated} line(s) consolidated (mig 0235 allocations present)`;
    else if (forStock) verdict = `create — ${forStock} line(s) are for stock, no sales order behind them`;
    else if (keyless) verdict = `create — ${keyless} line(s) name a sales line the account book has no key for`;
    else if (dupKeys) verdict = 'create — two purchase lines name the same sales-order line';
    else if (sources.length !== 1 || sources[0] === '') {
      verdict = sources.length > 1
        ? `create — lines come from ${sources.length} different sales orders`
        : 'create — the source sales order cannot be named';
    } else verdict = `TRANSFER — so_to_po from ${sources[0]}`;

    notice(`  ${p.po_number} [${p.status}] created ${iso(p.created_at)} linkedAc=${p.linked_ac_docno ?? '(none)'}`);
    notice(`      inputs: lines=${ls.length} consolidated=${consolidated} forStock=${forStock} `
      + `keyless=${keyless} duplicateKeys=${dupKeys} sourceSoDocNos=${JSON.stringify(sources)}`);
    notice(`      replica of po-transfer-shape.ts says: ${verdict}`);
    notice(`      the outbox actually holds: ${actual}`);
  }
}

async function main() {
  notice(`company ${COMPANY_ID}, ${LIMIT} documents per table — READ ONLY, SELECTs only`);
  const switchedAt = await dumpSwitch();
  const outbox = await dumpOutbox();
  dumpChains(outbox);

  const naked = [];
  for (const spec of DOCS) {
    const cols = await columnsOf(spec.table);
    if (!cols.size) { notice(`  scm.${spec.table} does not exist — skipped`); continue; }
    if (!cols.has('company_id')) {
      notice(`  scm.${spec.table} has NO company_id column — cannot scope, skipped rather than reported wrong`);
      continue;
    }
    naked.push(...await dumpDocuments(spec, outbox, cols));
  }
  dumpNaked(naked, switchedAt);
  await dumpPoShape(outbox);

  console.log('');
  notice('G — HOW TO READ THIS, AND WHERE THE GATES ARE');
  notice('  section C says whether a chain EVER ran. 0 rows there is the whole answer for that chain.');
  notice('  section E is a document the ERP never offered. Four gates in source write NOTHING:');
  notice('    1. scm/lib/autocount-outbox.ts enqueuePoCreate — companyId null, write-back off,');
  notice('       header unreadable, or the PO already carries a linked_ac_docno. All four return false.');
  notice('    2. scm/routes/mfg-purchase-orders.ts POST / — the enqueue sits inside `if (!asDraft)`.');
  notice('    3. scm/routes/mfg-purchase-orders.ts POST /from-sos — inside `if (headerPayload.status !== \'DRAFT\')`.');
  notice('    4. the convert routes call recordConvertSkipped instead of enqueueConvert when the');
  notice('       document merges several sources — that DOES write a skipped row, so it is NOT silent.');
  notice('  section F separates "queued as the wrong shape" from "never queued". A PO that reads');
  notice('  TRANSFER in the replica but sits in the outbox as create_po is a real defect.');
}

main()
  /* Exit 0 for every legitimate answer, including an empty queue: the ANSWER is
     the output and a red job reads as "the check broke". Only an unreachable
     database is non-zero. */
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
