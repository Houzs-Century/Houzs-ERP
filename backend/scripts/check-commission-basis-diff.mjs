#!/usr/bin/env node
// check-commission-basis-diff.mjs — READ ONLY. Owner 2026-10-25: 「帮我检查为什么
// by fair 的 earlier fairs 和 by so date 的 earlier fairs 不一样，先确定」. Runs the
// Event Commission handler itself (as check-event-commission.mjs does) for one
// range on both bases and lines up Part 2 ("Earlier fairs") line by line: which
// lines only one basis has, and why — the order's SO date against its fair's
// start. Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1),
// FROM / TO (default 2026-10-01 .. 2026-10-31).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = process.env.FROM || '2026-10-01';
const TO = process.env.TO || '2026-10-31';
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const sb = pgrestShim(sql, 'scm');
    const run = async (basis) => {
      const c = {
        env: { DB: d1Compat(() => sql) },
        req: { query: (k) => ({ from: FROM, to: TO, basis })[k], path: '/api/scm/acc-events/commission' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await eventCommissionHandler(c);
      if (res.status !== 200) throw new Error(`${basis}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return res.body;
    };
    const fair = await run('fair');
    const so = await run('so_date');
    for (const r of [fair, so]) {
      const kinds = {};
      for (const a of r.adjustments) { const k = kinds[a.kind] ?? { n: 0, sen: 0 }; k.n += 1; k.sen += a.commissionSen; kinds[a.kind] = k; }
      console.log(`ROW|[${r.basis}] ${FROM}..${TO}: fairs table RM ${rm(r.totals.payableSen)} (${r.fairs.flatMap((f) => f.sos).length} orders) · Earlier fairs RM ${rm(r.totals.adjustmentsSen)} (${r.adjustments.length} lines: ${Object.entries(kinds).map(([k, v]) => `${k} ${v.n} RM ${rm(v.sen)}`).join(', ')}) · total RM ${rm(r.totals.totalSen)}`);
    }

    /* Each order's SO date and fair start, to say why a line sits in one basis only. */
    const docs = [...new Set([...fair.adjustments, ...so.adjustments].map((a) => a.docNo))];
    const facts = docs.length ? await sql`SELECT o.doc_no, o.so_date, o.project_id, p.start_date, p.end_date
      FROM scm.mfg_sales_orders o LEFT JOIN public.projects p ON p.id = o.project_id WHERE o.doc_no IN ${sql(docs)}` : [];
    const factOf = new Map(facts.map((f) => [f.doc_no, f]));
    const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
    const key = (a) => `${a.docNo}|${a.kind}|${a.date}`;
    const inFair = new Map(fair.adjustments.map((a) => [key(a), a]));
    const inSo = new Map(so.adjustments.map((a) => [key(a), a]));
    const why = (a) => {
      const f = factOf.get(a.docNo);
      const soDate = day(f?.so_date);
      const start = day(f?.start_date);
      if (start < FROM && soDate >= FROM) return `fair started ${start} (before ${FROM}), order opened ${soDate} (in range)`;
      if (soDate < FROM && start >= FROM) return `order opened ${soDate} (before ${FROM}), fair starts ${start} (in range)`;
      return `order opened ${soDate}, fair starts ${start}`;
    };
    const groups = new Map();
    const add = (side, a) => {
      const reason = why(a).replace(/\d{4}-\d{2}-\d{2}/g, 'D');
      const g = groups.get(`${side}|${reason}`) ?? { side, reason, n: 0, sen: 0, eg: [] };
      g.n += 1; g.sen += a.commissionSen;
      if (g.eg.length < 6) g.eg.push(`${a.docNo} ${a.kind} ${a.date} RM ${rm(a.commissionSen)} — ${a.fairName} — ${why(a)}`);
      groups.set(`${side}|${reason}`, g);
    };
    let both = 0; let bothSen = 0;
    for (const [k, a] of inFair) { if (inSo.has(k)) { both += 1; bothSen += a.commissionSen; } else add('ONLY BY FAIR', a); }
    for (const [k, a] of inSo) if (!inFair.has(k)) add('ONLY BY SO DATE', a);
    console.log(`ROW|in both: ${both} lines RM ${rm(bothSen)}`);
    for (const g of groups.values()) {
      console.log(`ROW|${g.side}: ${g.n} lines RM ${rm(g.sen)} — ${g.reason}`);
      for (const e of g.eg) console.log(`ROW|   e.g. ${e}`);
    }
    /* Part 1 — the orders each basis puts in its fairs table. */
    const part1 = (r) => new Map(r.fairs.flatMap((f) => f.sos.map((o) => [o.docNo, { ...o, fairName: f.name, start: f.startDate }])));
    const p1f = part1(fair); const p1s = part1(so);
    const sides = new Map();
    const put = (side, o) => {
      const why = o.start < FROM && (o.soDate ?? '') >= FROM ? 'fair started before the range, order opened in it'
        : o.start > TO ? 'fair starts AFTER the range, order opened in it'
        : (o.soDate ?? '') < FROM && o.start >= FROM ? 'order opened before the range, fair starts in it'
        : 'other';
      const g = sides.get(side + '|' + why) ?? { side, why, n: 0, sen: 0, earned: 0, eg: [] };
      g.n += 1; g.sen += o.commissionSen; if (o.commissionSen) g.earned += 1;
      if (g.eg.length < 5) g.eg.push(o.docNo + ' SO ' + o.soDate + ' · ' + o.fairName + ' (starts ' + o.start + ') RM ' + rm(o.commissionSen));
      sides.set(side + '|' + why, g);
    };
    for (const [d, o] of p1s) if (!p1f.has(d)) put('PART 1 ONLY BY SO DATE', o);
    for (const [d, o] of p1f) if (!p1s.has(d)) put('PART 1 ONLY BY FAIR', o);
    for (const g of sides.values()) {
      console.log('ROW|' + g.side + ': ' + g.n + ' orders (' + g.earned + ' earning) RM ' + rm(g.sen) + ' — ' + g.why);
      for (const e of g.eg) console.log('ROW|   e.g. ' + e);
    }
    /* The same lines differing in amount (an order counted on both bases). */
    for (const [k, a] of inFair) {
      const b = inSo.get(k);
      if (b && b.commissionSen !== a.commissionSen) console.log(`ROW|same line, different amount: ${k} by fair RM ${rm(a.commissionSen)} vs by SO date RM ${rm(b.commissionSen)}`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
