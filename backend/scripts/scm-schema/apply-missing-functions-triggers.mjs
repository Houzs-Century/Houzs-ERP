// Apply scripts/scm-schema/port-missing-functions-triggers.sql — the hand-written
// PL/pgSQL functions + triggers that 2990's raw migrations define but the
// Drizzle-export + views-only port dropped from Houzs's `scm` schema.
//
// ADDITIVE + IDEMPOTENT — only CREATE OR REPLACE FUNCTION / DROP+CREATE TRIGGER.
// Touches no table data. Safe to re-run.
//
//   node scripts/scm-schema/apply-missing-functions-triggers.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }

const ddl = readFileSync("scripts/scm-schema/port-missing-functions-triggers.sql", "utf8");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

const EXPECT_FNS = [
  "upsert_customer_by_name_phone",
  "create_product_with_pricing",
  "rename_sofa_compartment",
  "fn_check_je_balanced",
  "lease_orphan_slips",
  "count_orphan_slips",
  "pin_attempt_check",
  "pin_attempt_fail",
  "pin_attempt_reset",
];

try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL search_path TO scm, public");
    await tx.unsafe(ddl);
  });

  // ── Verify: every function present in scm ──
  const fns = await sql`
    select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='scm' and p.proname = any(${EXPECT_FNS})
    order by p.proname`;
  const got = new Set(fns.map((f) => f.proname));
  console.log("=== FUNCTIONS in scm ===");
  for (const f of EXPECT_FNS) console.log(`  ${got.has(f) ? "OK " : "MISSING "} ${f}`);

  // ── Verify: trigger present ──
  const trg = await sql`
    select count(*)::int c from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='scm' and c.relname='journal_entries'
      and t.tgname='trg_je_balanced' and not t.tgisinternal`;
  console.log(`=== TRIGGER trg_je_balanced ON journal_entries: ${trg[0].c === 1 ? "OK" : "MISSING"} ===`);

  // ── Self-test (rolled back): an unbalanced JE post must be REJECTED ──
  // Uses a real account_code (FK to scm.accounts); skips gracefully if accounts
  // is empty. The guard fires on the journal_entries UPDATE, not the lines.
  const acct = (await sql`select account_code from scm.accounts limit 1`)[0]?.account_code;
  if (!acct) {
    console.log("SELFTEST je-balance guard: SKIPPED (scm.accounts empty)");
  } else try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL search_path TO scm, public");
      const je = await tx`insert into scm.journal_entries (je_no, entry_date, source_type, posted)
        values ('JE-SELFTEST', current_date, 'TEST', false) returning id`;
      const jeId = je[0].id;
      await tx`insert into scm.journal_entry_lines (journal_entry_id, line_no, account_code, debit_sen, credit_sen)
        values (${jeId}, 1, ${acct}, 500, 0)`; // unbalanced: debit 500, credit 0
      let rejected = false;
      try {
        await tx`update scm.journal_entries set posted = true where id = ${jeId}`;
      } catch (e) {
        rejected = /not balanced/i.test(String(e.message));
      }
      console.log(`SELFTEST je-balance guard: unbalanced post ${rejected ? "REJECTED (correct)" : "NOT rejected (PROBLEM)"}`);
      throw new Error("__ROLLBACK__");
    });
  } catch (e) { if (!String(e.message).includes("__ROLLBACK__")) throw e; }

  const allOk = EXPECT_FNS.every((f) => got.has(f)) && trg[0].c === 1;
  console.log(allOk ? "DONE — all objects present." : "DONE — SOME OBJECTS MISSING, review above.");
  if (!allOk) process.exitCode = 3;
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 800));
  process.exitCode = 2;
} finally {
  await sql.end();
}
