#!/usr/bin/env node
// check-commission-all-so.mjs — READ ONLY, not for merge. Owner 2026-11-12:
// 「全部列出来，没有展会的标 No fair，要算佣金」. Runs this branch's Event Commission
// handler for September and October, by fair and by SO date, on production
// data as it stands (nothing is hidden), so the operator can compare every
// order's commission with main's and see the "No fair" rows.
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
/* The app's builder, with the closed months hidden. */
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

      await part('closes', async (sp) => sp`
        SELECT month, closed_at, closed_by, report_fair -> 'totals' AS fair_totals, report_so_date -> 'totals' AS so_date_totals,
               jsonb_array_length(COALESCE(report_fair -> 'earlierOrders', '[]'::jsonb)) AS fair_earlier,
               jsonb_array_length(COALESCE(report_so_date -> 'earlierOrders', '[]'::jsonb)) AS so_date_earlier
          FROM scm.event_commission_closes WHERE company_id = ${CO} ORDER BY month`);

      const fairIds = new Set();
      const runs = [
        { key: 'sep', from: '2026-09-01', to: '2026-09-30', hide: false },
        { key: 'oct', from: '2026-10-01', to: '2026-10-31', hide: false },
      ];
      for (const rg of runs) {
        for (const basis of ['fair', 'so_date']) {
          await part(`${rg.key} ${basis}`, async (sp) => {
            const shim = pgrestShim(sp, 'scm');
            const c = {
              env: { DB: d1Compat(() => sp) },
              req: { query: (k) => ({ from: rg.from, to: rg.to, basis })[k], path: '/api/scm/acc-events/commission' },
              get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? (rg.hide ? withoutCloses(shim) : shim) : undefined),
              json: (body, status = 200) => ({ body, status }),
            };
            const res = await eventCommissionHandler(c);
            if (res.status !== 200) return { error: `HTTP ${res.status}`, body: res.body?.error ?? null };
            const r = res.body;
            for (const o of r.earlierOrders ?? []) fairIds.add(Number(o.fairId));
            return {
              from: rg.from, to: rg.to, closed: r.closed ?? null, totals: r.totals,
              fairs: r.fairs.map((f) => ({ id: f.id, startDate: f.startDate, orders: f.sos.length, payableSen: f.payableSen })),
              partOne: r.fairs.flatMap((f) => f.sos.map((s) => ({ docNo: s.docNo, fairId: f.id, fairName: f.name, brand: f.brand, ratePct: f.ratePct, venue: s.venue ?? null, salesperson: s.salesperson, goodsSen: s.goodsSen, paidPct: s.paidPct, commissionSen: s.commissionSen, reachedOn: s.reachedOn, mark: s.mark ?? null }))),
              earlier: (r.earlierOrders ?? []).map((o) => ({
                docNo: o.docNo, fairId: o.fairId, soDate: o.soDate, events: o.events, commissionSen: o.commissionSen,
                originalSen: o.originalSen, latestSen: o.latestSen, amendedSen: o.amendedSen, ratePct: o.ratePct,
              })),
              changed: (r.changedOrders ?? []).map((o) => ({ docNo: o.docNo, part: o.part, amendedSen: o.amendedSen, effectSen: o.effectSen, reachedOn: o.reachedOn })),
              monthAdjustments: (r.monthAdjustments ?? []).map((a) => ({ docNo: a.docNo, month: a.month, paidSen: a.paidSen ?? null, nowSen: a.nowSen ?? null, adjustmentSen: a.adjustmentSen })),
              lateBills: r.lateBills ?? [],
              marked: (r.marked ?? []).map((m) => ({ docNo: m.docNo, kind: m.kind ?? m.mark?.kind ?? null })),
            };
          });
        }
      }
      await part('fairs', async (sp) => {
        const ids = [...fairIds].filter((x) => Number.isFinite(x));
        return ids.length ? sp`SELECT id, name, brand, start_date, end_date FROM public.projects WHERE id IN ${sp(ids)} ORDER BY start_date, id` : [];
      });
    });
  } finally { await sql.end(); }

  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
