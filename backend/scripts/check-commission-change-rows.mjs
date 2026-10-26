#!/usr/bin/env node
// check-commission-change-rows.mjs — READ ONLY. The counted upsales / drop
// sales in one range's Event Commission (by fair), each with what the owner
// asked to see (2026-10-26: original amount, latest amount, amended amount):
// the order, its fair and rate, salesperson, the change's before / after goods,
// the order's goods now, whether it had reached 30% and its commission — the
// rows for a mock of the proposed Upsales / Drop sales table. Writes nothing.
// Env: DATABASE_URL, COMPANY_ID (default 1), FROM / TO (default October 2026).
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
    const c = {
      env: { DB: d1Compat(() => sql) },
      req: { query: (k) => ({ from: FROM, to: TO, basis: 'fair' })[k], path: '/api/scm/acc-events/commission' },
      get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
      json: (body, status = 200) => ({ body, status }),
    };
    const res = await eventCommissionHandler(c);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const rows = [];
    for (const f of res.body.fairs) for (const s of f.sos) for (const ch of s.changes) {
      rows.push({ f, s, ch });
    }
    const docs = [...new Set(rows.map((r) => r.s.docNo))];
    const raw = docs.length ? await sql`SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, source, changed_by FROM scm.so_total_changes
      WHERE company_id = ${CO} AND so_doc_no IN ${sql(docs)} ORDER BY changed_at` : [];
    for (const { f, s, ch } of rows) {
      const rec = raw.filter((x) => x.so_doc_no === s.docNo);
      console.log(`ROW|${ch.notCounted ? 'NOT COUNTED (' + ch.notCounted + ')' : 'COUNTED'} ${ch.kind} ${ch.date} ${s.docNo} — ${f.name} (${f.ratePct}%) · ${s.salesperson ?? '-'} · customer ${s.customer ?? '-'} · change RM ${rm(ch.deltaGoodsSen)} · goods now RM ${rm(s.goodsSen)} · paid ${s.paidPct}% reached ${s.reachedOn ?? 'not yet'} · commission now RM ${rm(s.commissionSen)} · ${ch.source} by ${ch.changedBy ?? '-'}`);
      for (const x of rec) console.log(`ROW|     recorded ${new Date(x.changed_at).toISOString().slice(0, 16)} goods ${rm(x.before_goods_sen)} → ${rm(x.after_goods_sen)} (${x.source}, ${x.changed_by ?? '-'})`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
