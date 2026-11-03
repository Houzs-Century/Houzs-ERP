#!/usr/bin/env node
// check-product-profit-range.mjs — READ ONLY (plan only; there is no apply).
// Product profit over several months (the redesign's c8): the app's own loader
// and builder (scm/routes/accounting-product-profit.ts loadProductProfit,
// acc/product-profit.ts buildProductProfit) over one read of whole months,
// against the months read one by one and added up, on a rolled-back
// transaction. Also times 1, 3, 12 and 24 months. Env: DATABASE_URL, COMPANY_ID.
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadProductProfit } from '../src/scm/routes/accounting-product-profit.ts';
import { buildProductProfit } from '../src/acc/product-profit.ts';

if (String(process.env.MODE ?? 'plan') !== 'plan') { console.error('Refused: this script only reads (MODE=plan).'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
class Rollback extends Error {}

const monthsBack = (last, n) => {
  const out = [];
  let y = Number(last.slice(0, 4)); let m = Number(last.slice(5, 7));
  for (let i = 0; i < n; i += 1) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return out;
};
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

try {
  await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const read = async (first, last) => {
      const t0 = Date.now();
      const range = { from: `${first}-01`, to: lastDay(last) };
      const loaded = await loadProductProfit(sb, CO, range);
      if (!loaded.ok) throw new Error(`load ${first}..${last}: ${loaded.reason}`);
      const rep = buildProductProfit({ month: first, ...range, ...loaded });
      return { rep, ms: Date.now() - t0, lines: loaded.lines.length };
    };
    const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
    const LAST = '2026-10';

    /* 1. Three months: one read against the months added up. */
    const three = monthsBack(LAST, 3);
    const whole = await read(three[0], three[2]);
    const each = [];
    for (const m of three) each.push(await read(m, m));
    const byModel = new Map();
    for (const e of each) for (const r of e.rep.rows) {
      const had = byModel.get(r.key) ?? { salesSen: 0, costSen: 0, giftSen: 0, units: 0, orders: 0, freeBedframeSen: 0 };
      for (const k of Object.keys(had)) had[k] += r[k];
      byModel.set(r.key, had);
    }
    let differ = 0;
    for (const r of whole.rep.rows) {
      const s = byModel.get(r.key);
      const keys = ['salesSen', 'costSen', 'giftSen', 'units', 'orders', 'freeBedframeSen'];
      const bad = !s ? keys : keys.filter((k) => s[k] !== r[k]);
      if (bad.length) { differ += 1; if (differ <= 10) out(`DIFFER ${r.model} (${r.category}): ${bad.map((k) => `${k} range ${r[k]} vs months ${s?.[k] ?? '—'}`).join('; ')}`); }
    }
    out(`company ${CO} · ${three.join(', ')}: one read ${whole.rep.rows.length} models, ${whole.rep.orders} orders, ${whole.lines} lines, ${whole.ms} ms`);
    out(`  months one by one: ${each.map((e) => `${e.rep.month} ${e.rep.rows.length} models/${e.rep.orders} orders/${rm(sum(e.rep.rows, 'salesSen'))} (${e.ms} ms)`).join(' · ')}`);
    out(`  sales ${rm(sum(whole.rep.rows, 'salesSen'))} vs ${rm(each.reduce((a, e) => a + sum(e.rep.rows, 'salesSen'), 0))} · cost ${rm(sum(whole.rep.rows, 'costSen'))} vs ${rm(each.reduce((a, e) => a + sum(e.rep.rows, 'costSen'), 0))} · gifts ${rm(sum(whole.rep.rows, 'giftSen'))} vs ${rm(each.reduce((a, e) => a + sum(e.rep.rows, 'giftSen'), 0))}`);
    out(`  orders ${whole.rep.orders} vs ${each.reduce((a, e) => a + e.rep.orders, 0)} · models in no month: ${[...whole.rep.rows].filter((r) => !byModel.has(r.key)).length} · rows that differ: ${differ}`);
    out(`  free bedframes ${whole.rep.freeBedframes.pieces} pcs ${rm(whole.rep.freeBedframes.sen)} vs ${each.reduce((a, e) => a + e.rep.freeBedframes.pieces, 0)} pcs ${rm(each.reduce((a, e) => a + e.rep.freeBedframes.sen, 0))}`);

    /* 2. How long the longer reads take. */
    for (const n of [12, 24]) {
      const ms = monthsBack(LAST, n);
      const r = await read(ms[0], ms[n - 1]);
      out(`${n} months ${ms[0]}..${ms[n - 1]}: ${r.rep.rows.length} models, ${r.rep.orders} orders, ${r.lines} lines, sales ${rm(sum(r.rep.rows, 'salesSen'))}, ${r.ms} ms`);
    }
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.stack ?? e?.message ?? e}`); process.exitCode = 1; }
} finally { await sql.end(); }
