#!/usr/bin/env node
// reclaim-doc-no.mjs — hand ONE document number back to a monthly series by
// LOWERING scm.doc_number_counters.next_n. The only tool in this tree that
// moves a counter DOWN.
//
// WHY IT EXISTS. Since migration 0316 the number is minted from a stored
// counter, not from `max(surviving rows) + 1`, and the counter only ever goes
// UP (`scm.next_doc_no_n` = `GREATEST(next_n, floor + 1) + 1`). That is the fix
// for the 2026-08-20 re-issue, where a wipe reset the series to 001 and the ERP
// re-minted HC-SO-2608-001/002 into an AutoCount book that already held them —
// `Primary Key Error`, four documents refused. docs/doc-number-reissue-coe.md.
//
// The cost of that fix, which nothing had a tool for: delete the NEWEST order
// of a month and its number is skipped forever. On 2026-08-30 the owner deleted
// the test order 2990-SO-2608-067 and asked for the next order to reclaim 067.
// The counter said 68. There was no way to answer him except this script.
//
// WHAT IT REFUSES, and why each refusal is the point:
//   - an `HC-` series. Those are the numbers the licensed AED_HOUZS account book
//     holds; re-issuing one is the exact 2026-08-20 incident. No override.
//   - a target that is not BELOW the current next_n. Raising is the RPC's own
//     job and it does it safely; this tool only lowers.
//   - a target that is not FREE. If any surviving row of the series already
//     carries that suffix or a higher one, the number is not available and
//     handing it out again would mint a duplicate PRIMARY KEY.
//   - a target any scm.autocount_outbox row already carries. The outbox is this
//     system's only memory of what it has EXPORTED; once a number has left, the
//     surviving rows stop being a record of what was issued.
//   - an unknown series type. The table a series is measured against is a map,
//     not a guess.
//
// SAFETY: MODE=plan by default (prints the counter row, the live max, the
// outbox max and the verdict, writes nothing). MODE=apply additionally requires
// CONFIRM_SERIES to equal SERIES. The write is a single UPDATE inside a
// transaction, guarded again in SQL by `WHERE next_n > target` so a concurrent
// mint between the read and the write cannot be clobbered.
//
// EXIT CODE: 0 for every legitimate answer INCLUDING a refusal — a refusal is a
// verdict, not a malfunction. Only an unreachable DB or a failed write exits
// non-zero. Missing/blank inputs exit 2 (the operator, not the database).
//
// Usage:
//   SERIES=2990-SO-2608 TARGET_N=67 node scripts/reclaim-doc-no.mjs
//   SERIES=2990-SO-2608 TARGET_N=67 MODE=apply CONFIRM_SERIES=2990-SO-2608 \
//     node scripts/reclaim-doc-no.mjs
//
// RE-RUN: refuses. A second run reads next_n already AT the target, which is
// not BELOW the current value, so it prints the refusal and writes nothing.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
const SERIES = (process.env.SERIES ?? "").trim();
const TARGET_RAW = (process.env.TARGET_N ?? "").trim();
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_SERIES = (process.env.CONFIRM_SERIES ?? "").trim();

if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
if (!SERIES) { console.error("need SERIES env (e.g. 2990-SO-2608)"); process.exit(2); }
if (!/^\d+$/.test(TARGET_RAW)) { console.error("need TARGET_N env — a positive integer (e.g. 67)"); process.exit(2); }
const TARGET_N = Number(TARGET_RAW);
if (TARGET_N < 1) { console.error("TARGET_N must be >= 1"); process.exit(2); }
if (APPLY && CONFIRM_SERIES !== SERIES) {
  console.error(`MODE=apply requires CONFIRM_SERIES=${SERIES} — retype the series, it is not a checkbox`);
  process.exit(2);
}

// Where a series' surviving rows live. Same map migration 0316 seeded from, and
// the reason an unknown type is a refusal rather than a shrug: a counter
// lowered against the wrong table is a duplicate PRIMARY KEY waiting for the
// next save.
const SERIES_SOURCE = {
  SO:  { table: "scm.mfg_sales_orders",                 col: "doc_no" },
  PO:  { table: "scm.purchase_orders",                  col: "po_number" },
  DO:  { table: "scm.delivery_orders",                  col: "do_number" },
  DR:  { table: "scm.delivery_returns",                 col: "return_number" },
  GRN: { table: "scm.grns",                             col: "grn_number" },
  PI:  { table: "scm.purchase_invoices",                col: "invoice_number" },
  SI:  { table: "scm.sales_invoices",                   col: "invoice_number" },
  JE:  { table: "scm.journal_entries",                  col: "je_no" },
  ST:  { table: "scm.stock_transfers",                  col: "transfer_no" },
  STK: { table: "scm.stock_takes",                      col: "take_no" },
  PCR: { table: "scm.purchase_consignment_receives",    col: "receive_number" },
};

class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };

const db = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/** The numeric suffix of `<series>-NNN`, or null when the string is not one. */
function suffixOf(series, docNo) {
  const m = new RegExp(`^${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`).exec(String(docNo));
  return m ? Number(m[1]) : null;
}

/** Highest suffix this series holds in `source`, or 0 when it holds none. */
async function liveMax(sql, source, series) {
  const rows = await sql.unsafe(
    `SELECT ${source.col} AS doc_no FROM ${source.table} WHERE ${source.col} LIKE $1`,
    [`${series}-%`],
  );
  let max = 0;
  for (const r of rows) {
    const n = suffixOf(series, r.doc_no);
    if (n !== null && n > max) max = n;
  }
  return max;
}

/** Highest suffix of this series the export queue still remembers. */
async function outboxMax(sql, series) {
  const [present] = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'scm' AND table_name = 'autocount_outbox'`;
  if (!present.n) return { known: false, max: 0 };
  const rows = await sql`
    SELECT doc_no FROM scm.autocount_outbox WHERE doc_no LIKE ${`${series}-%`}`;
  let max = 0;
  for (const r of rows) {
    const n = suffixOf(series, r.doc_no);
    if (n !== null && n > max) max = n;
  }
  return { known: true, max };
}

/**
 * What the NEXT mint will hand out, computed the way scm.next_doc_no_n does:
 * `GREATEST(next_n, floor + 1)`, where floor is the live max. Printing this
 * rather than next_n is the whole point — next_n alone does not answer the
 * operator's question when the live rows sit above it.
 */
const nextMintedSuffix = (nextN, floor) => Math.max(nextN, floor + 1);

async function main() {
  console.log(`\n== reclaim-doc-no :: SERIES=${SERIES} TARGET_N=${TARGET_N} mode=${APPLY ? "APPLY" : "PLAN"} ==\n`);

  const type = SERIES.split("-").at(-2);
  const source = SERIES_SOURCE[type ?? ""];
  if (!source) {
    refuse(`series type "${type}" is not in SERIES_SOURCE — add it with the table its numbers live in, do not guess`);
  }
  if (SERIES.startsWith("HC-")) {
    refuse(
      "HC- series are the numbers the licensed AED_HOUZS account book holds. Re-issuing one is " +
      "the 2026-08-20 Primary Key Error incident (docs/doc-number-reissue-coe.md). Refused, no override.",
    );
  }

  const [counterTable] = await db`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'scm' AND table_name = 'doc_number_counters'`;
  if (!counterTable.n) {
    refuse("scm.doc_number_counters is ABSENT — migration 0316 has not applied here. Nothing to lower.");
  }

  const [row] = await db`
    SELECT series, next_n, seed_source FROM scm.doc_number_counters WHERE series = ${SERIES}`;
  if (!row) {
    refuse(`no counter row for series ${SERIES}. The series self-seeds on first use from the live max, so there is nothing to lower.`);
  }

  const floor = await liveMax(db, source, SERIES);
  const ob = await outboxMax(db, SERIES);

  console.log(`Counter : ${SERIES}  next_n=${row.next_n}   ${row.seed_source ?? "(no source recorded)"}`);
  console.log(`Live    : ${source.table}.${source.col}  highest surviving suffix = ${floor}`);
  console.log(`Outbox  : ${ob.known ? `scm.autocount_outbox highest exported suffix = ${ob.max}` : "scm.autocount_outbox absent — cannot answer, treated as a refusal below"}`);
  console.log(`Today   : the next mint would hand out ${SERIES}-${String(nextMintedSuffix(row.next_n, floor)).padStart(3, "0")}`);
  console.log(`Wanted  : the next mint hands out ${SERIES}-${String(TARGET_N).padStart(3, "0")}\n`);

  if (!ob.known) refuse("scm.autocount_outbox is absent, so 'has this number already been exported' cannot be answered. A number whose history is unknown is not free.");
  if (TARGET_N >= row.next_n) refuse(`TARGET_N=${TARGET_N} is not BELOW next_n=${row.next_n}. This tool only lowers; the counter raises itself safely.`);
  if (floor >= TARGET_N) refuse(`${source.table} still holds ${SERIES}-${String(floor).padStart(3, "0")}, so suffix ${TARGET_N} is NOT free — handing it out would mint a duplicate primary key.`);
  if (ob.max >= TARGET_N) refuse(`scm.autocount_outbox remembers exporting ${SERIES}-${String(ob.max).padStart(3, "0")}. Once a number has left this system the surviving rows stop being a record of what was issued.`);

  if (!APPLY) {
    console.log(`PLAN complete. ${SERIES}-${String(TARGET_N).padStart(3, "0")} is free and reclaimable.`);
    console.log(`To apply, re-run with MODE=apply and CONFIRM_SERIES=${SERIES}.`);
    return;
  }

  await db.begin(async (sql) => {
    // Guarded again in SQL: a mint that landed between the read above and this
    // statement would have raised next_n, and this WHERE declines to clobber it.
    const r = await sql`
      UPDATE scm.doc_number_counters
         SET next_n = ${TARGET_N},
             seed_source = ${`lowered to ${TARGET_N} by reclaim-doc-no.mjs — ${new Date().toISOString().slice(0, 10)}; previous ${row.next_n} (${row.seed_source ?? "no source"})`},
             updated_at = now()
       WHERE series = ${SERIES} AND next_n > ${TARGET_N}`;
    console.log(`Updated : scm.doc_number_counters rows=${r.count}`);
    if (r.count !== 1) throw new Error(`expected to update exactly 1 counter row, updated ${r.count} — rolled back`);
  });

  // Fresh connection, and it asks for the VALUE rather than a count: an
  // `UPDATE 1` was true while a column was being corrupted (jsonb-double-
  // encoding-coe.md), so the receipt is not the verification.
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const [after] = await fresh`
      SELECT series, next_n, seed_source FROM scm.doc_number_counters WHERE series = ${SERIES}`;
    const floorAfter = await liveMax(fresh, source, SERIES);
    console.log(`\nAfter   : series=${after?.series ?? "(row vanished)"} next_n=${after?.next_n ?? "?"}`);
    console.log(`After   : ${source.table}.${source.col} highest surviving suffix = ${floorAfter}`);
    const willMint = after ? nextMintedSuffix(after.next_n, floorAfter) : null;
    console.log(`After   : next mint hands out ${willMint === null ? "(unknown)" : `${SERIES}-${String(willMint).padStart(3, "0")}`}`);
    if (!after || after.next_n !== TARGET_N || willMint !== TARGET_N) {
      throw new Error(
        `verification FAILED — wanted next_n=${TARGET_N} and a next mint of ${TARGET_N}, read next_n=${after?.next_n} and ${willMint}`,
      );
    }
    console.log(`\nAPPLY complete. ${SERIES}-${String(TARGET_N).padStart(3, "0")} is what the next save will take.`);
  } finally {
    await fresh.end();
  }
}

main().then(() => db.end()).catch(async (e) => {
  if (e instanceof Refused) {
    console.log(`\nREFUSED: ${e.message}`);
    console.log("Nothing was written. This is a verdict, not a failure.");
    await db.end();
    return;
  }
  console.error("RECLAIM_FAIL:", e.message);
  await db.end();
  process.exit(1);
});
