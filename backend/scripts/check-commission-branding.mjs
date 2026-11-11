#!/usr/bin/env node
// check-commission-branding.mjs — READ ONLY. Owner 2026-11-12 on the Event
// Commission page (先记起来和检查): 「有一些有 branding issue」, 「total sales 应该是
// by total goods」, 「below deposit 另外分开」. For one range, by fair, exactly
// as the page builds it (the real handler):
//   1. each order's own branding (worked out from its products) and vp_brand
//      against its fair's brand;
//   2. each fair's event-page Total Sales against its orders' goods, as a
//      percentage of the goods;
//   3. how many orders are under 30% paid;
//   4. fair names that are not in capitals.
// Prints ids, brand words, counts and percentages only — never money (the
// Actions log is public). Writes nothing: one READ ONLY transaction.
// Env: DATABASE_URL, COMPANY_ID (default 1), FROM / TO (default 2026-10-01 .. 2026-10-31).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = process.env.FROM || '2026-10-01';
const TO = process.env.TO || '2026-10-31';
/* A branding that names a kind of goods, not a brand (derive-line-branding.ts). */
const KINDS = new Set(['', 'BEDFRAME', 'SERVICE', 'NONE', 'ACCESSORIES', 'OTHERS']);
const up = (v) => String(v ?? '').trim().toUpperCase();
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '-');
const out = (s) => console.log(`ROW|${s}`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin('read only', async (tx) => {
      const cols = await tx`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders' AND column_name IN ('branding', 'vp_brand')`;
      const has = new Set(cols.map((r) => r.column_name));
      out(`columns on scm.mfg_sales_orders: branding ${has.has('branding') ? 'yes' : 'no'}, vp_brand ${has.has('vp_brand') ? 'yes' : 'no'}`);

      const sb = pgrestShim(tx, 'scm');
      const c = {
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => ({ from: FROM, to: TO, basis: 'fair' })[k], path: '/api/scm/acc-events/commission' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await eventCommissionHandler(c);
      if (res.status !== 200) throw new Error(`HTTP ${res.status} ${String(JSON.stringify(res.body)).slice(0, 200)}`);
      const rep = res.body;
      const orders = rep.fairs.flatMap((f) => f.sos.map((s) => ({ docNo: s.docNo, fairId: f.id, fairBrand: up(f.brand), reached: !!s.reachedOn })));
      out(`[by fair ${FROM}..${TO}] fairs ${rep.fairs.length}, with orders ${rep.fairs.filter((f) => f.sos.length > 0).length}, orders ${orders.length}`);

      /* 1. Branding against the fair's brand. */
      if (has.has('branding') && orders.length > 0) {
        const pick = has.has('vp_brand') ? tx`doc_no, branding, vp_brand` : tx`doc_no, branding, NULL AS vp_brand`;
        const rows = await tx`SELECT ${pick} FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${tx(orders.map((o) => o.docNo))}`;
        const byDoc = new Map(rows.map((r) => [r.doc_no, r]));
        const tally = {};
        const same = []; const other = []; const kindOnly = [];
        for (const o of orders) {
          const r = byDoc.get(o.docNo);
          const b = up(r?.branding);
          tally[b || '(blank)'] = (tally[b || '(blank)'] ?? 0) + 1;
          if (b === o.fairBrand) same.push(o);
          else if (KINDS.has(b)) kindOnly.push({ ...o, branding: b || '(blank)', vp: up(r?.vp_brand) });
          else other.push({ ...o, branding: b });
        }
        out(`1. branding values: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
        out(`1. same brand as its fair: ${same.length} (${pct(same.length, orders.length)}); another brand: ${other.length}; a kind of goods or blank: ${kindOnly.length}`);
        for (const o of other.slice(0, 80)) out(`   another brand: ${o.docNo} branding ${o.branding} — fair #${o.fairId} ${o.fairBrand || '(no brand)'}`);
        const vpSame = kindOnly.filter((o) => o.vp && o.vp === o.fairBrand).length;
        const vpOther = kindOnly.filter((o) => o.vp && o.vp !== o.fairBrand);
        out(`1. kind-only orders: vp_brand = fair brand ${vpSame}, vp_brand another brand ${vpOther.length}, no vp_brand ${kindOnly.length - vpSame - vpOther.length}`);
        for (const o of vpOther.slice(0, 40)) out(`   vp_brand differs: ${o.docNo} branding ${o.branding} vp_brand ${o.vp} — fair #${o.fairId} ${o.fairBrand || '(no brand)'}`);
      }

      /* 2. The event page's Total Sales against the orders' goods. */
      const fairsWithSales = rep.fairs.filter((f) => f.totalSalesRm != null && f.sos.length > 0);
      const diffs = fairsWithSales.map((f) => {
        const goodsRm = f.sos.reduce((s, o) => s + o.goodsSen, 0) / 100;
        return { id: f.id, brand: up(f.brand), off: goodsRm > 0 ? (Number(f.totalSalesRm) - goodsRm) / goodsRm : null };
      });
      const far = diffs.filter((d) => d.off == null || Math.abs(d.off) > 0.02);
      out(`2. fairs with a Total Sales and orders: ${diffs.length}; within 2% of the goods ${diffs.length - far.length}; further off ${far.length}`);
      for (const d of far) out(`   fair #${d.id} ${d.brand}: Total Sales is ${d.off == null ? 'set, goods 0' : `${d.off > 0 ? '+' : ''}${Math.round(d.off * 1000) / 10}% of the goods`}`);
      out(`2. fairs with orders but no Total Sales: ${rep.fairs.filter((f) => f.totalSalesRm == null && f.sos.length > 0).length}`);

      /* 3. Orders under 30% paid. */
      const under = orders.filter((o) => !o.reached);
      out(`3. orders under 30% paid at ${TO}: ${under.length} of ${orders.length} (${pct(under.length, orders.length)})`);

      /* 4. Fair names not in capitals. */
      const mixed = rep.fairs.filter((f) => /[a-z]/.test(String(f.name ?? '')));
      out(`4. fair names with small letters: ${mixed.length} of ${rep.fairs.length}${mixed.length ? ` — fairs ${mixed.map((f) => `#${f.id}`).join(', ')}` : ''}`);
    });
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
