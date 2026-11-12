#!/usr/bin/env node
// check-commission-orders.mjs — READ ONLY. Owner 2026-11-12 sent October orders
// his commission sheet marks "ERP To Check" (branding, original SO date, late
// month bill, amount, late key-in, location). For each order: the order, its
// lines, payments, total changes, status changes, amendments, revisions,
// history, the Venture Portal feed rows and payload, orders sharing its booklet
// number, the fairs around it, the evening sales report lines naming it, and
// where the Event Commission report puts it (Sep / Oct / Nov, by fair and by
// SO date).
//
// The Actions log is PUBLIC and these are amounts and names, so everything is
// written ENCRYPTED to a key only the operator holds (RSA-OAEP-256 wrapping an
// AES-256-GCM key; PUBKEY = base64 SPKI DER) as lowercase hex lines, which the
// public-log guard leaves alone. Plain lines say only which parts were read.
// Personal fields (phones, addresses, e-mails, customer names) are dropped
// before encryption.
//
// Writes nothing: one READ ONLY transaction, each part in its own savepoint.
// Env: DATABASE_URL, PUBKEY, DOCS (comma list of SO numbers), COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';
import { loadReportEvidence, sightingsOf } from '../src/routes/lib/sales-report-evidence.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PII = /phone|mobile|address|email|nric|passport|postcode|debtor_name|customer_name|contact|attention|signature|(^|_)ic(_|$)|ic_no|(^|_)tel(_|$)/i;
const say = (s) => console.log(`ROW|${s}`);

const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !PII.test(k)).map(([k, x]) => [k, strip(x)]));
  }
  return v;
};

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
  if (DOCS.length === 0 || DOCS.some((d) => !/^[A-Z0-9-]{4,40}$/.test(d))) { console.error('DOCS must be SO numbers.'); process.exit(2); }
  const list = DOCS.map((d) => `'${d}'`).join(',');
  const out = { at: new Date().toISOString(), company: CO, docs: DOCS, parts: {} };
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
      const colsOf = async (sp, schema, table) =>
        (await sp`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`).map((r) => r.column_name);
      const byDoc = async (sp, table) => {
        const cols = await colsOf(sp, 'scm', table);
        const docCol = ['so_doc_no', 'doc_no', 'entity_doc_no', 'sales_order_doc_no'].find((c) => cols.includes(c));
        if (!docCol) return { error: `no doc column: ${cols.join(',')}` };
        const co = cols.includes('company_id') ? ` AND company_id = ${CO}` : '';
        const order = cols.includes('created_at') ? 'created_at' : '1';
        return strip(await sp.unsafe(`SELECT * FROM scm.${table} WHERE ${docCol} IN (${list})${co} ORDER BY ${order}`));
      };

      let orders = [];
      await part('orders', async (sp) => {
        orders = await sp.unsafe(`SELECT * FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN (${list}) ORDER BY doc_no`);
        return strip(orders);
      });
      await part('paidTotals', async (sp) => strip(await sp.unsafe(`SELECT * FROM scm.mfg_sales_orders_with_payment_totals WHERE company_id = ${CO} AND doc_no IN (${list})`)));
      await part('staff', async (sp) => {
        const ids = [...new Set(orders.map((o) => o.salesperson_id).filter((x) => x != null).map(String))];
        return ids.length ? strip(await sp`SELECT id, name FROM scm.staff WHERE id::text IN ${sp(ids)}`) : [];
      });
      for (const t of ['mfg_sales_order_items', 'mfg_sales_order_payments', 'so_total_changes', 'mfg_so_status_changes', 'so_amendments', 'so_revisions', 'venture_portal_outbox']) {
        await part(t, (sp) => byDoc(sp, t));
      }
      await part('so_amendment_lines', async (sp) => {
        const am = out.parts.so_amendments;
        const ids = Array.isArray(am) ? am.map((a) => a.id).filter(Boolean) : [];
        if (ids.length === 0) return [];
        const cols = await colsOf(sp, 'scm', 'so_amendment_lines');
        if (!cols.includes('amendment_id')) return { error: `columns: ${cols.join(',')}` };
        return strip(await sp`SELECT * FROM scm.so_amendment_lines WHERE amendment_id IN ${sp(ids)}`);
      });
      await part('audit', async (sp) => strip(await sp.unsafe(
        `SELECT * FROM scm.entity_audit_log WHERE company_id = ${CO} AND (entity_doc_no IN (${list}) OR entity_id IN (${list})) ORDER BY created_at`)));
      await part('vpPayloadNow', async (sp) => strip(await sp.unsafe(`SELECT scm.vp_build_payloads(ARRAY[${list}]::text[]) AS p`)));

      /* Orders that share a booklet number with one of these, or were converted from / into one. */
      const tokens = [...new Set(orders.flatMap((o) => `${o.customer_so_no ?? ''} ${o.ref ?? ''}`.toUpperCase().match(/[A-Z]{1,3}\d{3,}/g) ?? []))];
      await part('related', async (sp) => {
        const conv = orders.map((o) => o.converted_from_so_doc_no).filter((d) => typeof d === 'string' && /^[A-Z0-9-]{4,40}$/.test(d));
        const likes = tokens.map((t) => `'%${t}%'`).join(',');
        const where = [
          `converted_from_so_doc_no IN (${list})`,
          conv.length ? `doc_no IN (${conv.map((d) => `'${d}'`).join(',')})` : null,
          tokens.length ? `upper(coalesce(customer_so_no, '')) LIKE ANY (ARRAY[${likes}])` : null,
          tokens.length ? `upper(coalesce(ref, '')) LIKE ANY (ARRAY[${likes}])` : null,
        ].filter(Boolean).join(' OR ');
        return strip(await sp.unsafe(`SELECT * FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no NOT IN (${list}) AND (${where}) ORDER BY doc_no`));
      });

      await part('fairs', async (sp) => {
        const linked = [...new Set(orders.map((o) => Number(o.project_id)).filter(Number.isInteger))];
        return strip(await sp.unsafe(
          `SELECT id, name, brand, venue, organizer, state, start_date, end_date, status, archived_at FROM public.projects
            WHERE company_id = ${CO} AND ((start_date >= '2026-08-01' AND start_date <= '2026-11-30')${linked.length ? ` OR id IN (${linked.join(',')})` : ''})
            ORDER BY start_date, id`));
      });

      await part('reportSightings', async (sp) => {
        const ev = await loadReportEvidence(d1Compat(() => sp), ` AND p.company_id = ${CO}`, { since: '2026-08-01' });
        return orders.map((o) => ({ docNo: o.doc_no, tokens: `${o.customer_so_no ?? ''} | ${o.ref ?? ''}`, sightings: sightingsOf(o, ev) }));
      });

      await part('closes', async (sp) => strip(await sp.unsafe(
        `SELECT month, closed_at, closed_by FROM scm.event_commission_closes WHERE company_id = ${CO} ORDER BY month`)));

      const ranges = [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30']];
      for (const [from, to] of ranges) {
        for (const basis of ['fair', 'so_date']) {
          await part(`commission ${from.slice(0, 7)} ${basis}`, async (sp) => {
            const c = {
              env: { DB: d1Compat(() => sp) },
              req: { query: (k) => ({ from, to, basis })[k], path: '/api/scm/acc-events/commission' },
              get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? pgrestShim(sp, 'scm') : undefined),
              json: (body, status = 200) => ({ body, status }),
            };
            const res = await eventCommissionHandler(c);
            if (res.status !== 200) return { error: `HTTP ${res.status}`, body: res.body };
            const r = res.body;
            const mine = (d) => DOCS.includes(d);
            return {
              closed: r.closed ?? null,
              partOne: r.fairs.flatMap((f) => f.sos.filter((s) => mine(s.docNo)).map((s) => ({
                fair: { id: f.id, name: f.name, brand: f.brand, startDate: f.startDate, endDate: f.endDate, ratePct: f.ratePct }, so: s,
              }))),
              earlierOrders: (r.earlierOrders ?? []).filter((o) => mine(o.docNo)),
              adjustments: (r.adjustments ?? []).filter((a) => mine(a.docNo)),
              changedOrders: (r.changedOrders ?? []).filter((o) => mine(o.docNo)),
              monthAdjustments: (r.monthAdjustments ?? []).filter((a) => mine(a.docNo)),
            };
          });
        }
      }
    });
  } finally { await sql.end(); }

  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 120) console.log(`ENC|${hex.slice(i, i + 120)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
