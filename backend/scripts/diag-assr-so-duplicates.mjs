#!/usr/bin/env node
// One-shot READ-ONLY probe: how many Service Cases share an SO (doc_no)?
// Owner 2026-07-27 — intake keeps re-creating cases for orders that
// already have one; this measures how widespread the duplication is
// before/after the create-intake warning ships.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  console.log("=== assr_cases totals ===");
  const [tot] = await db`
    SELECT count(*)::int AS all_cases,
           count(*) FILTER (WHERE archived_at IS NULL)::int AS live_cases,
           count(DISTINCT LOWER(doc_no)) FILTER (WHERE archived_at IS NULL)::int AS live_sos
    FROM assr_cases`;
  console.log(`  cases(all)=${tot.all_cases}  cases(non-archived)=${tot.live_cases}  distinct SOs(non-archived)=${tot.live_sos}`);

  console.log("\n=== SOs carrying >1 non-archived case (the duplicates) ===");
  const dups = await db`
    SELECT LOWER(doc_no) AS so, count(*)::int AS n,
           count(*) FILTER (WHERE stage IS NULL OR stage <> 'completed')::int AS still_open
    FROM assr_cases
    WHERE archived_at IS NULL
    GROUP BY LOWER(doc_no)
    HAVING count(*) > 1
    ORDER BY n DESC, so`;
  console.log(`  ${dups.length} SOs have more than one case`);
  const multiOpen = dups.filter((d) => d.still_open > 1);
  console.log(`  ${multiOpen.length} of those have >1 case STILL OPEN (worst offenders)`);

  console.log("\n=== detail: every duplicated SO and its cases ===");
  for (const d of dups) {
    const rows = await db`
      SELECT assr_no, stage, status, created_at,
             LEFT(COALESCE(complaint_issue, ''), 60) AS issue
      FROM assr_cases
      WHERE LOWER(doc_no) = ${d.so} AND archived_at IS NULL
      ORDER BY id`;
    console.log(`  ${d.so}  (${d.n} cases, ${d.still_open} open)`);
    for (const r of rows) {
      console.log(`    ${r.assr_no}  stage=${r.stage}  status=${r.status}  ${r.created_at?.toISOString().slice(0, 10)}  ${r.issue.replace(/\s+/g, " ")}`);
    }
  }
}

main().then(() => db.end()).catch(async e => {
  console.error("PROBE_FAIL", e.message);
  await db.end();
  process.exit(1);
});
