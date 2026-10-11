// READ-ONLY report: purchase invoices whose paid_centi exceeds total_centi.
//
// This script writes NOTHING. It runs SELECTs and prints.
//
// WHERE IT CAME FROM: this was scripts/scm-schema/apply-pi-settlement-atomic.mjs,
// whose job was to hand-apply scm.settle_pi_paid_centi. That function now ships
// as migration 0147_scm_settle_pi_paid_centi.sql and is applied automatically by
// the deploy, so the apply half is gone. The reconciliation half is not
// redundant and is kept here.
//
// WHY IT STILL MATTERS: the clamp in settle_pi_paid_centi stops NEW
// over-payments. It deliberately does not and must not rewrite history — an
// invoice already paid past its total is a real discrepancy with a real
// supplier, and someone has to work out what happened to the money. The rows
// below are the damage the race did before the clamp existed. Nothing else in
// the system surfaces them: the books balance, so no reconciliation report
// flags it on its own.
//
// It also reports whether the RPC is actually present, because
// settlePiPaidCenti silently falls back to the legacy read-then-write loop
// when it is absent — a green deploy is not evidence the function landed.
//
// Usage (DATABASE_URL from env, else .dev.vars):
//   node scripts/report-overpaid-purchase-invoices.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const dv = readFileSync(".dev.vars", "utf8");
    return dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  // Is the atomic settle actually there? Absence is not an error — it means
  // this database has not taken migration 0147 yet and the caller is running
  // the legacy path, which can still race.
  const fns = await sql`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'scm' and p.proname = 'settle_pi_paid_centi'`;
  if (fns.length === 0) {
    console.log("MISSING  scm.settle_pi_paid_centi — migration 0147 has not been applied to this database.");
    console.log("         Settlements are running the legacy read-then-write path and can still over-pay.");
    process.exitCode = 3;
  } else {
    for (const f of fns) console.log(`PRESENT  scm.${f.proname}(${f.args})`);
  }

  const over = await sql`
    select id, invoice_number, total_centi, paid_centi
      from scm.purchase_invoices
     where coalesce(paid_centi, 0) > coalesce(total_centi, 0)
       and upper(coalesce(status::text, '')) not in ('DRAFT', 'CANCELLED')
     order by (paid_centi - total_centi) desc
     limit 50`;
  if (over.length === 0) {
    console.log("\nNo already-over-paid purchase invoices found.");
  } else {
    console.log(`\nALREADY OVER-PAID — ${over.length} purchase invoice(s) need reconciling by hand:`);
    for (const r of over) {
      console.log(
        `  ${r.invoice_number}  total ${r.total_centi}  paid ${r.paid_centi}  excess ${r.paid_centi - r.total_centi} sen`,
      );
    }
    console.log("\nThese predate the clamp. The clamp does not unwind them — decide per invoice.");
  }
} catch (err) {
  console.error("REPORT FAILED:", String(err?.message || err).slice(0, 800));
  process.exitCode = 2;
} finally {
  await sql.end();
}
