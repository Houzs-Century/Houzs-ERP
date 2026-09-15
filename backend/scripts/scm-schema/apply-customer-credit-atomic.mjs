// Apply scripts/scm-schema/customer-credit-atomic-apply.sql — the atomic
// scm.apply_customer_credit_to_si function that makes "apply credit to SI" a
// single transaction instead of two racy PostgREST writes.
//
// STAGING FIRST (owner rule). Point .dev.vars DATABASE_URL at STAGING, run,
// verify, then repeat against prod:
//   node scripts/scm-schema/apply-customer-credit-atomic.mjs
//
// ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only, touches no table
// data. Safe to re-run. Reloads PostgREST's schema cache so the new RPC is
// callable immediately.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }

const ddl = readFileSync("scripts/scm-schema/customer-credit-atomic-apply.sql", "utf8");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL search_path TO scm, public");
    await tx.unsafe(ddl);
  });

  // Verify the function landed in scm with the expected 6-arg signature.
  const fns = await sql`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'scm' and p.proname = 'apply_customer_credit_to_si'`;
  if (fns.length === 0) {
    console.log("MISSING  scm.apply_customer_credit_to_si");
    process.exitCode = 3;
  } else {
    for (const f of fns) console.log(`OK  scm.${f.proname}(${f.args})`);
  }

  // PostgREST caches the schema; nudge it so sb.rpc() resolves the new function
  // without waiting for the periodic reload.
  await sql`select pg_notify('pgrst', 'reload schema')`;
  console.log("Requested PostgREST schema reload.");
  console.log(fns.length > 0 ? "DONE." : "DONE — function missing, review above.");
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 800));
  process.exitCode = 2;
} finally {
  await sql.end();
}
