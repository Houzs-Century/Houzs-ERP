#!/usr/bin/env node
/* probe-field-read-snapshot — WHY does the tally refuse with 15258 vs 15264?
 *
 * The refusal is `check-ac-erp-reconcile.mjs`'s no-LIMIT assertion:
 *
 *     REFUSED: SO: the field query returned 15258 ERP lines but COUNT(*) says
 *     15264. The answer is being truncated; a count taken from a truncated read
 *     is a lie.
 *
 * THE GUARD IS RIGHT AND IS NOT TOUCHED BY THIS FILE. This probe only asks
 * WHICH of the two possible causes produced the disagreement, because the fix
 * is different for each and a guess would be a third unverified claim in a
 * night that already had several:
 *
 *   H1  THE READ IS NOT SNAPSHOT-CONSISTENT. loadErpFieldSide fires seven
 *       separate statements on one autocommit connection: the SO lines array is
 *       statement 2 and the SO COUNT(*) is statement 7. Every statement gets its
 *       OWN snapshot, so another lane inserting six sales-order lines in the
 *       seconds between them makes the two numbers disagree with nothing
 *       truncated at all. Several lanes were writing this database tonight.
 *
 *   H2  SOMETHING IS ACTUALLY CAPPING THE ROWS. A driver row limit, a page
 *       size, a partial result. This is what the guard's wording assumes.
 *
 * They are told apart by reading the SAME two numbers a second time inside ONE
 * REPEATABLE READ transaction, where both statements share a single snapshot:
 *
 *   - H1 predicts the transaction pass AGREES (and that the autocommit pass may
 *     drift, depending on whether a writer is active this minute).
 *   - H2 predicts the transaction pass DISAGREES TOO — one snapshot cannot cure
 *     a row cap.
 *
 * A third reading settles it independently of whether a writer happens to be
 * running right now: scm.mfg_sales_order_items carries created_at, so rows born
 * inside the failing run's own 20-second window can simply be counted.
 *
 * READ-ONLY. SELECTs only; the one transaction it opens is declared READ ONLY,
 * so the server itself refuses a write. No DDL, no writes, no MODE=apply.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
const CO = String(process.env.COMPANY_ID || "1");
/* The failing run: workflow run 34325417734, step "The verdicts". */
const RUN_FROM = process.env.RUN_FROM || "2026-09-09T07:45:05Z";
const RUN_TO = process.env.RUN_TO || "2026-09-09T07:45:35Z";

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });

/* The exact statements loadErpFieldSide runs for SO lines, character for
   character in their FROM/JOIN/WHERE, so this probe measures that query and not
   a paraphrase of it. */
const SO_LINES_FROM =
  "scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no " +
  `WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;

const linesRows = async (q) => (await q.unsafe(`SELECT i.id FROM ${SO_LINES_FROM}`)).length;
const linesCount = async (q) => (await q.unsafe(`SELECT COUNT(*)::int AS n FROM ${SO_LINES_FROM}`))[0].n;

const out = (m) => console.log(m);

try {
  out("═══ SO field-read: array length vs COUNT(*) ═══");
  out(`company ${CO}; the reconcile's own FROM/JOIN/WHERE, unmodified.`);
  out("");

  /* PASS 1 — autocommit, the way loadErpFieldSide reads today. Four statements
     are interleaved between the array and the count in the real checker; the
     gap is reproduced here with those same four reads so the window this probe
     exposes is the window the checker actually has. */
  out("── PASS 1: autocommit (today's behaviour) ──");
  const a1 = await linesRows(sql);
  await sql.unsafe(`SELECT COUNT(*)::int AS n FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`);
  await sql.unsafe(`SELECT COUNT(*)::int AS n FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`);
  const c1 = await linesCount(sql);
  out(`   array ${a1} · COUNT(*) ${c1} · delta ${c1 - a1}`);

  /* PASS 2 — one REPEATABLE READ snapshot over both statements. */
  out("");
  out("── PASS 2: both statements inside ONE repeatable-read snapshot ──");
  let a2 = null;
  let c2 = null;
  await sql.begin("read only isolation level repeatable read", async (tx) => {
    a2 = await linesRows(tx);
    await tx.unsafe(`SELECT COUNT(*)::int AS n FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`);
    await tx.unsafe(`SELECT COUNT(*)::int AS n FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`);
    c2 = await linesCount(tx);
  });
  out(`   array ${a2} · COUNT(*) ${c2} · delta ${c2 - a2}`);

  /* PASS 3 — was this database being WRITTEN while the tally ran? Independent
     of whether a writer is active at this moment. */
  out("");
  out("── PASS 3: sales-order lines born during the failing run's own window ──");
  const born = await sql.unsafe(
    `SELECT COUNT(*)::int AS n, MIN(i.created_at) AS first, MAX(i.created_at) AS last
       FROM ${SO_LINES_FROM}
        AND i.created_at >= '${RUN_FROM}'::timestamptz AND i.created_at <= '${RUN_TO}'::timestamptz`,
  );
  out(`   ${RUN_FROM} .. ${RUN_TO}: ${born[0].n} row(s) created  (first ${born[0].first ?? "-"}, last ${born[0].last ?? "-"})`);

  const recent = await sql.unsafe(
    `SELECT date_trunc('hour', i.created_at) AS hr, COUNT(*)::int AS n
       FROM ${SO_LINES_FROM}
        AND i.created_at > now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1`,
  );
  out(`   in-scope sales-order lines created in the last 24h, by hour (${recent.length} bucket(s)):`);
  for (const r of recent) out(`      ${new Date(r.hr).toISOString()}  ${r.n}`);

  /* PASS 4 — a cap would be a property of the DRIVER, so ask it for a row set
     whose true size is known and see whether it hands back all of them. */
  out("");
  out("── PASS 4: does the driver cap a large result? ──");
  const big = await sql.unsafe("SELECT g FROM generate_series(1, 60000) g");
  out(`   asked for 60000 generated rows, received ${big.length}`);

  out("");
  out("═══ VERDICT ═══");
  if (a2 === c2 && big.length === 60000) {
    out("H1 — the read is NOT snapshot-consistent. One snapshot makes the two numbers agree, and the");
    out("driver returns a 60000-row result whole, so nothing is capping the rows. The disagreement is");
    out("another writer landing rows BETWEEN the array read and the count read.");
  } else if (a2 !== c2) {
    out("H2 — one snapshot did NOT cure it. Something is genuinely truncating the read; do not");
    out("wrap it in a transaction and call it fixed.");
  } else {
    out("MIXED — the driver capped a known-size result. Read PASS 4 before concluding anything.");
  }
} finally {
  await sql.end({ timeout: 5 });
}
