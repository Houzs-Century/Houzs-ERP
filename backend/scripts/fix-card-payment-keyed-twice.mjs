#!/usr/bin/env node
// fix-card-payment-keyed-twice.mjs — one card payment keyed on TWO orders, with
// the merchant report confirmed on the copy that has to go.
//
// Owner 2026-11-13 (「做」): a customer paid two orders with one card swipe. The
// slip scan recorded the whole swipe on the first order, and it was keyed again
// on the second; the merchant settlement line was then confirmed on the first
// order's copy, which locks that copy ("This payment is locked: it was
// confirmed on a merchant settlement report…"). The second order (KEEP_DOC) is
// the one that holds the swipe; the first (DROP_DOC) has its share by Convert.
//
// What is left is what Finance would press, through the app's own handlers, in
// this order — so the ledger, the receipts and the orders' History follow as
// they do on the screens:
//   1. Merchant Recon → the line → Undo                  (settlementRowUnconfirm)
//   2. DROP_DOC → remove the copy, with the reason        (deleteSoPaymentHandler)
//   3. the kept payment takes the approval code the line was matched by, when
//      the copy carried it and the kept one does not      (the PATCH's handler)
//   4. Merchant Recon → the line → the kept payment → Confirm (settlementConfirmRow)
// Refused unless DROP_DOC holds exactly one card payment a confirmed settlement
// line is linked to (a line of its own, not matched together with others), and
// KEEP_DOC holds exactly one card payment of the same amount, day, method and
// bank that no settlement line is linked to.
//
// MODE=plan (default) does all of it inside one transaction, reads the result
// back and ROLLS IT BACK — nothing is written. MODE=apply with
// CONFIRM="FIX CARD PAYMENT KEYED TWICE" keeps it (all four steps or none), then
// re-reads on a fresh connection and exits 1 if the result is not there.
// Prints document numbers and yes / no only (the Actions log is public); with
// PUBKEY the figures go out ENCRYPTED (RSA-OAEP-256 + AES-256-GCM).
//
// RE-RUN: once the line is confirmed on KEEP_DOC's payment and DROP_DOC holds no
// copy, a second run finds nothing to do and writes nothing.
// Env: DATABASE_URL, DROP_DOC, KEEP_DOC, REASON, ACTOR, COMPANY_ID (default 1), PUBKEY (optional).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { deleteSoPaymentHandler, mfgSalesOrders } from '../src/scm/routes/mfg-sales-orders.ts';
import { settlementConfirmRow, settlementRowUnconfirm } from '../src/scm/routes/accounting-settlement.ts';

const PHRASE = 'FIX CARD PAYMENT KEYED TWICE';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const DROP = String(process.env.DROP_DOC ?? '').trim().toUpperCase();
const KEEP = String(process.env.KEEP_DOC ?? '').trim().toUpperCase();
const REASON = String(process.env.REASON ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? '').trim();
const say = (s) => console.log(s);
/* Finance's rights at the four doors: the correction right opens a past payment, the voucher right is Merchant Recon's. */
const PERMS = ['scm.so_payment.amend', 'scm.payment.backdate', 'scm.payment_voucher.post', 'scm.so.view_all'];
const CARD = new Set(['merchant', 'installment']);
const norm = (v) => String(v ?? '').trim();
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
/* Dates and times as the text PostgreSQL sends, the way PostgREST hands them to the app: the handlers read
   a payment's created_at as a string, and a Date object there reads as "unreadable". */
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const connect = () => postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
class Rollback extends Error {}
class NothingToDo extends Error {}

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

/** The PATCH reads its row back with the collector's name embedded for the
    screen (`staff:collected_by ( name )`), a LEFT embed the shim does not carry.
    The name belongs to the response, not to the write: the read-back goes without it. */
function withoutCollectorName(sb) {
  const from = sb.from.bind(sb);
  return new Proxy(sb, {
    get(t, prop) {
      if (prop !== 'from') { const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; }
      return (table) => {
        const b = from(table);
        if (table === 'mfg_sales_order_payments') {
          const select = b.select;
          b.select = (cols) => select(typeof cols === 'string' ? cols.replace(/,\s*staff:collected_by\s*\(\s*name\s*\)/, '') : cols);
        }
        return b;
      };
    },
  });
}

/** The two orders' payments, each with the settlement lines linked to it. */
async function read(db) {
  const orders = await db`SELECT doc_no, status, local_total_sen::text AS total FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${db([DROP, KEEP])}`;
  const pays = await db`SELECT * FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no IN ${db([DROP, KEEP])} ORDER BY created_at`;
  const ids = pays.map((p) => String(p.id));
  const links = ids.length === 0 ? [] : await db`
    SELECT m.payment_id::text AS payment_id, r.id AS row_id, r.batch_id, r.acquirer_code, r.ref, r.gross_sen::text AS gross, r.bucket, r.confirmed_at, r.posted_je_no, r.matched_with_row_id,
           (SELECT count(*)::int FROM scm.acc_settlement_rows g WHERE g.company_id = r.company_id AND g.matched_with_row_id = r.id) AS group_members,
           (SELECT count(*)::int FROM scm.acc_settlement_matches x WHERE x.settlement_row_id = r.id) AS row_links
      FROM scm.acc_settlement_matches m JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id
     WHERE m.company_id = ${CO} AND m.payment_source = 'SOPAY' AND m.payment_id::text IN ${db(ids)}`;
  const receipts = ids.length === 0 ? [] : await db`SELECT payment_id::text AS payment_id, or_number, status FROM scm.acc_official_receipts WHERE company_id = ${CO} AND payment_source = 'SOPAY' AND payment_id::text IN ${db(ids)} ORDER BY id`;
  return { orders, pays, links, receipts };
}
/** Entries of a payment or a settlement line still standing. */
const liveEntries = (db, sources) => db`SELECT je_no, source_type, source_doc_no FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no IN ${db(sources)} AND posted AND NOT coalesce(reversed, false) ORDER BY created_at`;
/** Does an order's money equal its total? */
const squareOf = (st, doc) => {
  const o = st.orders.find((x) => x.doc_no === doc);
  return o != null && st.pays.filter((p) => p.so_doc_no === doc).reduce((s, p) => s + Number(p.amount_sen), 0) === Number(o.total);
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!DROP || !KEEP || DROP === KEEP || !REASON || !ACTOR) { console.error('DROP_DOC, KEEP_DOC (two different orders), REASON and ACTOR are all required — nothing was written.'); process.exit(2); }
  const sql = connect();
  const detail = { at: new Date().toISOString(), company: CO, drop: DROP, keep: KEEP };
  let done = null;
  try {
    say(`fix-card-payment-keyed-twice   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   the copy on ${DROP} goes, the line moves to ${KEEP}`);
    try {
      await sql.begin(async (tx) => {
        const before = await read(tx);
        detail.before = before;
        if (before.orders.length !== 2) throw new Error(`found ${before.orders.length} of the 2 orders in company ${CO}`);
        const linksOf = (p) => before.links.filter((l) => l.payment_id === String(p.id));
        const card = (doc) => before.pays.filter((p) => p.so_doc_no === doc && CARD.has(String(p.method)) && Number(p.amount_sen) > 0);
        const held = card(DROP).filter((p) => linksOf(p).some((l) => l.confirmed_at != null));
        if (held.length === 0) {
          const moved = card(KEEP).some((p) => linksOf(p).some((l) => l.confirmed_at != null));
          if (moved) throw new NothingToDo();
          throw new Error(`${DROP} holds no card payment a confirmed settlement line is linked to`);
        }
        if (held.length > 1) throw new Error(`${DROP} holds ${held.length} card payments on confirmed settlement lines — name the case more narrowly`);
        const drop = held[0];
        const mine = linksOf(drop);
        if (mine.length !== 1) throw new Error(`the copy is linked to ${mine.length} settlement lines`);
        const line = mine[0];
        if (line.matched_with_row_id != null || line.group_members > 0) throw new Error(`settlement line ${line.row_id} was matched together with others — undo that group on the page`);
        if (line.row_links !== 1) throw new Error(`settlement line ${line.row_id} covers ${line.row_links} payments`);
        const twins = card(KEEP).filter((p) => Number(p.amount_sen) === Number(drop.amount_sen) && String(p.method) === String(drop.method)
          && norm(p.merchant_provider) === norm(drop.merchant_provider) && dayOf(p.paid_at) === dayOf(drop.paid_at) && linksOf(p).length === 0);
        if (twins.length !== 1) throw new Error(`${KEEP} holds ${twins.length} card payments of the same amount, day, method and bank with no settlement line — expected 1`);
        const keep = twins[0];
        if (Number(line.gross) !== Number(keep.amount_sen)) throw new Error(`settlement line ${line.row_id} is not the amount of the payment on ${KEEP}`);
        const takeCode = norm(drop.approval_code) !== '' && norm(drop.approval_code) === norm(line.ref) && norm(keep.approval_code) !== norm(line.ref);
        say(`   settlement line ${line.row_id} (${line.acquirer_code}, statement ${line.batch_id}) is confirmed on the copy on ${DROP}${line.posted_je_no ? `, fee entry ${line.posted_je_no}` : ''}`);
        say(`   ${KEEP} holds its twin, on no settlement line; approval code to correct on it: ${takeCode ? 'yes' : 'no'}`);

        const sb = pgrestShim(tx, 'scm');
        const ctx = ({ client = sb, params = {}, query = {}, body } = {}) => ({
          env: { DB: d1Compat(() => tx) },
          req: { param: (k) => params[k], query: (k) => query[k], json: async () => body, path: '/api/scm/fix-card-payment-keyed-twice' },
          get: (k) => ({
            supabase: client, companyId: CO, allowedCompanyIds: [CO],
            user: { id: '00000000-0000-4000-8000-000000000001', user_metadata: { name: ACTOR } },
            houzsUser: { name: ACTOR, permissions: PERMS, permissions_set: new Set(PERMS) },
          })[k],
          json: (b, status = 200) => ({ body: b, status }),
        });
        const step = async (name, res, ok = 200) => {
          say(`   ${name}: ${res.status === ok ? 'done' : `REFUSED (${res.status} ${norm(res.body?.error)})`}`);
          if (res.status !== ok) { detail.refusal = { name, status: res.status, body: res.body }; throw new Error(`${name} was refused`); }
          return res.body;
        };

        await step('1 undo the confirmation', await settlementRowUnconfirm(ctx({ params: { id: String(line.row_id) } })));
        await step(`2 remove the copy from ${DROP}`, await deleteSoPaymentHandler(ctx({ params: { docNo: DROP, id: String(drop.id) }, query: { version: String(drop.version ?? 1), reason: REASON } })));
        if (takeCode) {
          const patch = mfgSalesOrders.routes.filter((r) => r.method === 'PATCH' && r.path === '/:docNo/payments/:id').at(-1);
          if (!patch) throw new Error('the payment edit route was not found');
          await step(`3 correct the approval code on ${KEEP}`, await patch.handler(ctx({
            client: withoutCollectorName(sb), params: { docNo: KEEP, id: String(keep.id) },
            body: { approvalCode: norm(drop.approval_code), reason: REASON, version: Number(keep.version ?? 1) },
          }), async () => {}));
        } else say('   3 approval code: nothing to correct');
        const confirmed = await step(`4 confirm the line on ${KEEP}`, await settlementConfirmRow(ctx({
          params: { id: String(line.row_id) },
          body: { matchReason: takeCode || norm(keep.approval_code) === norm(line.ref) ? 'ref' : 'manual', payments: [{ source: 'SOPAY', id: String(keep.id), docNo: KEEP, amountSen: Number(keep.amount_sen) }] },
        })));
        if (confirmed?.status !== 'confirmed') throw new Error(`the line answered "${norm(confirmed?.status)}", not confirmed`);
        if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);

        const after = await read(tx);
        const entries = await liveEntries(tx, [String(drop.id), String(keep.id), `SETTLE-${line.row_id}`, `SETTLEMOVE-${line.row_id}`]);
        /* The copy is gone from the order, so its receipts are read by its own id. */
        const oldReceipts = await tx`SELECT or_number, status FROM scm.acc_official_receipts WHERE company_id = ${CO} AND payment_source = 'SOPAY' AND payment_id::text = ${String(drop.id)} ORDER BY id`;
        detail.after = { ...after, entries, oldReceipts };
        const nowLinks = after.links.filter((l) => Number(l.row_id) === Number(line.row_id));
        const checks = {
          'the copy is gone': !after.pays.some((p) => String(p.id) === String(drop.id)),
          /* The contra (SOPAY_REVERSAL) stands by design; the payment's own entry must not. */
          'its entry is reversed': !entries.some((j) => j.source_doc_no === String(drop.id) && j.source_type === 'SOPAY'),
          'its receipt is no longer in force': oldReceipts.every((r) => r.status === 'CANCELLED'),
          [`the line is confirmed on ${KEEP} alone`]: nowLinks.length === 1 && nowLinks[0].payment_id === String(keep.id) && nowLinks[0].confirmed_at != null,
          [`${DROP} is paid to its total`]: squareOf(after, DROP),
          [`${KEEP} is paid to its total`]: squareOf(after, KEEP),
        };
        for (const [name, ok] of Object.entries(checks)) say(`   ${ok ? 'ok  ' : 'NOT '} ${name}`);
        const fee = entries.find((j) => j.source_doc_no === `SETTLE-${line.row_id}`);
        const receipt = after.receipts.find((r) => r.payment_id === String(keep.id) && r.status !== 'CANCELLED');
        say(`   fee entry now: ${fee ? fee.je_no : 'none'}   receipt on ${KEEP}: ${receipt ? `${receipt.or_number} ${receipt.status}` : 'none'}   the copy's receipt: ${oldReceipts.map((r) => `${r.or_number} ${r.status}`).join(', ') || 'none'}`);
        if (Object.values(checks).some((ok) => !ok)) throw new Error('the result is not what was meant');
        done = { rowId: Number(line.row_id), keepId: String(keep.id), dropId: String(drop.id) };
        if (!APPLY) throw new Rollback();
      });
    } catch (e) {
      if (e instanceof NothingToDo) { say(`\nNothing to do — the line is already confirmed on ${KEEP} and ${DROP} holds no copy. Nothing written.`); return; }
      if (!(e instanceof Rollback)) throw e;
      say(`\nRehearsal passed and was rolled back — nothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    const check = connect();
    try {
      const st = await read(check);
      const link = st.links.find((l) => Number(l.row_id) === done.rowId);
      const kept = link != null && link.payment_id === done.keepId && link.confirmed_at != null && !st.pays.some((p) => String(p.id) === done.dropId);
      say(`\nVerified on a fresh connection: ${kept ? `the line is confirmed on ${KEEP} and the copy on ${DROP} is gone` : 'NOT AS MEANT — read the two orders'}`);
      if (!kept) process.exitCode = 1;
    } finally { await check.end(); }
  } catch (e) {
    console.error(`${String(e?.message ?? e).slice(0, 300)} — nothing was kept.`);
    process.exitCode = 1;
  } finally {
    await sql.end();
    if (process.env.PUBKEY) {
      const hex = encryptToHex(detail);
      for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
    }
  }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
