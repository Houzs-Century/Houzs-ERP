#!/usr/bin/env node
// check-own-lorry-cost-data.mjs — READ ONLY. What our own lorries' cost could be
// counted from (owner 2026-10-29: 自己罗厘的成本（油、过路费、司机）就默认 internal
// 成本…这些费用也要算，因为我每一张送货都有 assign 谁送（可能是 lorry no. plate)):
// who each DO is assigned to (scm.delivery_order_crew: lorry + drivers + helpers),
// own vs outside lorries, and the GL accounts that hold fuel / toll / driver / lorry
// costs with their monthly totals. Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-09-01).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const [dk] = await sql`SELECT * FROM scm.drivers LIMIT 1`;
  out(`drivers columns: ${dk ? Object.keys(dk).join(', ') : '(no rows)'}`);
  const [lk] = await sql`SELECT * FROM scm.lorries LIMIT 1`;
  out(`lorries columns: ${lk ? Object.keys(lk).join(', ') : '(no rows)'}`);
  for (const r of await sql`SELECT is_internal, active, count(*)::int AS n, string_agg(plate, ', ' ORDER BY plate) AS plates FROM scm.lorries GROUP BY 1, 2 ORDER BY 1, 2`) {
    out(`lorries internal=${r.is_internal} active=${r.active}: ${r.n} — ${String(r.plates).slice(0, 300)}`);
  }
  for (const r of await sql`
    SELECT to_char(d.do_date, 'YYYY-MM') AS ym, d.status, count(*)::int AS n,
           count(c.id)::int AS with_crew, count(c.lorry_id)::int AS with_lorry,
           count(*) FILTER (WHERE l.is_internal)::int AS own_lorry, count(*) FILTER (WHERE l.is_internal = false)::int AS outside_lorry,
           count(c.driver_1_id)::int AS with_driver, count(*) FILTER (WHERE coalesce(c.lorry_plate, '') <> '')::int AS with_plate,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.threepl_do_charges x WHERE x.do_id = d.id))::int AS threepl_charged
      FROM scm.delivery_orders d
      LEFT JOIN scm.delivery_order_crew c ON c.do_id = d.id
      LEFT JOIN scm.lorries l ON l.id = c.lorry_id
     WHERE d.company_id = ${CO} AND d.do_date >= ${FROM}::date
     GROUP BY 1, 2 ORDER BY 1, 2`) {
    out(`DOs ${r.ym} ${r.status}: ${r.n} | crew ${r.with_crew}, lorry ${r.with_lorry} (own ${r.own_lorry}, outside ${r.outside_lorry}), plate ${r.with_plate}, driver ${r.with_driver}, 3PL-charged ${r.threepl_charged}`);
  }
  for (const r of await sql`
    SELECT coalesce(nullif(c.lorry_plate, ''), l.plate, '(none)') AS plate, l.is_internal, count(*)::int AS n,
           count(DISTINCT coalesce(d.delivered_at::date, d.do_date))::int AS days
      FROM scm.delivery_orders d
      LEFT JOIN scm.delivery_order_crew c ON c.do_id = d.id
      LEFT JOIN scm.lorries l ON l.id = c.lorry_id
     WHERE d.company_id = ${CO} AND d.do_date >= ${FROM}::date AND d.status <> 'CANCELLED'
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`) {
    out(`plate ${r.plate} internal=${r.is_internal}: ${r.n} DOs on ${r.days} days`);
  }
  for (const r of await sql`
    SELECT coalesce(c.driver_1_name, '(none)') AS driver, count(*)::int AS n
      FROM scm.delivery_orders d LEFT JOIN scm.delivery_order_crew c ON c.do_id = d.id
     WHERE d.company_id = ${CO} AND d.do_date >= ${FROM}::date AND d.status <> 'CANCELLED'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 25`) {
    out(`driver ${r.driver}: ${r.n} DOs`);
  }
  for (const r of await sql`
    SELECT v.account_code, v.account_name, to_char(v.entry_date, 'YYYY-MM') AS ym,
           count(*)::int AS n, coalesce(sum(v.debit_sen - v.credit_sen), 0)::bigint AS net
      FROM scm.v_gl_entries v
     WHERE v.company_id = ${CO} AND v.entry_date >= ${FROM}::date AND NOT v.opening
       AND (v.account_name ~* '(petrol|fuel|diesel|toll|lorry|driver|motor|vehicle|upkeep|road ?tax|puspakom|parking|transport|delivery|helper|outstation|travel)')
     GROUP BY 1, 2, 3 ORDER BY 1, 3`) {
    out(`GL ${r.account_code} ${r.account_name} ${r.ym}: ${r.n} lines, net RM ${rm(r.net)}`);
  }
  for (const r of await sql`
    SELECT account_code, account_name, account_type, is_active FROM scm.accounts
     WHERE company_id = ${CO} AND account_name ~* '(petrol|fuel|diesel|toll|lorry|driver|motor|vehicle|upkeep|road ?tax|puspakom|salar|wage|allowance|overtime|epf|socso)'
     ORDER BY account_code`) {
    out(`chart ${r.account_code} ${r.account_name} (${r.account_type}${r.is_active ? '' : ', inactive'})`);
  }
} finally {
  await sql.end();
}
