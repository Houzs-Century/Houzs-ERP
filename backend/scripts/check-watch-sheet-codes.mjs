#!/usr/bin/env node
// check-watch-sheet-codes.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// On the watch list many payments carry the booklet number under Approval and the real swipe
// code under Account sheet, and the matcher reads Approval only. How many of the 720 are
// really on a merchant report already, and how many open report lines would find their sale?
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { settlementWatchlist } from '../src/scm/routes/accounting-settlement.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
const CO = 1;
const BOOKLET = /\b(?:HC|PG|ZNT|ZNF|EGT|ZNA)\s?-?\s?\d{2,}/i;
const CODE = /^(?:\d{4,8}|R\d{4,6})$/i;
const tally = (list, keyOf) => { const m = new Map(); for (const x of list) { const k = keyOf(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(' · '); };
const sum = (list, pick) => list.reduce((s, x) => s + Number(pick(x) ?? 0), 0);

const watch = async (tx, co, qs = '') => {
  const sb = pgrestShim(tx, 'scm');
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String(e?.stack ?? e).slice(0, 500) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase', sb);
    c.set('companyId', co);
    c.set('user', { id: null });
    c.set('houzsUser', { id: 0, role_name: 'Finance', permissions: ['scm.payment_voucher.post'], permissions_set: new Set(['scm.payment_voucher.post']) });
    c.set('allowedCompanyIds', [co]);
    c.set('companies', [{ id: co, code: String(co) }]);
    c.set('companyCode', String(co));
    await next();
  });
  app.get('/watchlist', settlementWatchlist);
  const res = await app.request(`/watchlist${qs}`);
  const body = await res.json();
  if (res.status !== 200) throw new Error(`watchlist ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
};

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const rows = (await watch(tx, CO)).recordedNotArrived;
  const every = (await watch(tx, CO, '?from=2020-01-01')).recordedNotArrived;
  const lines = await tx`
    SELECT r.id, r.batch_id, r.acquirer_code, r.txn_date, r.ref, r.gross_sen, r.bucket::text AS bucket, r.confirmed_at, b.file_name
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE r.company_id = ${CO}`;
  const withRef = lines.filter((l) => norm(l.ref));
  const byRef = new Map();
  for (const l of withRef) { const k = norm(l.ref); if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(l); }
  const statusOf = (l) => (l.confirmed_at ? 'confirmed' : l.bucket);
  out(`report lines: ${lines.length}, with a reference ${withRef.length}; by status ${tally(lines, statusOf)}`);
  out(`watch list: ${rows.length} rows, RM ${rm(sum(rows, (p) => p.amountSen))}; from the very start ${every.length} rows, RM ${rm(sum(every, (p) => p.amountSen))}`);
  const shape = rows.map((p) => ({ p, apprBooklet: BOOKLET.test(p.approvalCode ?? ''), sheetCode: CODE.test(String(p.accountSheet ?? '').trim()) }));
  out(`approval is a booklet number and account sheet looks like a swipe code: ${shape.filter((x) => x.apprBooklet && x.sheetCode).length}`);
  out(`approval is a booklet number and account sheet is anything else: ${shape.filter((x) => x.apprBooklet && !x.sheetCode).length}; sheets ${tally(shape.filter((x) => x.apprBooklet && !x.sheetCode), (x) => String(x.p.accountSheet ?? '').trim() || '(empty)').slice(0, 200)}`);

  /* The 720: is this payment already on a report, under either field? */
  const onReport = (p, code) => (byRef.get(norm(code)) ?? []).filter((l) => l.bucket !== 'IGNORED');
  const viaAppr = rows.map((p) => ({ p, ls: onReport(p, p.approvalCode) })).filter((x) => x.ls.length > 0);
  const viaSheet = rows.map((p) => ({ p, ls: onReport(p, p.accountSheet) })).filter((x) => x.ls.length > 0);
  const same = (x) => x.ls.some((l) => Number(l.gross_sen) === Number(x.p.amountSen));
  out(`of the list, a report line carries its Approval: ${viaAppr.length} (same amount ${viaAppr.filter(same).length}); RM ${rm(sum(viaAppr, (x) => x.p.amountSen))}`);
  out(`of the list, a report line carries its Account sheet: ${viaSheet.length} (same amount ${viaSheet.filter(same).length}); RM ${rm(sum(viaSheet, (x) => x.p.amountSen))}; RM with same amount ${rm(sum(viaSheet.filter(same), (x) => x.p.amountSen))}`);
  out(`those by the line's status: ${tally(viaSheet.flatMap((x) => x.ls), statusOf)}`);
  out(`those by merchant: ${tally(viaSheet.flatMap((x) => x.ls), (l) => l.acquirer_code)}`);
  for (const x of viaSheet.slice(0, 12)) {
    const l = x.ls[0];
    out(`   ${x.p.docNo} ${x.p.paidOn} ${rm(x.p.amountSen)} approval ${x.p.approvalCode ?? '-'} sheet ${x.p.accountSheet} <- ${l.acquirer_code} ${day(l.txn_date)} ${rm(l.gross_sen)} ${statusOf(l)} ${String(l.file_name).slice(0, 34)}`);
  }

  /* The other way: each open report line, does an unclaimed payment hold its reference? */
  const open = lines.filter((l) => !l.confirmed_at && l.bucket !== 'IGNORED');
  const free = (pick) => { const m = new Map(); for (const p of every) { const k = norm(pick(p)); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(p); } return m; };
  const apprMap = free((p) => p.approvalCode);
  const sheetMap = free((p) => p.accountSheet);
  const openFound = open.filter((l) => norm(l.ref)).map((l) => ({ l, appr: apprMap.get(norm(l.ref)) ?? [], sheet: sheetMap.get(norm(l.ref)) ?? [] }));
  out(`open lines: ${open.length}, RM ${rm(sum(open, (l) => l.gross_sen))}; with a reference ${openFound.length}; by status ${tally(open, statusOf)}`);
  out(`open lines an unclaimed payment holds under Approval: ${openFound.filter((x) => x.appr.length).length}; under Account sheet: ${openFound.filter((x) => x.sheet.length).length} (same amount ${openFound.filter((x) => x.sheet.some((p) => Number(p.amountSen) === Number(x.l.gross_sen))).length})`);
  for (const x of openFound.filter((y) => y.sheet.length).slice(0, 12)) {
    const p = x.sheet[0];
    out(`   ${x.l.acquirer_code} ${day(x.l.txn_date)} ${x.l.ref} ${rm(x.l.gross_sen)} ${statusOf(x.l)} -> ${p.docNo} ${p.paidOn} ${rm(p.amountSen)} approval ${p.approvalCode ?? '-'} sheet ${p.accountSheet}`);
  }
});
await sql.end();
