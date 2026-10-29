#!/usr/bin/env node
// check-logistics-report-data.mjs — READ ONLY. What a logistics cost report could
// stand on today (owner 2026-10-29: 物流报告 — 按地区、每趟、setup & dismantle,
// 「都需要」): the 3PL bill lines and how they are assigned, the DO charges, the
// transport suppliers' AP invoices, the DOs' states and regions, the trips and
// their stops, and setup/dismantle cost on events. Env: DATABASE_URL, FROM (2026-08-01).
import postgres from 'postgres';

const FROM = String(process.env.FROM || '2026-08-01');
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  out(`from ${FROM}`);
  for (const r of await sql`
    SELECT company_id, coalesce(assign, '(open)') AS assign, count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen,
           count(DISTINCT ap_invoice_id)::int AS bills, coalesce(sum(cardinality(do_ids)), 0)::int AS dos,
           count(*) FILTER (WHERE project_id IS NOT NULL)::int AS with_event
      FROM scm.threepl_bill_lines GROUP BY 1, 2 ORDER BY 1, 2`) {
    out(`bill lines co ${r.company_id} ${r.assign}: ${r.n} lines RM ${rm(r.sen)} on ${r.bills} bills, ${r.dos} DO links, ${r.with_event} with an event`);
  }
  for (const r of await sql`
    SELECT company_id, count(*)::int AS n, coalesce(sum(billed_sen), 0)::bigint AS sen, count(*) FILTER (WHERE ap_invoice_id IS NOT NULL)::int AS from_ap
      FROM scm.threepl_do_charges GROUP BY 1 ORDER BY 1`) {
    out(`DO charges co ${r.company_id}: ${r.n} rows RM ${rm(r.sen)}, ${r.from_ap} from AP invoices`);
  }
  for (const r of await sql`
    SELECT i.company_id, to_char(i.invoice_date, 'YYYY-MM') AS ym, count(DISTINCT i.id)::int AS bills, coalesce(sum(i.total_sen), 0)::bigint AS sen,
           count(DISTINCT i.id) FILTER (WHERE EXISTS (SELECT 1 FROM scm.threepl_bill_lines b WHERE b.ap_invoice_id = i.id))::int AS read
      FROM scm.ap_invoices i JOIN scm.threepl_companies t ON t.supplier_id = i.supplier_id AND t.company_id = i.company_id
     WHERE i.status <> 'CANCELLED' AND i.invoice_date >= ${FROM}::date
     GROUP BY 1, 2 ORDER BY 1, 2`) {
    out(`3PL AP invoices co ${r.company_id} ${r.ym}: ${r.bills} bills RM ${rm(r.sen)}, ${r.read} read into lines`);
  }
  for (const r of await sql`
    SELECT d.company_id, to_char(d.do_date, 'YYYY-MM') AS ym, count(*)::int AS n,
           count(*) FILTER (WHERE coalesce(trim(d.state), '') <> '')::int AS with_state,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.trip_stops s WHERE s.do_id = d.id))::int AS on_trip
      FROM scm.delivery_orders d WHERE d.do_date >= ${FROM}::date GROUP BY 1, 2 ORDER BY 1, 2`) {
    out(`DOs co ${r.company_id} ${r.ym}: ${r.n}, with a state ${r.with_state}, on a trip ${r.on_trip}`);
  }
  for (const r of await sql`
    SELECT d.company_id, coalesce(nullif(trim(d.state), ''), '(none)') AS state, count(*)::int AS n
      FROM scm.delivery_orders d WHERE d.do_date >= ${FROM}::date GROUP BY 1, 2 ORDER BY 1, 3 DESC LIMIT 40`) {
    out(`DO state co ${r.company_id}: ${r.state} ${r.n}`);
  }
  for (const r of await sql`
    SELECT g.code, g.name, string_agg(DISTINCT s.state_key, ', ') AS states
      FROM scm.delivery_planning_regions g LEFT JOIN scm.state_delivery_regions s ON s.region_id = g.id
     WHERE g.active GROUP BY g.code, g.name, g.sort_order ORDER BY g.sort_order`) {
    out(`region ${r.code} ${r.name}: ${r.states ?? '-'}`);
  }
  for (const r of await sql`
    SELECT to_char(t.trip_date, 'YYYY-MM') AS ym, t.is_outsourced, count(*)::int AS trips,
           coalesce(sum((SELECT count(*) FROM scm.trip_stops s WHERE s.trip_id = t.id AND s.do_id IS NOT NULL)), 0)::int AS do_stops
      FROM scm.trips t WHERE t.trip_date >= ${FROM}::date GROUP BY 1, 2 ORDER BY 1, 2`) {
    out(`trips ${r.ym} ${r.is_outsourced ? 'outsourced' : 'own'}: ${r.trips}, DO stops ${r.do_stops}`);
  }
  for (const r of await sql`
    SELECT i.company_id, l.debit_account_code AS acct, a.account_name, count(*)::int AS n, coalesce(sum(l.amount_sen), 0)::bigint AS sen,
           count(*) FILTER (WHERE l.project_id IS NOT NULL)::int AS with_event
      FROM scm.ap_invoice_lines l JOIN scm.ap_invoices i ON i.id = l.invoice_id
      LEFT JOIN scm.accounts a ON a.company_id = i.company_id AND a.account_code = l.debit_account_code
     WHERE i.status <> 'CANCELLED' AND i.invoice_date >= ${FROM}::date
       AND (l.debit_account_code LIKE '900-T%' OR l.debit_account_code LIKE '900-B%' OR a.account_name ILIKE '%transport%'
            OR a.account_name ILIKE '%set up%' OR a.account_name ILIKE '%setup%' OR a.account_name ILIKE '%dismantl%' OR a.account_name ILIKE '%lorry%')
     GROUP BY 1, 2, 3 ORDER BY 1, 5 DESC LIMIT 40`) {
    out(`AP lines co ${r.company_id} ${r.acct} ${r.account_name ?? '?'}: ${r.n} lines RM ${rm(r.sen)}, ${r.with_event} with an event`);
  }
} finally {
  await sql.end();
}
