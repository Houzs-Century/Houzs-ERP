#!/usr/bin/env node
// check-commission-cancels.mjs — READ ONLY. Owner 2026-11-12, on Event
// Commission: 「你们如果cancelled bill 是不是也算drop sales 可以检查」. Reads
//   · every cancellation (and re-opening) since 1 September, with its order;
//   · every goods change since 1 September that took an order's goods to
//     nothing (a cancellation in all but name);
//   · those orders' headers, payments, goods changes and fairs;
//   · the Event Commission of October and of November so far, by fair and by
//     SO date (the in-range orders, the earlier orders' lines, the upsales /
//     drop sales, the marks), so the operator can see where each cancelled
//     order lands — and that none is an upsale / drop sale.
// The Actions log is PUBLIC, so everything is written ENCRYPTED (RSA-OAEP-256 +
// AES-256-GCM, PUBKEY = base64 SPKI DER) as lowercase hex lines; plain lines say
// only which parts were read. Personal fields are not selected. Writes nothing:
// one READ ONLY transaction, each part in its own savepoint.
// Env: DATABASE_URL, PUBKEY, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const SINCE = '2026-08-31T16:00:00Z'; // 1 September 00:00, Malaysian time
const TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const RANGES = [
  { key: 'oct', from: '2026-10-01', to: '2026-10-31' },
  { key: 'nov', from: '2026-11-01', to: TODAY },
];
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

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!process.env.PUBKEY) { console.error('PUBKEY is not set.'); process.exit(2); }
  const out = { at: new Date().toISOString(), company: CO, today: TODAY, parts: {} };
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
      const docs = new Set();

      await part('statusChanges', async (sp) => {
        const rows = await sp`
          SELECT doc_no, from_status, to_status, changed_by::text AS changed_by, notes, created_at
            FROM scm.mfg_so_status_changes
           WHERE company_id = ${CO} AND created_at >= ${SINCE}
             AND (to_status = 'CANCELLED' OR from_status = 'CANCELLED')
           ORDER BY doc_no, created_at`;
        for (const r of rows) docs.add(r.doc_no);
        return rows;
      });
      await part('zeroDrops', async (sp) => {
        const rows = await sp`
          SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by
            FROM scm.so_total_changes
           WHERE company_id = ${CO} AND changed_at >= ${SINCE} AND before_goods_sen > 0 AND after_goods_sen <= 0
           ORDER BY so_doc_no, changed_at`;
        for (const r of rows) docs.add(r.so_doc_no);
        return rows;
      });
      await part('cancelledNow', async (sp) => {
        const rows = await sp`
          SELECT doc_no FROM scm.mfg_sales_orders
           WHERE company_id = ${CO} AND status = 'CANCELLED' AND (so_date >= '2026-08-01' OR created_at >= '2026-08-01')
           ORDER BY doc_no`;
        for (const r of rows) docs.add(r.doc_no);
        return rows.map((r) => r.doc_no);
      });

      for (const rg of RANGES) {
        for (const basis of ['fair', 'so_date']) {
          await part(`${rg.key} ${basis}`, async (sp) => {
            const c = {
              env: { DB: d1Compat(() => sp) },
              req: { query: (k) => ({ from: rg.from, to: rg.to, basis })[k], path: '/api/scm/acc-events/commission' },
              get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? pgrestShim(sp, 'scm') : undefined),
              json: (body, status = 200) => ({ body, status }),
            };
            const res = await eventCommissionHandler(c);
            if (res.status !== 200) return { error: `HTTP ${res.status}`, body: res.body?.error ?? null };
            const r = res.body;
            for (const o of r.changedOrders ?? []) docs.add(o.docNo);
            for (const o of r.earlierOrders ?? []) docs.add(o.docNo);
            return {
              from: rg.from, to: rg.to, totals: r.totals,
              partOne: r.fairs.flatMap((f) => f.sos.map((s) => ({
                docNo: s.docNo, fairId: f.id, ratePct: f.ratePct, status: s.status, goodsSen: s.goodsSen,
                reachedOn: s.reachedOn, commissionSen: s.commissionSen, mark: s.mark ?? null,
              }))),
              earlier: (r.earlierOrders ?? []).map((o) => ({
                docNo: o.docNo, fairId: o.fairId, ratePct: o.ratePct, status: o.status, events: o.events, lastDate: o.lastDate,
                originalSen: o.originalSen, latestSen: o.latestSen, amendedSen: o.amendedSen, commissionSen: o.commissionSen, mark: o.mark ?? null,
              })),
              adjustments: (r.adjustments ?? []).map((a) => ({
                docNo: a.docNo, date: a.date, kind: a.kind, goodsSen: a.goodsSen, commissionSen: a.commissionSen, beforeReach: a.beforeReach,
              })),
              changed: (r.changedOrders ?? []).map((o) => ({
                docNo: o.docNo, part: o.part, status: o.status, lastChange: o.lastChange, originalSen: o.originalSen, latestSen: o.latestSen,
                amendedSen: o.amendedSen, effectSen: o.effectSen, reachedOn: o.reachedOn, mark: o.mark ?? null, changeMark: o.changeMark ?? null,
              })),
              monthAdjustments: (r.monthAdjustments ?? []).map((a) => ({ docNo: a.docNo, month: a.month, adjustmentSen: a.adjustmentSen })),
              marked: (r.marked ?? []).map((m) => ({ docNo: m.docNo, kind: m.kind ?? m.mark?.kind ?? null })),
              lateBills: r.lateBills ?? [],
            };
          });
        }
      }

      const list = [...docs].sort();
      say(`orders of interest: ${list.length}`);
      let orders = [];
      await part('orders', async (sp) => {
        orders = list.length ? await sp`
          SELECT doc_no, so_date, created_at, updated_at, status, on_hold, project_id, fair_match, ref, salesperson_id,
                 local_total_sen, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen
            FROM scm.mfg_sales_orders
           WHERE company_id = ${CO} AND doc_no IN ${sp(list)}
           ORDER BY doc_no` : [];
        return orders;
      });
      await part('payments', async (sp) => (list.length ? sp`
        SELECT so_doc_no, paid_at, amount_sen, created_at FROM scm.mfg_sales_order_payments
         WHERE company_id = ${CO} AND so_doc_no IN ${sp(list)} ORDER BY so_doc_no, paid_at` : []));
      await part('totalChanges', async (sp) => (list.length ? sp`
        SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by
          FROM scm.so_total_changes WHERE company_id = ${CO} AND so_doc_no IN ${sp(list)} ORDER BY so_doc_no, changed_at` : []));
      await part('allStatusChanges', async (sp) => (list.length ? sp`
        SELECT doc_no, from_status, to_status, changed_by::text AS changed_by, created_at
          FROM scm.mfg_so_status_changes WHERE company_id = ${CO} AND doc_no IN ${sp(list)} ORDER BY doc_no, created_at` : []));
      await part('fairs', async (sp) => {
        const ids = [...new Set(orders.map((o) => o.project_id).filter((x) => x != null).map(Number))];
        return ids.length ? sp`
          SELECT id, name, brand, start_date, end_date FROM public.projects WHERE id IN ${sp(ids)} ORDER BY start_date, id` : [];
      });
      await part('staff', async (sp) => {
        const sc = Array.isArray(out.parts.statusChanges) ? out.parts.statusChanges : [];
        const ids = [...new Set([...orders.map((o) => o.salesperson_id), ...sc.map((r) => r.changed_by)].filter((x) => x != null).map(String))];
        return ids.length ? sp`SELECT id::text AS id, name FROM scm.staff WHERE id::text IN ${sp(ids)}` : [];
      });
    });
  } finally { await sql.end(); }

  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
