#!/usr/bin/env node
// check-wipes.mjs — READ ONLY, not for merge. Owner 2026-11-13 on "an old order
// loses its price when its product is changed": 「现在还有这个问题吗？」.
// Lists the recorded changes that took an order's total to 0 since SINCE, the
// changes recorded on the same orders after that (was the price typed back, and
// when), and what those orders total now.
// The Actions log is PUBLIC, so everything is written ENCRYPTED (RSA-OAEP-256 +
// AES-256-GCM, PUBKEY = base64 SPKI DER) as lowercase hex lines; plain lines say
// only how many rows were read. Writes nothing: one READ ONLY transaction.
// RE-RUN: safe to run again, it only reads.
// Env: DATABASE_URL, PUBKEY, SINCE (default 2026-10-07), COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const SINCE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SINCE || '') ? process.env.SINCE : '2026-10-07';
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
  const out = { at: new Date().toISOString(), company: CO, since: SINCE };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin('read only', async (tx) => {
      const sinceTs = `${SINCE}T00:00:00+08:00`;
      out.wipes = await tx`
        SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by
          FROM scm.so_total_changes
         WHERE company_id = ${CO} AND changed_at >= ${sinceTs} AND after_total_sen <= 100 AND before_total_sen > 100
         ORDER BY changed_at`;
      const docs = [...new Set(out.wipes.map((r) => r.so_doc_no))];
      out.changes = docs.length ? await tx`
        SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by
          FROM scm.so_total_changes
         WHERE company_id = ${CO} AND so_doc_no IN ${tx(docs)} AND changed_at >= ${sinceTs}
         ORDER BY so_doc_no, changed_at` : [];
      out.orders = docs.length ? await tx`
        SELECT doc_no, so_date, status, local_total_sen, created_at
          FROM scm.mfg_sales_orders
         WHERE company_id = ${CO} AND doc_no IN ${tx(docs)}
         ORDER BY doc_no` : [];
    });
  } finally { await sql.end(); }
  say(`wipes: ${out.wipes.length} | orders: ${out.orders.length} | changes: ${out.changes.length}`);
  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
