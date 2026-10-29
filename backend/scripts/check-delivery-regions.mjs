#!/usr/bin/env node
// check-delivery-regions.mjs — READ ONLY. One company's delivery-planning regions
// and the states in each, and its DOs of a range by state → the region the
// Logistics cost report puts them in (owner 2026-10-29: region 分类好像不太对).
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-10-01), TO (2026-10-31).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-10-01');
const TO = String(process.env.TO || '2026-10-31');
const out = (s) => console.log(`ROW|${s}`);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  for (const r of await sql`
    SELECT g.code, g.name, g.sort_order, g.active, string_agg(s.state_key, ', ' ORDER BY s.state_key) AS states
      FROM scm.delivery_planning_regions g LEFT JOIN scm.state_delivery_regions s ON s.region_id = g.id AND s.company_id = g.company_id
     WHERE g.company_id = ${CO} GROUP BY 1, 2, 3, 4 ORDER BY 3, 1`) {
    out(`region ${r.code} "${r.name}" sort ${r.sort_order}${r.active ? '' : ' (inactive)'}: ${r.states ?? '-'}`);
  }
  for (const r of await sql`
    SELECT coalesce(nullif(trim(d.state), ''), '(none)') AS state, count(*)::int AS n,
           string_agg(DISTINCT coalesce(nullif(trim(d.city), ''), '?'), ', ') AS cities
      FROM scm.delivery_orders d
     WHERE d.company_id = ${CO} AND d.status <> 'CANCELLED'
       AND coalesce(d.customer_delivery_date, d.do_date) BETWEEN ${FROM}::date AND ${TO}::date
     GROUP BY 1 ORDER BY 2 DESC`) {
    out(`DO state ${r.state}: ${r.n} — cities ${String(r.cities).slice(0, 160)}`);
  }
} finally {
  await sql.end();
}
