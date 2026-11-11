#!/usr/bin/env node
// check-outstation-towns.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11 on Carriers & Rates: 「outstation 的可以确定一下吗？这个是outstation 是
// supplier 提供给我的quotation，他是align with我这里set 的吗？」 — the towns a 3PL's
// quotation prices (a rate card's OUTSTATION rules) against the system's own places:
// the localities master (scm.my_localities: state / city / postcode, the Geo &
// Warehouses screen) and the 14 area zones. Pricing finds an outstation rule by the
// delivery's area zone, or by the rule's town appearing as a word in the delivery
// address (backend scm/lib/delivery-rate-card.ts townsInAddress), so the last part
// reads recent East Malaysia orders' addresses the same way.
// Prints place names and counts — no money (public logs).
// Env: DATABASE_URL, COMPANY_IDS (default 1,2), DAYS (default 120).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const DAYS = Number(process.env.DAYS || 120);
const ZONES = new Set(['KL', 'PJ', 'KLANG', 'KAJANG', 'RAWANG', 'PUCHONG', 'NS', 'MELAKA', 'JOHOR', 'PENANG', 'KEDAH', 'PERAK', 'PAHANG', 'EAST']);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const words = (s) => ` ${norm(s)} `;
const eastPostcode = (p) => { const m = /(?<!\d)(\d{5})(?!\d)/.exec(String(p ?? '')); if (!m) return false; const n = Number(m[1].slice(0, 2)); return n >= 87 && n <= 98; };

try {
  await sql.begin('read only', async (tx) => {
    const loc = await tx`SELECT DISTINCT upper(state) AS state, upper(city) AS city FROM scm.my_localities WHERE city IS NOT NULL`;
    const statesOfCity = new Map();
    for (const l of loc) {
      const c = norm(l.city);
      if (!statesOfCity.has(c)) statesOfCity.set(c, new Set());
      statesOfCity.get(c).add(norm(l.state));
    }
    row('LOCALITIES', `cities ${statesOfCity.size}`, `states ${new Set(loc.map((l) => norm(l.state))).size}`);

    for (const CO of COS) {
      const cards = await tx`
        SELECT c.id, c.name, c.is_active, t.name AS carrier
          FROM scm.delivery_rate_cards c LEFT JOIN scm.threepl_companies t ON t.id = c.carrier_company_id
         WHERE c.company_id = ${CO} ORDER BY c.name`;
      for (const card of cards) {
        const rules = await tx`SELECT rule_type, zone FROM scm.delivery_rate_rules
                                WHERE card_id = ${card.id} AND rule_type IN ('OUTSTATION', 'OUTSTATION_TRIP') AND zone IS NOT NULL`;
        if (rules.length === 0) { row('CARD', `co${CO}`, card.carrier ?? card.name, card.is_active ? 'active' : 'inactive', 'no outstation towns'); continue; }
        const towns = [...new Set(rules.map((r) => norm(r.zone)))].sort();
        const asZone = towns.filter((t) => ZONES.has(t));
        const asCity = towns.filter((t) => !ZONES.has(t) && statesOfCity.has(t));
        const missing = towns.filter((t) => !ZONES.has(t) && !statesOfCity.has(t));
        const states = new Map();
        for (const t of asCity) for (const s of statesOfCity.get(t)) states.set(s, (states.get(s) ?? 0) + 1);
        row('CARD', `co${CO}`, card.carrier ?? card.name, card.is_active ? 'active' : 'inactive', `towns ${towns.length}`,
          `per trip rules ${rules.filter((r) => r.rule_type === 'OUTSTATION_TRIP').length}`,
          `are area zones ${asZone.length}`, `are system cities ${asCity.length}`, `not in the system ${missing.length}`,
          `cities found in ${[...states].map(([s, n]) => `${s} ${n}`).join(', ') || '—'}`);
        /* A town the system does not know: its nearest system names, as a hint. */
        for (const t of missing) {
          const near = [...statesOfCity.keys()].filter((c) => c.includes(t) || t.includes(c) || c.replace(/ /g, '') === t.replace(/ /g, '')).slice(0, 3);
          row('NOT_IN_SYSTEM', `co${CO}`, card.carrier ?? card.name, t, near.length ? `closest: ${near.join(' ; ')}` : 'no close name');
        }
        /* The system's cities in those states the card prices nothing for. */
        for (const [s] of states) {
          const unpriced = [...statesOfCity].filter(([c, ss]) => ss.has(s) && !towns.includes(c)).map(([c]) => c).sort();
          row('SYSTEM_CITIES_NO_PRICE', `co${CO}`, card.carrier ?? card.name, s, `cities ${unpriced.length}`, unpriced.slice(0, 60).join(', '));
        }

        /* Recent East Malaysia orders: would pricing find a town of this card in the address? */
        const orders = await tx`
          SELECT to_jsonb(o) AS j FROM scm.mfg_sales_orders o
           WHERE o.company_id = ${CO} AND o.created_at > now() - make_interval(days => ${DAYS})`;
        const east = orders.map((r) => r.j).filter((j) => /SABAH|SARAWAK|LABUAN/i.test(String(j.state ?? j.address4 ?? '') + ' ' + String(j.address3 ?? '')) || eastPostcode(j.postcode) || eastPostcode(`${j.address1 ?? ''} ${j.address2 ?? ''} ${j.address3 ?? ''}`));
        let hit = 0;
        const missCity = new Map();
        for (const j of east) {
          const text = words([j.address1, j.address2, j.address3, j.address4, j.city].filter(Boolean).join(' '));
          if (towns.some((t) => text.includes(` ${t} `))) { hit += 1; continue; }
          const city = norm(j.city ?? '') || '(no city)';
          missCity.set(city, (missCity.get(city) ?? 0) + 1);
        }
        row('ORDERS', `co${CO}`, card.carrier ?? card.name, `last ${DAYS} days East Malaysia orders ${east.length}`, `address names a town on the card ${hit}`,
          `does not ${east.length - hit}`, [...missCity].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, n]) => `${c} ${n}`).join(', ') || '—');
      }
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
