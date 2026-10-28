// Read-only report answering two go-live questions about document numbers that
// only production can answer, so that nobody has to open a SQL console.
//
// THE OWNER'S QUESTION, 2026-09-08, before opening Sales Orders to the whole
// floor: 「确保检查看 document number 怎么跑 以免 30 个人同时开单的话号码大家撞」.
// Whether two simultaneous creates can COLLIDE is settled by
// backend/tests-pg/docNoConcurrentCreate.pg.test.ts against a real server. What
// a test cannot answer is how much room the running system actually has, and
// where the numbering's two known cliffs sit relative to today's traffic. That
// is what this reads.
//
// (A) RUN RATE — documents per SERIES MONTH per family, newest first. The
//     series is the doc number without its `-NNN` tail, so this counts exactly
//     the thing the counter counts (scm.doc_number_counters, migration 0316).
//
// (B) THE 1,000 CLIFF — scm/lib/doc-no.ts documents at length that an un-paged
//     PostgREST read stops at 1,000 rows with no error, and that past the
//     1,000th document of one month the old minter re-issued a live number for
//     the rest of the month. `fetchMonthlyDocNos` pages, and the counter makes a
//     low floor harmless, so the RE-ISSUE half of that cliff is closed — what is
//     left is the paging cost, one extra round trip per create per 1,000. This
//     section says how far today's busiest month is from that line, in the only
//     unit that means anything to the person deciding: documents per day.
//
// (C) MONTH-TAG DRIFT — the five operational minters (SO / DO / PO / GRN / SI)
//     build their `YYMM` from `new Date()`, which in a Cloudflare Worker is the
//     UTC clock, while the document's own DATE column defaults to `todayMyt()`.
//     Malaysia is UTC+8, so between 00:00 and 08:00 MYT on the 1st of a month
//     the two disagree and the document takes the PREVIOUS month's series. This
//     counts how many documents in the live book already show that mismatch. A
//     count is the finding; the fix is a decision, not a repair — a document
//     number is an id and is never re-minted after the fact.
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction, manual
// trigger only. Exits 0 for every legitimate answer — the ANSWER is the output,
// and a red job would read as "the check broke". Only an unreachable database
// or a query error exits non-zero.
//
// RE-RUN: read-only; running it twice changes nothing and prints the same
// report against whatever the book holds at that moment.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/* The families whose numbers a MINTER owns. Reference columns (an SO line, an
   audit row, an outbox attempt) repeat their parent's number by design and are
   deliberately absent — counting them would report a line count as a document
   count. Each names the minter that writes it. */
const FAMILIES = [
  { schema: 'scm', table: 'mfg_sales_orders',    col: 'doc_no',         kind: 'SO',  minter: 'mfg-sales-orders.ts nextDocNo' },
  { schema: 'scm', table: 'delivery_orders',     col: 'do_number',      kind: 'DO',  minter: 'delivery-orders-mfg.ts nextNum' },
  { schema: 'scm', table: 'purchase_orders',     col: 'po_number',      kind: 'PO',  minter: 'mfg-purchase-orders.ts' },
  { schema: 'scm', table: 'grns',                col: 'grn_number',     kind: 'GRN', minter: 'grns.ts nextNumber' },
  { schema: 'scm', table: 'sales_invoices',      col: 'invoice_number', kind: 'SI',  minter: 'sales-invoices.ts nextNum' },
  { schema: 'scm', table: 'purchase_invoices',   col: 'invoice_number', kind: 'PI',  minter: 'purchase-invoices.ts' },
  { schema: 'scm', table: 'payment_vouchers',    col: 'pv_number',      kind: 'PV',  minter: 'payment-vouchers.ts' },
  { schema: 'scm', table: 'journal_entries',     col: 'je_no',          kind: 'JE',  minter: 'doc-no.ts nextJeNo' },
];

/* The DOCUMENT'S OWN date, whatever each table happens to call it. Discovered
   from information_schema rather than hardcoded per table: these tables were
   ported by hand and their date columns are named inconsistently, and a
   hardcoded name that is wrong reports zero drift, which reads exactly like
   good news. The FIRST of these that exists on the table is used. */
const DATE_COLUMN_PREFERENCE = [
  'so_date', 'do_date', 'po_date', 'grn_date', 'invoice_date', 'voucher_date',
  'entry_date', 'doc_date', 'received_at', 'date',
];

/** Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
/* Identifiers are interpolated into the SQL text, so they are quoted here.
   Every one of them comes from the hardcoded FAMILIES / DATE_COLUMN_PREFERENCE
   lists above and never from input — the guard is belt, and it refuses rather
   than escaping something surprising. postgres.js's `sql(ident)` fragment helper
   only works inside a TAGGED template; these queries are built as text for
   `unsafe()`, where a fragment object would stringify to "[object Object]". */
const qi = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
};
const warn = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);

/** How many series months to print per family. */
const MONTHS = Number(process.env.MONTHS || 12);
/** The row cap a single un-paged PostgREST read stops at (lib/paginate-all.ts PAGE). */
const PAGE_CEILING = 1000;
/** Working days in a month, for turning a monthly ceiling into a daily one. */
const WORKING_DAYS = 26;

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const columns = await pg`
    SELECT table_schema AS s, table_name AS t, column_name AS c
      FROM information_schema.columns
     WHERE table_schema IN ('scm', 'public')`;
  const has = (s, t, c) => columns.some((r) => r.s === s && r.t === t && r.c === c);
  const dateColumnFor = (f) => DATE_COLUMN_PREFERENCE.find((c) => has(f.schema, f.table, c)) ?? null;

  /* ═════ (A) RUN RATE ═══════════════════════════════════════════════════════ */
  notice(`=== (A) RUN RATE — documents per series month, newest ${MONTHS} ===`);
  notice('    a "series" is the doc number without its -NNN tail, e.g. HC-SO-2609.');
  const busiest = new Map(); // family key -> { series, n }
  for (const f of FAMILIES) {
    if (!has(f.schema, f.table, f.col)) {
      warn(`  ${f.schema}.${f.table}.${f.col}: table or column ABSENT — skipped`);
      continue;
    }
    const rows = await pg.unsafe(
      `SELECT substring(${qi(f.col)} from '^(.*)-[0-9]+$') AS series, count(*)::int AS n
         FROM ${qi(f.schema)}.${qi(f.table)}
        WHERE ${qi(f.col)} ~ '^.+-[0-9]{4}-[0-9]{1,6}$'
        GROUP BY 1 ORDER BY 1 DESC`,
    );
    if (rows.length === 0) { notice(`  ${f.kind}: no monthly-numbered documents`); continue; }
    notice(`  ${f.kind}  [${f.schema}.${f.table}.${f.col} <- ${f.minter}]`);
    for (const r of rows.slice(0, MONTHS)) {
      notice(`      ${String(r.series).padEnd(20)} ${String(r.n).padStart(5)} document(s)`);
    }
    const top = rows.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a));
    busiest.set(f.kind, { series: top.series, n: Number(top.n) });
  }

  /* ═════ (B) THE 1,000 CLIFF ════════════════════════════════════════════════ */
  notice(`=== (B) HEADROOM TO ${PAGE_CEILING} DOCUMENTS IN ONE SERIES MONTH ===`);
  notice('    The RE-ISSUE half of this cliff is closed by scm.doc_number_counters');
  notice('    (migration 0316): a truncated read reports a LOW floor and a low floor');
  notice('    can only be ignored. What remains past 1,000 is one extra PostgREST');
  notice('    round trip per create per 1,000 rows, which is cost, not correctness.');
  let worst = null;
  for (const [kind, top] of busiest) {
    const perDay = top.n / WORKING_DAYS;
    const needPerDay = PAGE_CEILING / WORKING_DAYS;
    const multiple = top.n > 0 ? PAGE_CEILING / top.n : Infinity;
    notice(
      `  ${kind.padEnd(4)} busiest month ever: ${String(top.n).padStart(5)} (${top.series})`
      + `  = ${perDay.toFixed(1)}/working-day`
      + `  -> needs ${multiple === Infinity ? 'any' : `${multiple.toFixed(1)}x`} that`
      + ` (${needPerDay.toFixed(1)}/working-day) to reach ${PAGE_CEILING}`,
    );
    if (!worst || top.n > worst.n) worst = { kind, ...top };
  }
  if (worst) {
    notice(
      `  BUSIEST SERIES MONTH EVER RECORDED: ${worst.series} with ${worst.n}`
      + ` — ${((worst.n / PAGE_CEILING) * 100).toFixed(1)}% of the ${PAGE_CEILING} line.`,
    );
  }

  /* ═════ (C) MONTH-TAG DRIFT ════════════════════════════════════════════════ */
  notice('=== (C) MONTH-TAG DRIFT — the number says one month, the document says another ===');
  notice('    The minters build YYMM from the Worker UTC clock; the date column defaults');
  notice('    to todayMyt(). Malaysia is UTC+8, so 00:00-08:00 MYT on the 1st disagrees.');
  let driftTotal = 0;
  for (const f of FAMILIES) {
    if (!has(f.schema, f.table, f.col)) continue;
    const dateCol = dateColumnFor(f);
    if (!dateCol) { warn(`  ${f.kind}: no recognised date column — NOT MEASURED`); continue; }
    const where = `${qi(f.col)} ~ '^.+-[0-9]{4}-[0-9]{1,6}$'`
      + ` AND ${qi(dateCol)} IS NOT NULL`
      + ` AND substring(${qi(f.col)} from '-([0-9]{4})-[0-9]{1,6}$')`
      + ` <> to_char(${qi(dateCol)}, 'YYMM')`;
    const rows = await pg.unsafe(
      `SELECT ${qi(f.col)} AS doc_no, ${qi(dateCol)}::text AS doc_date
         FROM ${qi(f.schema)}.${qi(f.table)} WHERE ${where}
        ORDER BY ${qi(dateCol)} DESC LIMIT 20`,
    );
    const [{ n }] = await pg.unsafe(
      `SELECT count(*)::int AS n FROM ${qi(f.schema)}.${qi(f.table)} WHERE ${where}`,
    );
    driftTotal += Number(n);
    if (Number(n) === 0) { notice(`  ${f.kind.padEnd(4)} 0 mismatched  [date column: ${dateCol}]`); continue; }
    warn(`  ${f.kind.padEnd(4)} ${n} mismatched  [date column: ${dateCol}]`);
    for (const r of rows) warn(`        ${r.doc_no}  dated ${r.doc_date}`);
  }
  notice(
    driftTotal === 0
      ? '  NO document in the book carries a month tag that disagrees with its own date.'
      : `  TOTAL ${driftTotal} document(s) whose number month disagrees with the document date.`,
  );
  notice('  Note: an EDITED date also lands here — the owner\'s rule is that a number is an');
  notice('  id and is never re-minted after a date change (单据存了后改日期号码不要重发),');
  notice('  so a mismatch is not automatically a minting fault. The 1st-of-month cases are.');
} finally {
  await pg.end({ timeout: 5 });
}
