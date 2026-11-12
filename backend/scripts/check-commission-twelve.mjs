#!/usr/bin/env node
// check-commission-twelve.mjs — READ ONLY, not for merge. Owner 2026-11-13: 「你帮我
// 检查这12张单的状态」 — twelve September orders whose payments were keyed in
// October with October dates. Reads each order's header, every payment, and
// where the money shows outside the order: the card settlement row a payment
// was matched to (its transaction day) and the bank line its receipt journal
// was matched to (its booked day). Output ENCRYPTED (the Actions log is public).
// Env: DATABASE_URL, PUBKEY, COMPANY_ID (default 1), DOCS (comma list).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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
  if (!process.env.DATABASE_URL || !process.env.PUBKEY || DOCS.length === 0) { console.error('DATABASE_URL, PUBKEY and DOCS are required.'); process.exit(2); }
  const out = { at: new Date().toISOString(), docs: DOCS, parts: {} };
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
      await part('orders', (sp) => sp`
        SELECT doc_no, status, on_hold, so_date, created_at, local_total_sen, project_id, fair_date, customer_so_no
          FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${sp(DOCS)}`);
      let pays = [];
      await part('payments', async (sp) => {
        pays = await sp`
          SELECT id::text AS id, so_doc_no, paid_at, method, merchant_provider, installment_months, approval_code, amount_sen, note, is_deposit, created_at
            FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no IN ${sp(DOCS)} ORDER BY so_doc_no, paid_at`;
        return pays;
      });
      await part('card', (sp) => (pays.length ? sp`
        SELECT m.payment_id, m.doc_no, r.txn_date, r.acquirer_code, r.gross_sen, r.bucket, r.ref
          FROM scm.acc_settlement_matches m JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id
         WHERE m.payment_id IN ${sp(pays.map((x) => x.id))}` : []));
      await part('journals', (sp) => sp`
        SELECT je_no, entry_date, source_type, source_doc_no FROM scm.journal_entries
         WHERE company_id = ${CO} AND source_doc_no IN ${sp(DOCS)} ORDER BY entry_date`);
      await part('bank', (sp) => sp`
        SELECT m.je_no, l.booked_on, l.amount_sen, l.description
          FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
         WHERE m.company_id = ${CO}
           AND m.je_no IN (SELECT je_no FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no IN ${sp(DOCS)})`);
    });
  } finally { await sql.end(); }
  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
