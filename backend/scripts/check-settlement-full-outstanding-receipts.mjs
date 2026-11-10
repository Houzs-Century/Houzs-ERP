// READ-ONLY. How many card-settlement bank receipts took "the whole remaining
// amount" when they were keyed in by hand, and how many of those does the bank
// statement contradict?
//
// WHY THIS EXISTS. The Bank Recon "Money received" box turned "3,500.00" into
// NaN (Number() does not read a thousands comma), JSON sent NaN as null, and
// POST /accounting/settlement/batches/:id/received read null as "blank = the
// rest of it" and journaled the full outstanding. The request body is not
// stored, so a receipt booked that way looks exactly like one where the box was
// deliberately left blank. This script therefore reports an UPPER BOUND and two
// signals, never a verdict per receipt:
//
//   took_rest       hand-keyed (bank_line_id IS NULL) receipts whose amount is
//                   exactly what was outstanding on the statement when it was
//                   booked: payable (stated_net_sen, else net_sen, as
//                   postBatchReceipt reads it) less earlier receipts and their
//                   charges. Blank and unreadable both land here.
//   bank_disagrees  of those, the ones whose statement has a bank-statement
//                   line matched to it (matched_batch_id) carrying a different
//                   amount. The strongest sign the operator meant less.
//   undone          SETTLEBANK journal entries that were reversed: receipts
//                   somebody took back. Undo deletes the receipt row, so these
//                   cannot be tied to took_rest; they are the correction trail.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// answer, including zero; only an unreachable database or a query error exits
// non-zero.
// RE-RUN: read-only, a second run reports the same counts plus anything new.
import "./lib/public-log-guard.mjs";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

async function main() {
  const rows = await sql`
    WITH rec AS (
      SELECT r.id, r.company_id, r.batch_id, r.amount_sen, r.bank_line_id,
             COALESCE(b.stated_net_sen, b.net_sen, 0) AS payable_sen,
             COALESCE(SUM(r.amount_sen + COALESCE(r.charge_sen, 0)) OVER (
               PARTITION BY r.batch_id ORDER BY r.created_at, r.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_sen
        FROM scm.acc_settlement_receipts r
        JOIN scm.acc_settlement_batches b ON b.id = r.batch_id AND b.company_id = r.company_id
    ), tagged AS (
      SELECT rec.*,
             (rec.bank_line_id IS NULL AND rec.amount_sen = rec.payable_sen - rec.prior_sen) AS took_rest,
             EXISTS (SELECT 1 FROM scm.acc_bank_statement_lines l
                      WHERE l.company_id = rec.company_id AND l.matched_batch_id = rec.batch_id
                        AND l.amount_sen <> rec.amount_sen) AS bank_disagrees
        FROM rec
    ), undone AS (
      SELECT company_id, COUNT(*)::int AS n
        FROM scm.journal_entries
       WHERE source_type = 'SETTLEBANK' AND reversed IS TRUE
       GROUP BY company_id
    )
    SELECT t.company_id,
           COUNT(*)::int AS receipts,
           COUNT(*) FILTER (WHERE t.bank_line_id IS NULL)::int AS hand_keyed,
           COUNT(*) FILTER (WHERE t.took_rest)::int AS took_rest,
           COALESCE(SUM(t.amount_sen) FILTER (WHERE t.took_rest), 0)::bigint AS took_rest_sen,
           COUNT(*) FILTER (WHERE t.took_rest AND t.bank_disagrees)::int AS bank_disagrees,
           COALESCE(SUM(t.amount_sen) FILTER (WHERE t.took_rest AND t.bank_disagrees), 0)::bigint AS bank_disagrees_sen,
           COALESCE(MAX(u.n), 0)::int AS undone
      FROM tagged t
      LEFT JOIN undone u ON u.company_id = t.company_id
     GROUP BY t.company_id
     ORDER BY t.company_id`;

  if (rows.length === 0) { notice("No settlement receipts exist in production."); return; }
  for (const r of rows) {
    notice(`company ${r.company_id}: ${r.receipts} receipt(s), ${r.hand_keyed} keyed in by hand`);
    notice(`   took the whole remaining amount: ${r.took_rest} (${rm(r.took_rest_sen)}) - upper bound, blank and unreadable look the same`);
    notice(`   of those, the bank statement shows a different amount: ${r.bank_disagrees} (${rm(r.bank_disagrees_sen)})`);
    notice(`   receipts later undone (reversed SETTLEBANK journals): ${r.undone}`);
  }
}

try {
  await main();
} catch (e) {
  console.error("check failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
