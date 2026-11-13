#!/usr/bin/env node
// check-commission-raw.mjs — READ ONLY, not for merge. Owner 2026-11-13:
// 「HC-SO-2610-454 为什么我在10月找没有啊？」, then 「要扣」 on a cancelled old order.
// Runs THIS BRANCH's Event Commission handler for one or more ranges, by fair
// and by SO date, on production data as it stands and hands back the answers
// exactly as the page receives them, so the operator can draw the page locally
// and compare one engine with another order by order.
// The Actions log is PUBLIC, so everything is written ENCRYPTED (RSA-OAEP-256 +
// AES-256-GCM, PUBKEY = base64 SPKI DER) as lowercase hex lines; plain lines say
// only which parts were read. Writes nothing: one READ ONLY transaction.
// RE-RUN: safe to run again, it only reads.
// Env: DATABASE_URL, PUBKEY, RANGES ("2026-09-01:2026-09-30,2026-10-01:2026-10-31", default
// September to November 2026), or FROM + TO for one range; COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const RANGES = (process.env.FROM && process.env.TO
  ? `${process.env.FROM}:${process.env.TO}`
  : process.env.RANGES || '2026-09-01:2026-09-30,2026-10-01:2026-10-31,2026-11-01:2026-11-30')
  .split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [from, to] = s.split(':'); return { from, to }; });
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
  const out = { at: new Date().toISOString(), company: CO, ranges: {} };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin('read only', async (tx) => {
      for (const rg of RANGES) {
        const bodies = {};
        for (const basis of ['fair', 'so_date']) {
          try {
            bodies[basis] = await tx.savepoint(async (sp) => {
              const c = {
                env: { DB: d1Compat(() => sp) },
                req: { query: (k) => ({ from: rg.from, to: rg.to, basis })[k], path: '/api/scm/acc-events/commission' },
                get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? pgrestShim(sp, 'scm') : undefined),
                json: (body, status = 200) => ({ body, status }),
              };
              const res = await eventCommissionHandler(c);
              return res.status === 200 ? res.body : { error: `HTTP ${res.status}` };
            });
            say(`${rg.from} ${basis}: read`);
          } catch (e) {
            bodies[basis] = { error: String(e?.message ?? e).slice(0, 200) };
            say(`${rg.from} ${basis}: failed`);
          }
        }
        out.ranges[`${rg.from}:${rg.to}`] = bodies;
      }
    });
  } finally { await sql.end(); }

  const hex = encryptToHex(out);
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`encrypted ${hex.length / 2} bytes`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
