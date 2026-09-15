// Apply scripts/scm-schema/audit-sink-probe.sql — the scm.entity_audit_writable
// function that lets a handler ask "is the audit trail writable?" BEFORE it
// changes a document, so a refusal can honestly say nothing was changed.
//
// STAGING FIRST (owner rule). Point .dev.vars DATABASE_URL at STAGING, run,
// verify, then repeat against prod:
//   node scripts/scm-schema/apply-audit-sink-probe.mjs
//
// ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only, touches no table
// data. Safe to re-run. Reloads PostgREST's schema cache so the new RPC is
// callable immediately.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }

const ddl = readFileSync("scripts/scm-schema/audit-sink-probe.sql", "utf8");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL search_path TO scm, public");
    await tx.unsafe(ddl);
  });

  const fns = await sql`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'scm' and p.proname = 'entity_audit_writable'`;
  if (fns.length === 0) {
    console.log("MISSING  scm.entity_audit_writable");
    process.exitCode = 3;
  } else {
    for (const f of fns) console.log(`OK  scm.${f.proname}(${f.args})`);
  }

  // Behavioural check: the probe must answer true on a healthy sink AND must not
  // leave the row behind. A function that reports true while committing probe
  // rows would quietly pollute an append-only audit trail, so verify the count is
  // unchanged rather than trusting the return value alone.
  if (fns.length > 0) {
    const [{ count: before }] = await sql`select count(*)::int as count from scm.entity_audit_log`;
    const [{ ok }] = await sql`select scm.entity_audit_writable('PROBE', 'apply-script', 'UPDATE', NULL) as ok`;
    const [{ count: after }] = await sql`select count(*)::int as count from scm.entity_audit_log`;
    console.log(`probe returned ${ok}; rows before=${before} after=${after}`);
    if (ok !== true) { console.log("WARNING  probe reported the audit sink is NOT writable."); process.exitCode = 4; }
    if (after !== before) { console.log("WARNING  probe LEFT A ROW BEHIND — do not ship."); process.exitCode = 5; }
  }

  await sql`select pg_notify('pgrst', 'reload schema')`;
  console.log("Requested PostgREST schema reload.");
  console.log(process.exitCode ? "DONE — review the warnings above." : "DONE.");
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 800));
  process.exitCode = 2;
} finally {
  await sql.end();
}
