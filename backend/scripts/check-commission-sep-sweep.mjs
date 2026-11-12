#!/usr/bin/env node
// check-commission-sep-sweep.mjs — READ ONLY. Owner 2026-11-12: 「9月的我就是要重新算过」
// (做) — September worked out again and cleaned the way October was. Reads every order dated or keyed from mid-July to
// today with what the clean-up needs to judge it: its fair link, the day it was
// written at the fair, when it was keyed, its amounts, its payments, every
// total change, the evening sales report lines naming its booklet number, and
// the September Event Commission rows (by fair and by SO date) worked out as if
// September had never been closed (the closed month is hidden from the handler). The judging is
// done offline by the operator.
//
// The Actions log is PUBLIC, so everything is written ENCRYPTED (RSA-OAEP-256 +
// AES-256-GCM, PUBKEY = base64 SPKI DER) as lowercase hex lines; plain lines
// say only which parts were read. Personal fields are not selected.
// Writes nothing: one READ ONLY transaction, each part in its own savepoint.
// Env: DATABASE_URL, PUBKEY, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';
import { loadReportEvidence, sightingsOf } from '../src/routes/lib/sales-report-evidence.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const say = (s) => console.log(`ROW|${s}`);

function encryptToHex(obj) {
  const pub = crypto.createPublicKey({ key: Buffer.from(String(process.env.PUBKEY), 'base64'), format: 'der', type: 'spki' });
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(ek.length);
  return Buffer.concat([len, ek, iv, cipher.getAuthTag(), ct]).toString('hex');
}

/* A query builder over nothing: every chained call returns it, awaiting it gives no rows. */
function noRows() {
  const b = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range']) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve({ data: null, error: null });
  b.single = () => Promise.resolve({ data: null, error: { message: 'no rows' } });
  b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
  return b;
}
/* The app's builder, with the closed months hidden: September as if never closed. */
const withoutCloses = (sb) => new Proxy(sb, {
  get(target, prop) {
    if (prop === 'from') return (name) => (name === 'event_commission_closes' ? noRows() : target.from(name));
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!process.env.PUBKEY) { console.error('PUBKEY is not set.'); process.exit(2); }
  const out = { at: new Date().toISOString(), company: CO, parts: {} };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin('read only', async (tx) => {
      const part = async (name, fn) => {
        try {
          const v = await tx.savepoint((sp) => fn(sp));
          out.parts[name] = v;
          say(`${name}: read${Array.isArray(v) ? ` (${v.length})` : ''}`);
        } catch (e) {
          out.parts[name] = { error: String(e?.message ?? e) };
          say(`${name}: failed`);
        }
      };

      let orders = [];
      await part('orders', async (sp) => {
        orders = await sp`
          SELECT doc_no, so_date, fair_date, created_at, created_by, status, on_hold, project_id, fair_match, venue, venue_source,
                 branding, vp_brand, customer_so_no, ref, salesperson_id, local_total_sen, service_sen, delivery_fee_sen,
                 mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, fair_put_aside_at
            FROM scm.mfg_sales_orders
           WHERE company_id = ${CO} AND (so_date >= '2026-07-15' OR created_at >= '2026-07-15')
           ORDER BY doc_no`;
        return orders;
      });
      const docs = orders.map((o) => o.doc_no);
      await part('payments', async (sp) => (docs.length ? sp`
        SELECT so_doc_no, paid_at, amount_sen, created_at, is_deposit FROM scm.mfg_sales_order_payments
         WHERE company_id = ${CO} AND so_doc_no IN ${sp(docs)} ORDER BY so_doc_no, paid_at` : []));
      await part('totalChanges', async (sp) => (docs.length ? sp`
        SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by
          FROM scm.so_total_changes WHERE company_id = ${CO} AND so_doc_no IN ${sp(docs)} ORDER BY so_doc_no, changed_at` : []));
      await part('fairs', async (sp) => sp`
        SELECT id, name, brand, venue, organizer, state, start_date, end_date, status, archived_at FROM public.projects
         WHERE company_id = ${CO} AND start_date >= '2026-06-01' AND start_date <= '2026-12-31' ORDER BY start_date, id`);
      await part('staff', async (sp) => {
        const ids = [...new Set(orders.map((o) => o.salesperson_id).filter((x) => x != null).map(String))];
        return ids.length ? sp`SELECT id, name FROM scm.staff WHERE id::text IN ${sp(ids)}` : [];
      });
      await part('editors', async (sp) => {
        const ch = Array.isArray(out.parts.totalChanges) ? out.parts.totalChanges : [];
        const ids = [...new Set([...ch.map((c) => c.changed_by), ...orders.map((o) => o.created_by)].filter((x) => x != null).map(String))];
        if (ids.length === 0) return [];
        const cols = (await sp`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`).map((r) => r.column_name);
        const nameCol = ['name', 'full_name', 'display_name'].find((c) => cols.includes(c));
        if (!nameCol) return { error: `users columns: ${cols.join(',')}` };
        return sp`SELECT id::text AS id, ${sp(nameCol)} AS name FROM public.users WHERE id::text IN ${sp(ids)}`;
      });
      await part('sightings', async (sp) => {
        const ev = await loadReportEvidence(d1Compat(() => sp), ` AND p.company_id = ${CO}`, { since: '2026-06-01' });
        return orders.map((o) => ({ docNo: o.doc_no, sightings: sightingsOf(o, ev) })).filter((x) => x.sightings.length > 0);
      });
      for (const basis of ['fair', 'so_date']) {
        await part(`sep ${basis}`, async (sp) => {
          const c = {
            env: { DB: d1Compat(() => sp) },
            req: { query: (k) => ({ from: '2026-09-01', to: '2026-09-30', basis })[k], path: '/api/scm/acc-events/commission' },
            get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? withoutCloses(pgrestShim(sp, 'scm')) : undefined),
            json: (body, status = 200) => ({ body, status }),
          };
          const res = await eventCommissionHandler(c);
          if (res.status !== 200) return { error: `HTTP ${res.status}` };
          const r = res.body;
          return {
            totals: r.totals,
            partOne: r.fairs.flatMap((f) => f.sos.map((s) => ({
              docNo: s.docNo, fairId: f.id, ratePct: f.ratePct, goodsSen: s.goodsSen, paidPct: s.paidPct, reachedOn: s.reachedOn, commissionSen: s.commissionSen,
            }))),
            earlier: (r.earlierOrders ?? []).map((o) => ({ docNo: o.docNo, fairName: o.fairName, kinds: o.events.map((e) => e.kind), commissionSen: o.commissionSen })),
            monthAdjustments: (r.monthAdjustments ?? []).map((a) => ({ docNo: a.docNo, month: a.month, adjustmentSen: a.adjustmentSen })),
            changed: (r.changedOrders ?? []).map((o) => ({ docNo: o.docNo, amendedSen: o.amendedSen, effectSen: o.effectSen })),
          };
        });
      }
    });
  } finally { await sql.end(); }

  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
