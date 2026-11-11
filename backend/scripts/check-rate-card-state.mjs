#!/usr/bin/env node
// check-rate-card-state.mjs — READ ONLY (one READ ONLY transaction; mode=plan only).
// Before the 3PL quotations are keyed into rate cards (owner 2026-11-11 「做」):
// each company's 3PL companies with their supplier link and card, the carrier
// suppliers, each card's settings and rules by type, and the town surcharges of
// each card GROUPED BY EQUAL AMOUNT and ranked cheapest first — no amount is
// printed (public logs), only which towns share a price and the order of prices.
// Env: DATABASE_URL, COMPANY_IDS (default 1,2).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const CARRIERS = /BRIGHTSUN|EIGNRETEP|MSJ|AKEMI|SMART|KEONG|EU LOG/i;

try {
  await sql.begin('read only', async (tx) => {
    for (const CO of COS) {
      const tpl = await tx`
        SELECT t.id, t.code, t.name, t.is_active, s.code AS supplier_code, s.name AS supplier_name
          FROM scm.threepl_companies t LEFT JOIN scm.suppliers s ON s.id = t.supplier_id
         WHERE t.company_id = ${CO} ORDER BY t.name`;
      for (const t of tpl) {
        row('3PL', `co${CO}`, t.code ?? '—', t.name, t.is_active ? 'active' : 'inactive',
          t.supplier_code ? `supplier ${t.supplier_code} ${t.supplier_name}` : 'no supplier link');
      }
      const sups = await tx`SELECT code, name FROM scm.suppliers WHERE company_id = ${CO} AND name ~* ${CARRIERS.source} ORDER BY name`;
      for (const s of sups) row('SUPPLIER', `co${CO}`, s.code ?? '—', s.name);

      const cards = await tx`
        SELECT c.id, c.name, c.is_active, c.basis, c.aggregation, c.rounding, c.min_charge_sen, c.cap_sen, c.is_own_fleet,
               t.name AS carrier
          FROM scm.delivery_rate_cards c LEFT JOIN scm.threepl_companies t ON t.id = c.carrier_company_id
         WHERE c.company_id = ${CO} ORDER BY c.name`;
      for (const c of cards) {
        const rules = await tx`
          SELECT rule_type, tier_position, bracket_min, bracket_max, zone, amount_sen
            FROM scm.delivery_rate_rules WHERE card_id = ${c.id} ORDER BY rule_type, sort_order, zone`;
        const byType = {};
        for (const r of rules) byType[r.rule_type] = (byType[r.rule_type] ?? 0) + 1;
        row('CARD', `co${CO}`, c.name, `carrier ${c.carrier ?? '—'}`, c.is_active ? 'active' : 'inactive',
          `basis ${c.basis}`, `aggregation ${c.aggregation}`, `rounding ${c.rounding}`,
          `min ${c.min_charge_sen == null ? 'none' : 'set'}`, `cap ${c.cap_sen == null ? 'none' : 'set'}`,
          Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(', ') || 'no rules');

        const tiers = rules.filter((r) => r.rule_type === 'POSITIONAL_TIER').sort((a, b) => a.tier_position - b.tier_position);
        if (tiers.length) {
          const first = Number(tiers[0].amount_sen);
          row('LADDER', c.name, tiers.map((t) => `pos ${t.tier_position}: ${Number(t.amount_sen) === 0 ? 'zero' : Number(t.amount_sen) === first ? 'same as pos 1' : Number(t.amount_sen) < first ? 'below pos 1' : 'above pos 1'}`).join('; '));
        }
        const sofas = rules.filter((r) => r.rule_type === 'SOFA_BRACKET').sort((a, b) => a.bracket_min - b.bracket_min);
        if (sofas.length) row('SOFA', c.name, sofas.map((s) => `${s.bracket_min}-${s.bracket_max ?? '+'}`).join(', '),
          sofas.length > 1 ? (Number(sofas[1].amount_sen) > Number(sofas[0].amount_sen) ? 'larger band dearer' : 'larger band not dearer') : '');
        for (const type of ['DISPOSE', 'SETUP', 'DISMANTLE', 'SERVICE', 'PICKUP', 'INSPECTION', 'SUPPLIER_PICKUP', 'TRANSFER', 'OVERAGE']) {
          const n = rules.filter((r) => r.rule_type === type).length;
          if (n) row('OTHER', c.name, type, n);
        }
        for (const type of ['OUTSTATION', 'OUTSTATION_TRIP']) {
          const towns = rules.filter((r) => r.rule_type === type);
          if (!towns.length) continue;
          const groups = new Map();
          for (const r of towns) {
            const k = Number(r.amount_sen);
            groups.set(k, [...(groups.get(k) ?? []), String(r.zone ?? '').toUpperCase()]);
          }
          const ranked = [...groups.entries()].sort((a, b) => a[0] - b[0]);
          ranked.forEach(([, zs], i) => row(type, c.name, `G${i + 1} of ${ranked.length}`, `${zs.length} towns`, zs.sort().join(', ')));
        }
      }
      const charges = await tx`
        SELECT t.name, count(*)::int AS n, min(x.created_at)::date AS first, max(x.created_at)::date AS last
          FROM scm.threepl_do_charges x JOIN scm.threepl_companies t ON t.id = x.threepl_company_id
         WHERE x.company_id = ${CO} GROUP BY t.name ORDER BY t.name`;
      for (const ch of charges) row('DO_CHARGES', `co${CO}`, ch.name, `${ch.n} DO charges`, `${ch.first}..${ch.last}`);
      if (!charges.length) row('DO_CHARGES', `co${CO}`, 'none');
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
