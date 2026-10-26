#!/usr/bin/env node
// check-commission-changes.mjs — READ ONLY. Owner 2026-10-26 on the Event
// Commission page: 「upsales 和 drop sales 在哪里？」. Where the recorded order
// changes (scm.so_total_changes, recorded from 20/10/2026) land in the report
// for one range, by fair: inside this range's fairs (each order's changes,
// counted or not) and as Earlier-fairs lines; plus the raw count recorded.
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM / TO
// (default 2026-10-01 .. 2026-10-31).
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
    const raw = await sql`SELECT count(*)::int AS n, count(DISTINCT so_doc_no)::int AS orders, min(changed_at) AS first, max(changed_at) AS last,
        coalesce(sum(after_goods_sen - before_goods_sen) FILTER (WHERE after_goods_sen > before_goods_sen), 0)::bigint AS up,
        coalesce(sum(after_goods_sen - before_goods_sen) FILTER (WHERE after_goods_sen < before_goods_sen), 0)::bigint AS down
      FROM scm.so_total_changes WHERE company_id = ${CO}`;
    const r0 = raw[0];
    console.log(`ROW|recorded changes (all time, company ${CO}): ${r0.n} on ${r0.orders} orders, ${r0.first ? new Date(r0.first).toISOString().slice(0, 10) : '-'} .. ${r0.last ? new Date(r0.last).toISOString().slice(0, 10) : '-'}; goods up RM ${rm(r0.up)}, down RM ${rm(r0.down)}`);

    const sb = pgrestShim(sql, 'scm');
    const c = {
      env: { DB: d1Compat(() => sql) },
      req: { query: (k) => ({ from: FROM, to: TO, basis: 'fair' })[k], path: '/api/scm/acc-events/commission' },
      get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
      json: (body, status = 200) => ({ body, status }),
    };
    const res = await eventCommissionHandler(c);
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    const rep = res.body;
    const inFairs = rep.fairs.flatMap((f) => f.sos.flatMap((s) => s.changes.map((ch) => ({ ...ch, docNo: s.docNo, fair: f.name }))));
    const counted = inFairs.filter((ch) => !ch.notCounted);
    const why = {};
    for (const ch of inFairs.filter((x) => x.notCounted)) why[ch.notCounted] = (why[ch.notCounted] ?? 0) + 1;
    console.log(`ROW|[by fair ${FROM}..${TO}] inside this range's fairs: ${inFairs.length} changes on ${new Set(inFairs.map((x) => x.docNo)).size} orders — counted ${counted.length} (up ${counted.filter((x) => x.kind === 'upsale').length}, down ${counted.filter((x) => x.kind === 'drop').length}); not counted ${JSON.stringify(why)}`);
    for (const ch of counted.slice(0, 8)) console.log(`ROW|   e.g. ${ch.docNo} ${ch.kind} ${ch.date} RM ${rm(ch.deltaGoodsSen)} (${ch.source}) — ${ch.fair}`);
    const earlier = rep.adjustments.filter((a) => a.kind === 'upsale' || a.kind === 'drop');
    console.log(`ROW|[by fair] Earlier-fairs lines that are upsales / drops: ${earlier.length} (before 30%: ${earlier.filter((a) => a.beforeReach).length})`);
    for (const a of earlier.slice(0, 8)) console.log(`ROW|   e.g. ${a.docNo} ${a.kind} ${a.date} goods RM ${rm(a.goodsSen)} commission RM ${rm(a.commissionSen)} — ${a.fairName}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
