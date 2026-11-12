#!/usr/bin/env node
// check-commission-drops.mjs — READ ONLY, not for merge. Owner 2026-11-13: which
// drop sales are only a record put right (an import or keying fix, a bill split or
// re-keyed into another order) and which are a customer really taking goods off?
// For each order in DOCS reads: its header, every goods change, its audit log, its
// lines, its payments, its amendments, and the other orders with the same booklet
// number or the same customer name (headers, changes, payments, marks, salesperson).
// Whole rows are read with to_jsonb so no column is guessed. Output ENCRYPTED
// (RSA-OAEP-256 + AES-256-GCM, PUBKEY = base64 SPKI DER) — the Actions log is public.
// Writes nothing: one READ ONLY transaction, each part in its own savepoint.
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
      await part('columns', (sp) => sp`
        SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS cols
          FROM information_schema.columns
         WHERE table_schema = 'scm' AND table_name IN ('mfg_sales_orders', 'so_total_changes', 'mfg_so_audit_log', 'mfg_sales_order_items', 'mfg_sales_order_payments', 'so_amendments', 'event_commission_marks')
         GROUP BY table_name`);
      await part('orders', (sp) => sp`SELECT to_jsonb(o) AS row FROM scm.mfg_sales_orders o WHERE o.company_id = ${CO} AND o.doc_no IN ${sp(DOCS)}`);
      await part('changes', (sp) => sp`SELECT to_jsonb(c) AS row FROM scm.so_total_changes c WHERE c.company_id = ${CO} AND c.so_doc_no IN ${sp(DOCS)} ORDER BY c.so_doc_no, c.changed_at`);
      await part('audit', (sp) => sp`SELECT to_jsonb(a) AS row FROM scm.mfg_so_audit_log a WHERE a.so_doc_no IN ${sp(DOCS)} ORDER BY a.so_doc_no, a.created_at`);
      await part('items', (sp) => sp`SELECT to_jsonb(i) AS row FROM scm.mfg_sales_order_items i WHERE i.company_id = ${CO} AND i.doc_no IN ${sp(DOCS)}`);
      await part('payments', (sp) => sp`SELECT to_jsonb(p) AS row FROM scm.mfg_sales_order_payments p WHERE p.company_id = ${CO} AND p.so_doc_no IN ${sp(DOCS)} ORDER BY p.so_doc_no, p.paid_at`);
      await part('amendments', (sp) => sp`SELECT to_jsonb(m) AS row FROM scm.so_amendments m WHERE m.company_id = ${CO} AND m.so_doc_no IN ${sp(DOCS)}`);
      let related = [];
      await part('related', async (sp) => {
        related = await sp`
          WITH c AS (
            SELECT doc_no, upper(replace(coalesce(customer_so_no, ''), ' ', '')) AS ref, upper(btrim(coalesce(debtor_name, ''))) AS nm
              FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${sp(DOCS)})
          SELECT c.doc_no AS of_doc,
                 (c.ref <> '' AND upper(replace(coalesce(o.customer_so_no, ''), ' ', '')) = c.ref) AS same_ref,
                 (c.nm <> '' AND upper(btrim(coalesce(o.debtor_name, ''))) = c.nm) AS same_name,
                 to_jsonb(o) AS row, s.name AS salesperson
            FROM c JOIN scm.mfg_sales_orders o ON o.company_id = ${CO} AND o.doc_no <> c.doc_no
             AND ((c.ref <> '' AND upper(replace(coalesce(o.customer_so_no, ''), ' ', '')) = c.ref)
               OR (c.nm <> '' AND upper(btrim(coalesce(o.debtor_name, ''))) = c.nm))
            LEFT JOIN scm.staff s ON s.id = o.salesperson_id
           ORDER BY c.doc_no, o.created_at`;
        return related;
      });
      const rel = [...new Set(related.map((r) => r.row?.doc_no).filter(Boolean))];
      await part('relatedChanges', (sp) => (rel.length ? sp`SELECT to_jsonb(c) AS row FROM scm.so_total_changes c WHERE c.company_id = ${CO} AND c.so_doc_no IN ${sp(rel)} ORDER BY c.so_doc_no, c.changed_at` : []));
      await part('relatedPayments', (sp) => (rel.length ? sp`SELECT so_doc_no, paid_at, amount_sen, method FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no IN ${sp(rel)} ORDER BY so_doc_no, paid_at` : []));
      await part('marks', (sp) => sp`SELECT to_jsonb(k) AS row FROM scm.event_commission_marks k WHERE k.company_id = ${CO} AND k.so_doc_no IN ${sp([...DOCS, ...rel])}`);
      await part('salespeople', (sp) => sp`SELECT o.doc_no, s.name FROM scm.mfg_sales_orders o LEFT JOIN scm.staff s ON s.id = o.salesperson_id WHERE o.company_id = ${CO} AND o.doc_no IN ${sp(DOCS)}`);
    });
  } finally { await sql.end(); }
  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
