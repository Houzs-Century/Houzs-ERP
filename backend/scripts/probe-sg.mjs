/* SPENT PROBE — kept for the record, not as a tool.
   
   This was a probe for the correct Singapore pooler host, same move.
   It answered its question at the time and nothing reaches it now: no npm
   script, no workflow, no doc, no import.
   
   It is read-only, so running it is not dangerous — but it probes an
   environment that has since moved, so what it prints is unlikely to mean
   what its output says it means. */
// Find the correct Singapore pooler host for the new SG project and confirm
// it's reachable + empty. Tries aws-0 and aws-1 (same region can be either).
import postgres from "postgres";

const REF = "anogrigyjbduyzclzjgn";
const PW = process.argv[2];
if (!PW) { console.error("usage: node scripts/probe-sg.mjs <db-password>"); process.exit(2); }

const hosts = [
  "aws-0-ap-southeast-1.pooler.supabase.com",
  "aws-1-ap-southeast-1.pooler.supabase.com",
];

for (const host of hosts) {
  const url = `postgresql://postgres.${REF}:${PW}@${host}:5432/postgres`;
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 12, idle_timeout: 2 });
  try {
    const t0 = Date.now();
    const [{ one }] = await sql`SELECT 1 AS one`;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`;
    console.log(`OK  ${host}:5432  -> SELECT 1=${one} (${Date.now() - t0}ms), public tables=${n}`);
  } catch (e) {
    console.log(`FAIL ${host}:5432  -> ${String(e.message || e).slice(0, 70)}`);
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
}
process.exit(0);
