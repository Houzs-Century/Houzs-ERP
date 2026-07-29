// FAIR PNL final health audit — READ-ONLY. Run after the v8 figure alignment.
// Reports, for non-archived projects starting before 2026-07:
//   1) zero-value anomalies: revenue=0; and for revenue>0 rows, cogs/rental/setup/
//      transport/merchandise/commission = 0 (setup=0 is often legitimate — many
//      Excel rows have no setup — so it is a count + sample, not an error list)
//   2) GP% outside the owner's healthy band (45-60%)
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

async function main() {
  const rows = await sql`
    SELECT p.id, p.created_by AS by, p.brand, p.organizer, p.venue, p.start_date,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income'),0)::bigint AS income,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')),0)::bigint AS cogs,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category='rental'),0)::bigint AS rental,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category='setup'),0)::bigint AS setup,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category='transport_fee'),0)::bigint AS transport,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category='merchandise'),0)::bigint AS merch,
      COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category='commission'),0)::bigint AS comm
    FROM projects p
    LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id ORDER BY p.start_date`;
  const n = Number;
  const tag = (r) => `p${r.id} by=${r.by} ${r.start_date} [${r.brand}] ${r.organizer || "SOLO"} @ ${r.venue}`;
  console.log(`in-scope projects: ${rows.length}\n`);

  const rev0 = rows.filter((r) => n(r.income) === 0);
  console.log(`### REVENUE = 0 : ${rev0.length}`);
  rev0.forEach((r) => console.log(`  ${tag(r)}`));

  const withRev = rows.filter((r) => n(r.income) > 0);
  for (const [label, key] of [["COGS", "cogs"], ["RENTAL", "rental"], ["TRANSPORT", "transport"], ["MERCHANDISE", "merch"], ["COMMISSION", "comm"]]) {
    const z = withRev.filter((r) => n(r[key]) === 0);
    console.log(`\n### ${label} = 0 (revenue>0) : ${z.length}`);
    z.slice(0, 30).forEach((r) => console.log(`  ${tag(r)} income=${r.income}`));
    if (z.length > 30) console.log(`  ... +${z.length - 30} more`);
  }
  const s0 = withRev.filter((r) => n(r.setup) === 0);
  console.log(`\n### SETUP = 0 (revenue>0) : ${s0.length} (often legitimate — Excel has no setup for many events; sample only)`);
  s0.slice(0, 8).forEach((r) => console.log(`  ${tag(r)}`));

  const gp = (r) => (n(r.income) - n(r.cogs)) / n(r.income) * 100;
  const low = withRev.filter((r) => gp(r) < 45).sort((a, b) => gp(a) - gp(b));
  const high = withRev.filter((r) => gp(r) > 60).sort((a, b) => gp(b) - gp(a));
  console.log(`\n### GP < 45% : ${low.length}`);
  low.forEach((r) => console.log(`  GP ${gp(r).toFixed(1).padStart(6)}%  ${tag(r)} inc=${r.income} cogs=${r.cogs}`));
  console.log(`\n### GP > 60% : ${high.length}`);
  high.forEach((r) => console.log(`  GP ${gp(r).toFixed(1).padStart(6)}%  ${tag(r)} inc=${r.income} cogs=${r.cogs}`));
  console.log(`\nband 45-60% OK: ${withRev.length - low.length - high.length}/${withRev.length}`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
