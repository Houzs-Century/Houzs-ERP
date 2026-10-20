#!/usr/bin/env node
// check-commission-setup.mjs — READ-ONLY. The two commission calculations as
// they are SET UP in production today, for the owner's 2026-10-20 「顺便可以和我
// 确定一下现在佣金的算法」:
//   1. the PMS event P&L's Commission row — public.project_cost_rates, one rate
//      card per brand (normal %, boost %, the GP% / sales gates for the boost);
//   2. HR › Commission, the salespeople's monthly payout — scm.hr_commission_config
//      (base rate, personal / showroom KPI thresholds + bonuses, manager override,
//      override mode), scm.hr_override_levels, scm.hr_item_kpi (fixed per-item
//      bonuses), scm.hr_salesperson_profiles, and the closed periods
//      (scm.hr_payout_periods) — whether the payout is actually run.
//
// Writes nothing. Env: DATABASE_URL.
//   npx tsx scripts/check-commission-setup.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pct = (bps) => `${Number(bps ?? 0) / 100}%`;

try {
  console.log('1. PMS event rate cards (public.project_cost_rates):');
  const cards = await sql`SELECT * FROM public.project_cost_rates ORDER BY brand`;
  for (const c of cards) {
    console.log(`  ${c.brand}: transport ${c.transport_pct}% · merchandise ${c.merchandise_pct}% · commission ${c.commission_normal_pct}%`
      + (c.commission_boost_pct != null ? ` → boost ${c.commission_boost_pct}% when GP% ≥ ${c.boost_min_gp_pct ?? '(no gate)'} and sales ≥ RM ${c.boost_min_sales ?? '(no gate)'}` : ' (no boost)'));
  }

  console.log('\n2. HR commission config (scm.hr_commission_config):');
  const cfg = await sql`SELECT * FROM scm.hr_commission_config ORDER BY company_id`;
  for (const c of cfg) {
    console.log(`  company ${c.company_id}: base ${pct(c.base_bps)}; personal KPI ≥ RM ${rm(c.personal_kpi_threshold_sen)} → +${pct(c.personal_kpi_bonus_bps)}; showroom KPI ≥ RM ${rm(c.showroom_kpi_threshold_sen)} → +${pct(c.showroom_kpi_bonus_bps)}; manager override ${pct(c.override_base_bps)} (+${pct(c.override_kpi_bonus_bps)} on showroom KPI); mode ${c.override_mode}; updated ${c.updated_at?.toISOString?.() ?? c.updated_at}`);
  }
  const lv = await sql`SELECT company_id, level, rate_bps, label, active FROM scm.hr_override_levels ORDER BY company_id, level`;
  for (const l of lv) console.log(`  override level co ${l.company_id} L${l.level} ${pct(l.rate_bps)} "${l.label}" active=${l.active}`);
  const kpi = await sql`SELECT company_id, flag_type::text AS flag_type, ref, label, bonus_sen, active FROM scm.hr_item_kpi ORDER BY company_id, active DESC, flag_type, ref`;
  const kpiCount = new Map();
  for (const k of kpi) { const key = `co ${k.company_id} ${k.active ? 'active' : 'inactive'}`; kpiCount.set(key, (kpiCount.get(key) ?? 0) + 1); }
  console.log(`  item KPI flags: ${[...kpiCount].map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
  for (const k of kpi.filter((x) => x.active).slice(0, 25)) console.log(`    co ${k.company_id} ${k.flag_type} ${k.ref} "${k.label}" RM ${rm(k.bonus_sen)} each`);
  const prof = await sql`
    SELECT p.company_id, p.tier, count(*)::int AS n, count(DISTINCT p.showroom_id)::int AS rooms
      FROM scm.hr_salesperson_profiles p WHERE p.active GROUP BY 1, 2 ORDER BY 1, 2`;
  for (const p of prof) console.log(`  profiles co ${p.company_id} ${p.tier}: ${p.n} people in ${p.rooms} showroom(s)`);
  const rooms = await sql`
    SELECT s.company_id, s.name, count(p.staff_id)::int AS n
      FROM scm.showrooms s LEFT JOIN scm.hr_salesperson_profiles p ON p.showroom_id = s.id AND p.active
     GROUP BY 1, 2 HAVING count(p.staff_id) > 0 ORDER BY 1, 3 DESC`;
  for (const r of rooms) console.log(`    co ${r.company_id} showroom "${r.name}": ${r.n}`);
  const per = await sql`
    SELECT company_id, period_from::text AS f, period_to::text AS t, revision, status, total_sen, row_count, closed_at
      FROM scm.hr_payout_periods ORDER BY company_id, period_from DESC, revision DESC LIMIT 20`;
  console.log(`  payout periods: ${per.length}`);
  for (const p of per) console.log(`    co ${p.company_id} ${p.f} → ${p.t} rev ${p.revision} ${p.status} RM ${rm(p.total_sen)} (${p.row_count} people) closed ${p.closed_at?.toISOString?.().slice(0, 10) ?? p.closed_at}`);
} finally {
  await sql.end();
}
