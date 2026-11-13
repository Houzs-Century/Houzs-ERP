#!/usr/bin/env node
// fill-closed-commission-goods.mjs — a closed month's frozen Event Commission report gets the Goods and
// Rate its "Closed months — adjustments" rows are worked on, where it was frozen before rows carried
// them. Display fields only: nothing paid moves.
//
// Owner 2026-11-13 (「补上」): October was closed at 21:30 MYT; the page began to show the goods and
// rate behind a closed month's adjustment at 22:34 (PR #5716), so October's three rows for September
// show "–" there.
//
// For each view (by fair, by SO date), the frozen report's adjustment rows with no goods; for each
// month they belong to, that month recalculated now by the app's own handler — its close set aside
// inside a savepoint that is always rolled back, so the handler works it out live, marks and all —
// and goodsAndRateOf (lib/event-commission.ts) gives the goods and rate. A row is filled only when
// goods × rate gives back its frozen Now exactly; any other is left as it is and listed.
//
// MODE=plan (default) does all of it inside one transaction that is rolled back — nothing is written.
// MODE=apply with CONFIRM="FILL CLOSED COMMISSION GOODS" keeps it, then reads the month back on a
// fresh connection: the rows carry goods and rate, and the totals and every row's Paid, Now and
// Adjustment are what they were. Prints document numbers and yes / no only (the Actions log is
// public); with PUBKEY the figures go out ENCRYPTED (RSA-OAEP-256 + AES-256-GCM).
//
// RE-RUN: a row that carries goods already is left alone, so a second run writes nothing.
// Env: DATABASE_URL, MONTH (YYYY-MM, the closed month to fill), COMPANY_ID (default 1), PUBKEY (optional).
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { goodsAndRateOf } from '../src/scm/lib/event-commission.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const PHRASE = 'FILL CLOSED COMMISSION GOODS';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = String(process.env.MONTH ?? '').trim();
const BASES = [['fair', 'report_fair'], ['so_date', 'report_so_date']];
const say = (s) => console.log(s);
class Rollback extends Error {}

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

const monthEnd = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const ctxOf = (db, query) => ({
  env: { DB: d1Compat(() => db) },
  req: { query: (k) => query[k], path: '/api/scm/acc-events/commission' },
  get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? pgrestShim(db, 'scm') : undefined),
  json: (body, status = 200) => ({ body, status }),
});
const readClose = async (db) => (await db`
  SELECT id::text AS id, report_fair, report_so_date FROM scm.event_commission_closes WHERE company_id = ${CO} AND month = ${`${MONTH}-01`}::date`)[0] ?? null;

/** A month recalculated now, as the handler works it out when the month is not closed: its close set
    aside in a savepoint that is rolled back whatever happens. */
async function liveMonth(tx, month, basis) {
  let body = null;
  const UNDO = Symbol('undo');
  try {
    await tx.savepoint(async (sp) => {
      await sp`DELETE FROM scm.event_commission_closes WHERE company_id = ${CO} AND month = ${`${month}-01`}::date`;
      const res = await eventCommissionHandler(ctxOf(sp, { from: `${month}-01`, to: monthEnd(`${month}-01`), basis }));
      if (res.status !== 200) throw new Error(`${month} ${basis} could not be read (${res.status} ${res.body?.error ?? ''})`);
      body = res.body;
      throw UNDO;
    });
  } catch (e) {
    if (e !== UNDO) throw e;
  }
  if (!body || body.closed) throw new Error(`${month} ${basis} came back as closed — not recalculated`);
  return body;
}

/** What must not move: the totals, and each row's month, order and amounts. */
const fingerprint = (report) => JSON.stringify({
  totals: report.totals,
  rows: (report.monthAdjustments ?? []).map((a) => [a.month, a.docNo, a.wasSen, a.nowSen, a.adjustmentSen]),
});

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) { console.error('MONTH=YYYY-MM (a closed month) is required — nothing was written.'); process.exit(2); }
  const detail = { at: new Date().toISOString(), company: CO, month: MONTH, filled: [], left: [] };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  let before = null;
  let wrote = 0;
  try {
    say(`fill-closed-commission-goods   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   closed month ${MONTH}`);
    try {
      await sql.begin(async (tx) => {
        const close = await readClose(tx);
        if (!close) throw new Error(`${MONTH} is not a closed month`);
        before = Object.fromEntries(BASES.map(([, col]) => [col, fingerprint(close[col])]));
        const next = {};
        for (const [basis, col] of BASES) {
          const report = close[col];
          const rows = report.monthAdjustments ?? [];
          const need = rows.filter((a) => a.goodsSen == null);
          say(`   ${basis}: ${rows.length} adjustment row(s), ${need.length} with no goods`);
          if (need.length === 0) continue;
          const worked = new Map();
          for (const m of [...new Set(need.map((a) => a.month))]) worked.set(m, goodsAndRateOf(await liveMonth(tx, m, basis)));
          let changed = 0;
          const filled = rows.map((a) => {
            if (a.goodsSen != null) return a;
            const g = worked.get(a.month)?.get(a.docNo);
            const fits = g != null && g.ratePct != null && Math.round((g.goodsSen * g.ratePct) / 100) === Number(a.nowSen);
            if (!fits) {
              detail.left.push({ basis, month: a.month, docNo: a.docNo, nowSen: a.nowSen, worked: g ?? null });
              say(`      ${a.docNo} (${a.month}): left as it is — ${g == null ? 'the month pays it on nothing now' : 'goods × rate does not give its Now'}`);
              return a;
            }
            changed += 1;
            detail.filled.push({ basis, month: a.month, docNo: a.docNo, goodsSen: g.goodsSen, ratePct: g.ratePct, nowSen: a.nowSen });
            say(`      ${a.docNo} (${a.month}): goods and rate added`);
            return { ...a, goodsSen: g.goodsSen, ratePct: g.ratePct };
          });
          if (changed > 0) next[col] = { ...report, monthAdjustments: filled };
        }
        const cols = Object.keys(next);
        if (cols.length === 0) { say('\nNothing to fill — nothing written.'); throw new Rollback(); }
        await tx`UPDATE scm.event_commission_closes
                    SET report_fair = ${tx.json(next.report_fair ?? close.report_fair)}, report_so_date = ${tx.json(next.report_so_date ?? close.report_so_date)}
                  WHERE id = ${close.id}::uuid AND company_id = ${CO}`;
        wrote = detail.filled.length;
        /* Read back as the page reads it: the month served closed, the rows with goods, nothing else moved. */
        for (const [basis, col] of BASES) {
          const res = await eventCommissionHandler(ctxOf(tx, { from: `${MONTH}-01`, to: monthEnd(`${MONTH}-01`), basis }));
          const ok = res.status === 200 && res.body.closed?.month === MONTH && fingerprint(res.body) === before[col]
            && detail.filled.filter((f) => f.basis === basis).every((f) => (res.body.monthAdjustments ?? []).some((a) => a.docNo === f.docNo && a.month === f.month && a.goodsSen === f.goodsSen && a.ratePct === f.ratePct));
          say(`   ${basis}: served closed, the rows with goods and rate, totals and amounts unchanged — ${ok ? 'yes' : 'NO'}`);
          if (!ok) throw new Error(`the ${basis} read-back is not what was meant`);
        }
        if (!APPLY) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      if (wrote > 0) say(`\nRehearsal passed and was rolled back — nothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    say(`\n   filled: ${wrote} row(s)`);
    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const after = await readClose(check);
      const same = BASES.every(([, col]) => fingerprint(after[col]) === before[col]);
      const there = detail.filled.every((f) => (after[BASES.find(([b]) => b === f.basis)[1]].monthAdjustments ?? []).some((a) => a.docNo === f.docNo && a.goodsSen === f.goodsSen));
      say(`Verified on a fresh connection: amounts unchanged ${same ? 'yes' : 'NO'}, goods and rate there ${there ? 'yes' : 'NO'}`);
      if (!same || !there) process.exitCode = 1;
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
