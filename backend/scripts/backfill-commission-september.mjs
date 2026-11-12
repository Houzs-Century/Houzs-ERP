#!/usr/bin/env node
/* backfill-commission-september.mjs — September 2026 worked out again (owner
   2026-11-12, Event Commission: 「9月的我就是要重新算过」 … 做).

   September was closed on 2026-10-26 as a baseline (its commission had been
   paid outside the system), and the record of upsales / drop sales starts on
   1 October (1–19 October rebuilt from each order's modification history by
   backfill-so-total-changes.mjs, recorded live from 20 October). To work
   September out the way October is, this script does two things, together:
     1. writes September's changes (1–30 September, Malaysian time) into
        scm.so_total_changes, rebuilt from the history the same way and tagged
        the same way ('history' / 'history-ignored', lib/so-total-history.mjs);
     2. reopens 2026/09 — removes its close, as Finance's Reopen does, with the
        same audit row — so the month is live again for Finance to check and
        close.
   October's own orders keep their commission: every row written is dated in
   September, and an order's goods on a day in October are read from the
   changes after that day only. What October loses is the adjustments it paid
   for September's orders; they are September's own again.

   MODE=plan (default) reads, rebuilds and checks every order with a line change
   or an approved amendment in the window, then — inside ONE transaction that is
   ROLLED BACK — works out September (as if never closed) and October, by fair
   and by SO date, writes the rows, removes the close, and works them out again.
   Nothing is kept.
   MODE=apply with CONFIRM="RECALCULATE SEPTEMBER 2026" writes the rows of every
   order whose checks pass (SKIP_ORDERS=doc,doc leaves more out; INCLUDE_ORDERS
   =doc,doc takes a flagged order in after reading it) and reopens 2026/09, in
   one transaction; then re-reads both on a fresh connection and exits 1 if
   either is not as written.

   The Actions log is PUBLIC: plain lines carry counts only; every amount, order
   number and name goes into the ENC| lines (RSA-OAEP-256 + AES-256-GCM to
   PUBKEY, base64 SPKI DER, read locally). Without PUBKEY no detail is printed.

   RE-RUN: refuses to apply when a row is already dated in the window, or when
   2026/09 is not the latest closed month — run twice, the second run writes
   nothing.
   Env: DATABASE_URL, PUBKEY, COMPANY_ID (default 1), FROM (default
        2026-08-31T16:00:00Z = 1/9 00:00 MYT), TO (default 2026-09-30T16:00:00Z
        = 1/10 00:00 MYT, where the October back-fill begins), FLOOR (default
        2026-07-31T16:00:00Z: how far back the zeroing bug is traced),
        BUG_FIXED_AT (default 2026-10-07T10:00:00Z), SKIP_ORDERS, INCLUDE_ORDERS. */
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';
import { walkOrder, classify, rowsFor, totalsAt } from './lib/so-total-history.mjs';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'RECALCULATE SEPTEMBER 2026';
const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = '2026-09';
const FROM = process.env.FROM || '2026-08-31T16:00:00Z';
const TO = process.env.TO || '2026-09-30T16:00:00Z';
const FLOOR = process.env.FLOOR || '2026-07-31T16:00:00Z';
/* BUG-63's fix (#4509, merged 2026-10-07 09:31 UTC): a direct edit's zeroing after it is a person's price. */
const BUG_FIXED_AT = process.env.BUG_FIXED_AT || '2026-10-07T10:00:00Z';
const ACTOR = 'Finance — September worked out again (owner 2026-11-12)';
const list = (v) => new Set(String(v ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
const SKIP = list(process.env.SKIP_ORDERS);
const INCLUDE = list(process.env.INCLUDE_ORDERS);
const HISTORY = 'history';
const HISTORY_IGNORED = 'history-ignored';

const say = (s) => console.log(`ROW|${s}`);
const n = (v) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };

/* Everything with an amount or a name goes here, and leaves the run encrypted. */
const detail = { at: new Date().toISOString(), company: CO, mode: APPLY ? 'apply' : 'plan', window: { FROM, TO, FLOOR, BUG_FIXED_AT }, orders: [], reports: {}, applied: null };
function printDetail() {
  if (!process.env.PUBKEY) { say('PUBKEY is not set — the detail is not printed (the log is public).'); return; }
  const pub = crypto.createPublicKey({ key: Buffer.from(String(process.env.PUBKEY), 'base64'), format: 'der', type: 'spki' });
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(ek.length);
  const hex = Buffer.concat([len, ek, iv, cipher.getAuthTag(), ct]).toString('hex');
  for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
  say(`detail encrypted: ${hex.length / 2} bytes`);
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
/* The app's builder with the closed months hidden — September as if never closed. */
const withoutCloses = (sb) => new Proxy(sb, {
  get(target, prop) {
    if (prop === 'from') return (name) => (name === 'event_commission_closes' ? noRows() : target.from(name));
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

/** The live Event Commission handler over `tx`, for one range and basis. */
async function report(tx, from, to, basis, { hideCloses = false } = {}) {
  const shim = pgrestShim(tx, 'scm');
  const c = {
    env: { DB: d1Compat(() => tx) },
    req: { query: (k) => ({ from, to, basis })[k], path: '/api/scm/acc-events/commission' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? (hideCloses ? withoutCloses(shim) : shim) : undefined),
    json: (body, status = 200) => ({ body, status }),
  };
  const res = await eventCommissionHandler(c);
  if (res.status !== 200) throw new Error(`report ${from}..${to} ${basis}: HTTP ${res.status}`);
  return res.body;
}
/** A report in brief: its totals, and every order's commission on it. */
const brief = (rep) => ({
  closed: rep.closed ?? null,
  totals: rep.totals,
  partOne: Object.fromEntries(rep.fairs.flatMap((f) => f.sos.map((s) => [s.docNo, { fairId: f.id, goodsSen: s.goodsSen, reachedOn: s.reachedOn, commissionSen: s.commissionSen }]))),
  earlier: Object.fromEntries((rep.earlierOrders ?? []).map((o) => [o.docNo, { events: o.events, commissionSen: o.commissionSen }])),
  changed: (rep.changedOrders ?? []).map((o) => ({ docNo: o.docNo, part: o.part, amendedSen: o.amendedSen, effectSen: o.effectSen, fromHistory: o.fromHistory })),
  monthAdjustments: (rep.monthAdjustments ?? []).length,
});
/* The orders whose commission moved between two briefs. */
const moved = (a, b) => {
  const out = [];
  for (const part of ['partOne', 'earlier']) {
    for (const doc of new Set([...Object.keys(a[part]), ...Object.keys(b[part])])) {
      const x = a[part][doc]?.commissionSen ?? null;
      const y = b[part][doc]?.commissionSen ?? null;
      if (x !== y) out.push({ part, doc, before: x, after: y });
    }
  }
  return out;
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) { console.error(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`); process.exit(2); }
  const fromMs = Date.parse(FROM);
  const toMs = Date.parse(TO);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`backfill-commission-september  company ${CO}  mode ${APPLY ? 'APPLY' : 'PLAN'}  window ${FROM} .. ${TO}`);
    const [inWindow] = await sql`SELECT count(*)::int AS n FROM scm.so_total_changes WHERE company_id = ${CO} AND changed_at >= ${FROM} AND changed_at < ${TO}`;
    say(`rows already dated in the window: ${inWindow.n}`);
    const closes = await sql`SELECT to_char(month, 'YYYY-MM') AS month FROM scm.event_commission_closes WHERE company_id = ${CO} ORDER BY month`;
    const latest = closes.length > 0 ? closes[closes.length - 1].month : null;
    say(`closed months: ${closes.map((r) => r.month).join(', ') || 'none'} — ${MONTH} ${latest === MONTH ? 'is the latest, can be reopened' : 'is NOT the latest closed month'}`);

    const docRows = await sql`SELECT DISTINCT a.so_doc_no FROM scm.mfg_so_audit_log a
      WHERE a.company_id = ${CO} AND a.created_at >= ${FROM} AND a.created_at < ${TO}
        AND ((a.action IN ('ADD_LINE', 'DELETE_LINE', 'UPDATE_LINE') AND coalesce(a.source, 'web') <> 'auto-allocation') OR a.action = 'AMENDMENT_SO_APPROVED')`;
    const docs = docRows.map((r) => r.so_doc_no);
    say(`orders with a line change or an approved amendment in the window: ${docs.length}`);

    const headers = docs.length === 0 ? [] : await sql`SELECT doc_no, company_id, created_at, status, delivery_fee_sen,
        (coalesce(mattress_sofa_sen,0) + coalesce(bedframe_sen,0) + coalesce(accessories_sen,0) + coalesce(others_sen,0))::bigint AS goods, local_total_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${docs})`;
    const lines = docs.length === 0 ? [] : await sql`SELECT id::text, doc_no, item_code, item_group, qty, unit_price_sen, discount_sen, total_sen, cancelled, variants->>'buildKey' AS build_key
      FROM scm.mfg_sales_order_items WHERE doc_no = ANY(${docs})`;
    const events = docs.length === 0 ? [] : await sql`SELECT id::text, so_doc_no, action, source, actor_name_snapshot, field_changes, created_at FROM scm.mfg_so_audit_log
      WHERE so_doc_no = ANY(${docs}) AND created_at >= ${FLOOR}
        AND (action IN ('CREATE', 'ADD_LINE', 'DELETE_LINE', 'AMENDMENT_SO_APPROVED') OR (action = 'UPDATE_LINE' AND coalesce(source, 'web') <> 'auto-allocation'))`;
    const revisions = docs.length === 0 ? [] : await sql`SELECT so_doc_no, amendment_id::text, created_at, snapshot->'lines' AS lines FROM scm.so_revisions
      WHERE so_doc_no = ANY(${docs}) AND created_at >= ${FLOOR}`;
    const amendIds = [...new Set(revisions.map((r) => r.amendment_id).filter(Boolean))];
    const amendZeroRows = amendIds.length === 0 ? [] : await sql`SELECT l.sales_order_item_id::text AS line_id FROM scm.so_amendment_lines l
      WHERE l.amendment_id = ANY(${amendIds}::uuid[]) AND l.change_type = 'SPEC'
        AND COALESCE(l.old_snapshot->>'unitPriceSen', l.old_snapshot->>'unit_price_sen')::bigint > 0 AND COALESCE(l.new_unit_price_sen, 0) = 0`;
    const amendZero = new Set(amendZeroRows.map((r) => r.line_id));
    /* Every row already recorded after the window — the October back-fill's and
       the live recorder's: the first one's "before" is the order at the window's end. */
    const recorded = docs.length === 0 ? [] : await sql`SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen FROM scm.so_total_changes
      WHERE company_id = ${CO} AND so_doc_no = ANY(${docs}) AND changed_at >= ${TO} ORDER BY changed_at`;
    say(`read: ${lines.length} lines, ${events.length} history rows, ${revisions.length} amendment snapshots (${amendZero.size} SPEC lines at price 0), ${recorded.length} rows recorded after the window`);

    const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const linesBy = by(lines, 'doc_no');
    const eventsBy = by(events, 'so_doc_no');
    const revBy = by(revisions, 'so_doc_no');
    const recBy = by(recorded, 'so_doc_no');

    const plan = [];
    const tally = { orders: 0, withRows: 0, flagged: 0, createOk: 0, createBad: 0, endOk: 0, endBad: 0 };
    for (const h of [...headers].sort((a, b) => String(a.doc_no).localeCompare(String(b.doc_no)))) {
      const doc = h.doc_no;
      tally.orders += 1;
      const w = walkOrder({
        lines: linesBy.get(doc) ?? [],
        events: (eventsBy.get(doc) ?? []).map((e) => ({ id: e.id, at: new Date(e.created_at).getTime(), action: e.action, source: e.source ?? 'web', actor: e.actor_name_snapshot, fields: e.field_changes })),
        revisions: (revBy.get(doc) ?? []).map((r) => ({ at: new Date(r.created_at).getTime(), amendmentId: r.amendment_id, lines: r.lines ?? [] })),
        headerFeeSen: n(h.delivery_fee_sen),
      });
      classify(w.steps, amendZero, { bugFixedAt: Date.parse(BUG_FIXED_AT), openedAt: new Date(h.created_at).getTime() });
      const rows = rowsFor(w.steps, fromMs, toMs, { HISTORY, HISTORY_IGNORED });

      // CHECK 1: the rebuilt order at CREATE is what CREATE recorded.
      const create = w.create && w.create.at >= Date.parse(FLOOR) ? w.create : null;
      if (create) { if (create.ok) tally.createOk += 1; else tally.createBad += 1; }
      // CHECK 2: at the window's end, the rebuilt goods are what was recorded next (else the header now).
      const recs = recBy.get(doc) ?? [];
      const wantEnd = recs.length > 0 ? { goods: n(recs[0].before_goods_sen), total: n(recs[0].before_total_sen) } : { goods: n(h.goods), total: n(h.local_total_sen) };
      const gotEnd = totalsAt(w.steps, toMs, w.nowTotals);
      const endOk = gotEnd.goods === wantEnd.goods;
      if (endOk) tally.endOk += 1; else tally.endBad += 1;
      // the recorded chain after the window must not jump (a jump = a change nobody recorded)
      const gaps = [];
      for (let i = 1; i < recs.length; i += 1) if (n(recs[i].before_goods_sen) !== n(recs[i - 1].after_goods_sen)) gaps.push(new Date(recs[i].changed_at).toISOString());
      const nowOk = w.nowTotals.goods === n(h.goods);

      const winProblems = w.problems.filter((p) => p.at >= fromMs && p.at < toMs);
      const unreliable = rows.some((r) => !r.reliable);
      const flagged = !endOk || (create && !create.ok) || winProblems.length > 0 || unreliable || gaps.length > 0 || !nowOk;
      if (flagged) tally.flagged += 1;
      if (rows.length > 0) tally.withRows += 1;
      const take = rows.length > 0 && !SKIP.has(doc) && (!flagged || INCLUDE.has(doc));
      plan.push({ doc, companyId: n(h.company_id), rows, take, flagged });
      if (rows.length > 0 || flagged) {
        detail.orders.push({
          doc, take, flagged, openedAt: new Date(h.created_at).toISOString(),
          endCheck: endOk ? 'ok' : { rebuilt: gotEnd.goods, recorded: wantEnd.goods },
          create: create ? (create.ok ? 'ok' : { rebuilt: create.got, recorded: create.want }) : null,
          nowCheck: nowOk ? 'ok' : { lines: w.nowTotals.goods, header: n(h.goods) },
          gaps,
          rows: rows.map((r) => ({ at: new Date(r.at).toISOString(), source: r.source, kind: r.kind, beforeGoods: r.beforeGoods, afterGoods: r.afterGoods, beforeTotal: r.beforeTotal, afterTotal: r.afterTotal, why: r.why ?? null, actor: r.actor ?? null, reliable: r.reliable })),
          problems: winProblems.map((p) => ({ at: new Date(p.at).toISOString(), action: p.action, what: p.what })),
        });
      }
    }
    const take = plan.filter((p) => p.take);
    const rowsToWrite = take.flatMap((p) => p.rows.map((r) => ({ ...r, doc: p.doc, companyId: p.companyId })));
    const wantNet = rowsToWrite.reduce((s, r) => s + (r.afterGoods - r.beforeGoods), 0);
    say(`orders ${tally.orders}, with rows ${tally.withRows}, flagged ${tally.flagged}; CREATE check ok ${tally.createOk} / bad ${tally.createBad}; end check ok ${tally.endOk} / bad ${tally.endBad}`);
    say(`to write: ${rowsToWrite.length} rows on ${take.length} orders (${rowsToWrite.filter((r) => r.source === HISTORY).length} counted kind, ${rowsToWrite.filter((r) => r.source === HISTORY_IGNORED).length} system fix); flagged and left out: ${plan.filter((p) => p.flagged && p.rows.length > 0 && !p.take).length}`);

    const insertRows = async (tx) => {
      for (const r of rowsToWrite) {
        await tx`INSERT INTO scm.so_total_changes (company_id, so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by)
          VALUES (${r.companyId}, ${r.doc}, ${new Date(r.at).toISOString()}, ${r.beforeGoods}, ${r.afterGoods}, ${r.beforeTotal}, ${r.afterTotal}, ${r.source}, ${r.actor})`;
      }
    };
    /* Reopen 2026/09 exactly as POST /commission/reopen does: the latest close
       only, DELETE … RETURNING, then the REVERSE row in the entity audit log. */
    const reopen = async (tx) => {
      const [last] = await tx`SELECT to_char(month, 'YYYY-MM') AS month FROM scm.event_commission_closes WHERE company_id = ${CO} ORDER BY month DESC LIMIT 1`;
      if (!last || last.month !== MONTH) throw new Error(`${MONTH} is not the latest closed month (${last?.month ?? 'none closed'}) — nothing was written`);
      const gone = await tx`DELETE FROM scm.event_commission_closes WHERE company_id = ${CO} AND month = ${`${MONTH}-01`} RETURNING month`;
      if (gone.length !== 1) throw new Error(`${MONTH} close not removed (${gone.length} rows) — nothing was written`);
      await tx`INSERT INTO scm.entity_audit_log (entity_type, entity_id, entity_doc_no, company_id, action, actor_name_snapshot, field_changes, source, note)
        VALUES ('COMMISSION_MONTH', ${`${CO}:${MONTH}`}, ${MONTH}, ${CO}, 'REVERSE', ${ACTOR}, '[]'::jsonb, 'script',
          ${`Event Commission ${MONTH.replace('-', '/')} reopened to be worked out again; its upsales / drop sales of 1–30 September read from each order's modification history (${rowsToWrite.length} rows)`})`;
    };

    const ROLLBACK = new Error('rollback');
    if (!APPLY) {
      try {
        await sql.begin(async (tx) => {
          const before = {};
          for (const basis of ['fair', 'so_date']) {
            before[`sep ${basis}`] = brief(await report(tx, '2026-09-01', '2026-09-30', basis, { hideCloses: true }));
            before[`oct ${basis}`] = brief(await report(tx, '2026-10-01', '2026-10-31', basis));
          }
          await insertRows(tx);
          if (latest === MONTH) await reopen(tx);
          for (const basis of ['fair', 'so_date']) {
            const sep = brief(await report(tx, '2026-09-01', '2026-09-30', basis));
            const oct = brief(await report(tx, '2026-10-01', '2026-10-31', basis));
            detail.reports[`sep ${basis}`] = { before: before[`sep ${basis}`], after: sep, moved: moved(before[`sep ${basis}`], sep) };
            detail.reports[`oct ${basis}`] = { before: before[`oct ${basis}`], after: oct, moved: moved(before[`oct ${basis}`], oct) };
            const octPartOne = detail.reports[`oct ${basis}`].moved.filter((m) => m.part === 'partOne').length;
            say(`by ${basis}: September orders whose commission moves ${detail.reports[`sep ${basis}`].moved.length}; October orders opened in the range whose commission moves ${octPartOne}; September is ${sep.closed ? 'still closed' : 'open'}`);
          }
          throw ROLLBACK;
        });
      } catch (e) { if (e !== ROLLBACK) throw e; }
      say('PLAN only — nothing was written (everything ran inside a transaction that was rolled back).');
      printDetail();
      return;
    }

    if (inWindow.n > 0) throw new Error(`${inWindow.n} rows are already dated in the window — this back-fill runs once (see RE-RUN)`);
    if (latest !== MONTH) throw new Error(`${MONTH} is not the latest closed month — nothing was written`);
    await sql.begin(async (tx) => { await insertRows(tx); await reopen(tx); });
    const sql2 = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    let ok = true;
    try {
      const [chk] = await sql2`SELECT count(*)::int AS n, coalesce(sum(after_goods_sen - before_goods_sen), 0)::bigint AS net
        FROM scm.so_total_changes WHERE company_id = ${CO} AND changed_at >= ${FROM} AND changed_at < ${TO}`;
      const [still] = await sql2`SELECT count(*)::int AS n FROM scm.event_commission_closes WHERE company_id = ${CO} AND month = ${`${MONTH}-01`}`;
      const rowsOk = chk.n === rowsToWrite.length && n(chk.net) === wantNet;
      ok = rowsOk && still.n === 0;
      say(`APPLIED: ${chk.n} rows in the window (planned ${rowsToWrite.length}), net ${n(chk.net) === wantNet ? 'as planned' : 'NOT as planned'}; ${MONTH} ${still.n === 0 ? 'reopened' : 'STILL CLOSED'} — ${ok ? 'AS WRITTEN' : 'NOT AS WRITTEN'}`);
      detail.applied = { rows: chk.n, planned: rowsToWrite.length, net: n(chk.net), plannedNet: wantNet, closeLeft: still.n };
      for (const basis of ['fair', 'so_date']) {
        detail.reports[`sep ${basis} now`] = brief(await report(sql2, '2026-09-01', '2026-09-30', basis));
        detail.reports[`oct ${basis} now`] = brief(await report(sql2, '2026-10-01', '2026-10-31', basis));
      }
    } finally { await sql2.end(); }
    printDetail();
    if (!ok) process.exitCode = 1;
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
