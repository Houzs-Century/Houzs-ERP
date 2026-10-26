#!/usr/bin/env node
// check-sep-after-close.mjs — READ ONLY (one rolled-back transaction). Owner
// 2026-10-26: September 2026 is treated as already closed. Closed AT ITS END,
// what changed for September's commission since 1 October would be October's
// 「9月调整」; closed today, it is folded into September silently. How much is
// that? Payments keyed from 1 October but dated in September (and the Sep
// commission they move, measured by removing them inside a transaction that is
// rolled back), payments deleted, fair moves and holds since 1 October.
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const OCT1 = '2026-09-30T16:00:00Z';
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  class Rollback extends Error {}
  try {
    const late = await sql`SELECT p.id, p.so_doc_no, p.paid_at, p.created_at, p.amount_sen, p.method, o.project_id
      FROM scm.mfg_sales_order_payments p JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
      WHERE o.company_id = ${CO} AND p.paid_at <= '2026-09-30' AND p.created_at >= ${OCT1} AND o.project_id IS NOT NULL
      ORDER BY p.created_at`;
    out(`payments keyed from 1/10 but dated by 30/9 (orders on a fair): ${late.length}, RM ${rm(late.reduce((s, p) => s + Number(p.amount_sen), 0))}`);
    for (const p of late.slice(0, 15)) out(`    ${p.so_doc_no} dated ${new Date(p.paid_at).toISOString().slice(0, 10)} keyed ${new Date(p.created_at).toISOString().slice(0, 16)} RM ${rm(p.amount_sen)} ${p.method}`);
    const dels = await sql`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
      WHERE o.company_id = ${CO} AND a.action = 'DELETE_PAYMENT' AND a.created_at >= ${OCT1}`;
    out(`payments deleted since 1/10: ${dels[0].n}`);
    const fairs = await sql`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
      WHERE o.company_id = ${CO} AND a.action = 'UPDATE_FAIR' AND a.created_at >= ${OCT1}`;
    out(`fair moves since 1/10: ${fairs[0].n}`);

    await sql.begin(async (tx) => {
      /* The route reads the closes table, not deployed yet: create it inside this transaction. */
      const exists = await tx`SELECT to_regclass('scm.event_commission_closes') IS NOT NULL AS t`;
      if (!exists[0].t) await tx.unsafe(readFileSync(new URL('./data/try-20261026T1700.sql', import.meta.url), 'utf8'));
      const sb = pgrestShim(tx, 'scm');
      const ctx = (basis) => ({
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => ({ from: '2026-09-01', to: '2026-09-30', basis })[k], json: async () => ({}), path: '/api/scm/acc-events/commission' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
        json: (b, status = 200) => ({ body: b, status }),
      });
      const paidOf = (rep) => {
        const m = new Map();
        for (const f of rep.fairs) for (const s of f.sos) m.set(s.docNo, (m.get(s.docNo) ?? 0) + s.commissionSen);
        for (const a of rep.adjustments) m.set(a.docNo, (m.get(a.docNo) ?? 0) + a.commissionSen);
        return m;
      };
      const now = {};
      for (const basis of ['fair', 'so_date']) now[basis] = (await eventCommissionHandler(ctx(basis))).body;
      if (late.length > 0) await tx`DELETE FROM scm.mfg_sales_order_payments WHERE id = ANY(${late.map((p) => p.id)}::uuid[])`;
      for (const basis of ['fair', 'so_date']) {
        const then = (await eventCommissionHandler(ctx(basis))).body;
        out(`Sep by ${basis}: today RM ${rm(now[basis].totals.totalSen)}, without the late-keyed payments RM ${rm(then.totals.totalSen)} → those payments move RM ${rm(now[basis].totals.totalSen - then.totals.totalSen)}`);
        const a = paidOf(now[basis]); const b = paidOf(then);
        for (const doc of new Set([...a.keys(), ...b.keys()])) {
          const d = (a.get(doc) ?? 0) - (b.get(doc) ?? 0);
          if (d !== 0) out(`    ${basis} ${doc}: RM ${rm(d)}`);
        }
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    out('rolled back — nothing changed');
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
