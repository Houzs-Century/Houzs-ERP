#!/usr/bin/env node
// check-places-alignment.mjs — READ ONLY (mode=plan only; one READ ONLY transaction).
// Owner 2026-11-11: the 3PL rate cards use the Delivery Zones areas (做). After the
// towns the cards price are filed under their zones (scm.delivery_places), this checks
// them against the company's real orders of the last 12 months:
//   PLACE   each place: of the orders whose address spells it, the share whose postcode
//           zone is the place's zone. A low share is a street named after the town in
//           another zone (Jalan Ipoh in Kuala Lumpur) or a town filed under the wrong zone.
//   CARD    each card's towns re-read on those orders, the old way (a word anywhere in
//           the address) and the new (a town only inside its zone, a zone by postcode):
//           the share of orders whose towns change, and the first order numbers that
//           change, to look at on the page.
// Prints town and card names, zone names, shares and order numbers only — no amounts,
// no customers, no addresses. Env: DATABASE_URL, COMPANY_ID (default 1), MONTHS (default 12).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 1);
const MONTHS = Math.max(1, Math.min(36, Number(process.env.MONTHS || 12)));
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const pct = (n, d) => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);
const bucket = (n) => (n === 0 ? '0' : n < 10 ? '1-9' : n < 100 ? '10-99' : '100+');
const words = (v) => ` ${String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
const spelled = (text, name) => text.includes(words(name));

/* The classifier's rule (scm/lib/zone-classify.ts): a 5-digit postcode from the
   postcode field, then address2, then address1; the narrowest prefix range wins,
   ties to the earlier rule. */
const postcodeOf = (...vals) => {
  for (const v of vals) { const m = /(?<!\d)(\d{5})(?!\d)/.exec(String(v ?? '')); if (m) return m[1]; }
  return null;
};
const zoneFor = (pc, map) => {
  if (!pc) return null;
  const p = Number(pc.slice(0, 2));
  let best = null; let width = Infinity;
  for (const r of map) {
    if (p < r.start || p > r.end) continue;
    const w = r.end - r.start;
    if (w < width) { best = r; width = w; }
  }
  return best ? best.zone : null;
};

try {
  await sql.begin('read only', async (tx) => {
    const mapRows = await tx`
      SELECT zone, prefix_start, prefix_end FROM scm.delivery_zone_postcodes
       WHERE company_id = ${CO} AND is_active ORDER BY id`;
    const map = mapRows.map((r) => ({ zone: String(r.zone), start: Number(r.prefix_start), end: Number(r.prefix_end) }));
    const zoneNames = new Set(map.map((r) => r.zone));
    const places = await tx`SELECT name, zone FROM scm.delivery_places WHERE company_id = ${CO} ORDER BY name`;
    const home = new Map(places.map((p) => [String(p.name), p.zone == null ? null : String(p.zone)]));
    row('MAP', `co${CO}`, `${map.length} rules`, `${zoneNames.size} zones`, `${places.length} places`);

    const orders = await tx`
      SELECT doc_no, postcode, address1, address2, address3, address4, city FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND so_date >= (current_date - make_interval(months => ${MONTHS}))`;
    const read = orders.map((o) => ({
      doc: String(o.doc_no),
      zone: zoneFor(postcodeOf(o.postcode, o.address2, o.address1), map),
      text: words([o.address1, o.address2, o.address3, o.address4, o.city, o.postcode].filter(Boolean).join(' ')),
    }));
    row('ORDERS', `last ${MONTHS} months`, bucket(read.length), `with a zone ${pct(read.filter((o) => o.zone).length, read.length)}`);

    /* PLACE: where the orders that spell each place lie. */
    for (const p of places) {
      const hits = read.filter((o) => spelled(o.text, p.name));
      const same = hits.filter((o) => o.zone && o.zone === p.zone).length;
      const other = hits.filter((o) => o.zone && o.zone !== p.zone).length;
      const none = hits.length - same - other;
      row('PLACE', p.name, p.zone ?? 'no zone', `orders ${bucket(hits.length)}`, `in its zone ${pct(same, hits.length)}`, `elsewhere ${pct(other, hits.length)}`, `no zone ${pct(none, hits.length)}`);
      if (p.zone && hits.length >= 3 && same < hits.length / 2) {
        const where = {};
        for (const o of hits) if (o.zone && o.zone !== p.zone) where[o.zone] = (where[o.zone] ?? 0) + 1;
        row('LOOK', p.name, `mostly elsewhere: ${Object.entries(where).sort((a, b) => b[1] - a[1]).map(([z]) => z).slice(0, 3).join(', ')}`);
      }
    }

    /* CARD: each card's towns, old reading against new. */
    const reaches = (name, o) => {
      if (zoneNames.has(name)) return o.zone ? o.zone === name : spelled(o.text, name);
      if (!home.has(name)) return spelled(o.text, name);
      const h = home.get(name);
      return spelled(o.text, name) && (h === null || o.zone === null || o.zone === h);
    };
    const cards = await tx`SELECT id, name FROM scm.delivery_rate_cards WHERE company_id = ${CO} AND is_active ORDER BY name`;
    for (const c of cards) {
      const areas = await tx`SELECT towns FROM scm.delivery_rate_areas WHERE card_id = ${c.id}`;
      const rules = await tx`SELECT zone FROM scm.delivery_rate_rules WHERE card_id = ${c.id} AND rule_type IN ('OUTSTATION', 'OUTSTATION_TRIP') AND zone IS NOT NULL`;
      const names = [...new Set([...areas.flatMap((a) => a.towns ?? []), ...rules.map((r) => r.zone)].map((n) => String(n).toUpperCase().trim()).filter(Boolean))];
      if (names.length === 0) continue;
      const unfiled = names.filter((n) => !zoneNames.has(n) && !home.has(n));
      let changed = 0; const shown = [];
      for (const o of read) {
        const before = names.filter((n) => spelled(o.text, n) || (zoneNames.has(n) && o.zone === n));
        const after = names.filter((n) => reaches(n, o));
        if (before.join(',') === after.join(',')) continue;
        changed += 1;
        if (shown.length < 15) shown.push(`${o.doc} (${o.zone ?? 'no zone'}): ${before.join('+') || '—'} -> ${after.join('+') || '—'}`);
      }
      row('CARD', c.name, `${names.length} towns`, `not filed ${unfiled.length}${unfiled.length ? ` (${unfiled.slice(0, 8).join(', ')})` : ''}`, `orders changed ${pct(changed, read.length)}`, `changed ${bucket(changed)}`);
      for (const s of shown) row('CHANGED', c.name, s);
    }
  });
} finally {
  await sql.end({ timeout: 5 });
}
