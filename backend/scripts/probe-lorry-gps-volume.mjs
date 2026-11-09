// Read-only: how many GPS fixes each lorry sends per Malaysia day, how far apart
// they are in time and distance, and how many are "moving" (not a parked repeat).
// Sizes the cost of drawing each lorry's driven path along the roads.
//
// Strictly SELECTs on scm.lorry_positions. No DDL, no writes, no transaction.
// Exits 0 for every answer; non-zero only if the database cannot be reached.
// RE-RUN: a second run reads again and prints the same shape; it writes nothing.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 15 });

try {
  const [span] = await sql`
    select count(*)::int as rows, count(distinct lorry_id)::int as lorries,
           min(recorded_at) as first_fix, max(recorded_at) as last_fix
      from scm.lorry_positions`;
  console.log("TABLE", JSON.stringify(span));

  const perDay = await sql`
    with f as (
      select lorry_id, (recorded_at at time zone 'Asia/Kuala_Lumpur')::date as d, recorded_at, lat, lng, speed_kmh,
             lag(recorded_at) over w as prev_at, lag(lat) over w as plat, lag(lng) over w as plng
        from scm.lorry_positions
       where recorded_at >= now() - interval '14 days'
      window w as (partition by lorry_id, (recorded_at at time zone 'Asia/Kuala_Lumpur')::date order by recorded_at)
    ), g as (
      select lorry_id, d, count(*)::int as fixes,
             count(*) filter (where prev_at is not null and (abs(lat - plat) > 0.0002 or abs(lng - plng) > 0.0002))::int as moved,
             percentile_cont(0.5) within group (order by extract(epoch from recorded_at - prev_at)) filter (where prev_at is not null) as med_gap_s,
             percentile_cont(0.5) within group (order by 111320 * sqrt(power(lat - plat, 2) + power((lng - plng) * cos(radians(lat)), 2)))
               filter (where prev_at is not null and (abs(lat - plat) > 0.0002 or abs(lng - plng) > 0.0002)) as med_move_m,
             percentile_cont(0.9) within group (order by 111320 * sqrt(power(lat - plat, 2) + power((lng - plng) * cos(radians(lat)), 2)))
               filter (where prev_at is not null and (abs(lat - plat) > 0.0002 or abs(lng - plng) > 0.0002)) as p90_move_m
        from f group by lorry_id, d
    )
    select d, count(*)::int as lorry_days, sum(fixes)::int as fixes, sum(moved)::int as moved_fixes,
           round(avg(fixes))::int as avg_fixes_per_lorry, round(avg(moved))::int as avg_moved_per_lorry,
           round(avg(med_gap_s))::int as med_gap_s, round(avg(med_move_m))::int as med_move_m, round(avg(p90_move_m))::int as p90_move_m
      from g group by d order by d`;
  console.log("PER_DAY (last 14 Malaysia days)");
  for (const r of perDay) console.log(JSON.stringify(r));
} finally {
  await sql.end();
}
