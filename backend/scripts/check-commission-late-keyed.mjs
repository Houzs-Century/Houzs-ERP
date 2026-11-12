#!/usr/bin/env node
// check-commission-late-keyed.mjs — READ ONLY. Owner 2026-11-12, before a fix to
// how Event Commission reads an order's goods on a day BEFORE the order was keyed
// (it walks back the opening day's own corrections, e.g. HC-SO-2611-050): 「10月的
// by so date 的 Orders opened in the range 这个part我是检查了没有问题哦，会碰到吗？」.
// Reads every order with a fair keyed from 1 September, its goods now and every
// goods change, so the operator can list the orders the fix would move and by
// how much — in October's and September's reports.
// The Actions log is PUBLIC, so everything is written ENCRYPTED (RSA-OAEP-256 +
// AES-256-GCM, PUBKEY = base64 SPKI DER) as lowercase hex lines; plain lines say
// only which parts were read. Personal fields are not selected. Writes nothing:
// one READ ONLY transaction, each part in its own savepoint.
// Env: DATABASE_URL, PUBKEY, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';

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
          SELECT doc_no, so_date, created_at, status, on_hold, project_id, local_total_sen,
                 mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen
            FROM scm.mfg_sales_orders
           WHERE company_id = ${CO} AND project_id IS NOT NULL AND created_at >= '2026-08-31T16:00:00Z'
           ORDER BY doc_no`;
        return orders;
      });
      const docs = orders.map((o) => o.doc_no);
      await part('changes', async (sp) => (docs.length ? sp`
        SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source
          FROM scm.so_total_changes WHERE company_id = ${CO} AND so_doc_no IN ${sp(docs)} ORDER BY so_doc_no, changed_at` : []));
      await part('payments', async (sp) => (docs.length ? sp`
        SELECT so_doc_no, paid_at, amount_sen FROM scm.mfg_sales_order_payments
         WHERE company_id = ${CO} AND so_doc_no IN ${sp(docs)} ORDER BY so_doc_no, paid_at` : []));
      await part('fairs', async (sp) => {
        const ids = [...new Set(orders.map((o) => Number(o.project_id)))];
        return ids.length ? sp`SELECT id, brand, start_date FROM public.projects WHERE id IN ${sp(ids)}` : [];
      });
    });
  } finally { await sql.end(); }

  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
