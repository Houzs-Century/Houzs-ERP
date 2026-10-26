#!/usr/bin/env node
/* backfill-so-total-changes.mjs — the order changes of 1 October 2026 up to the
   moment the recorder started (scm.so_total_changes, first row 2026-10-20 09:10
   UTC), rebuilt from the SO modification history and written into that table.

   WHY (owner 2026-10-26, Event Commission round 2): 「10月的我也要算」 —
   upsales and drop sales count from 1 October, each in the month it happened,
   at the fair's brand rate — and 「本身不是有history吗？」: straight from the
   history, no Excel. The rows carry source 'history' (counted like any change)
   or 'history-ignored' (the price-zeroing bug and its put-backs; the report
   shows them as "system price fix, not counted"). How one order is rebuilt and
   checked: lib/so-total-history.mjs.

   MODE=plan (default) reads, rebuilds, prints every order's rows and checks,
   then runs the live Event Commission handler for October twice inside ONE
   transaction — before and after inserting the rows — and ROLLS IT BACK.
   Nothing is written.
   MODE=apply with CONFIRM="WRITE OCTOBER HISTORY ROWS" writes the rows the plan
   printed for every order whose checks pass (SKIP_ORDERS=doc,doc leaves more
   out; INCLUDE_ORDERS=doc,doc takes a flagged order in after reading it), in
   one transaction, then re-reads them on a fresh connection.

   Env: DATABASE_URL, FROM (default 2026-09-30T16:00:00Z = 1/10 00:00 MYT),
        FLOOR (default 2026-07-31T16:00:00Z: how far back the zeroing bug is
        traced), BUG_FIXED_AT (default 2026-10-07T10:00:00Z), SKIP_ORDERS,
        INCLUDE_ORDERS.

   RE-RUN: refuses to apply when any 'history' / 'history-ignored' row already
   exists — the back-fill happens once. To redo it: delete those rows first
   (DELETE FROM scm.so_total_changes WHERE source IN ('history','history-ignored')). */
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';
import { walkOrder, classify, rowsFor, totalsAt } from './lib/so-total-history.mjs';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'WRITE OCTOBER HISTORY ROWS';
const FROM = process.env.FROM || '2026-09-30T16:00:00Z';
const FLOOR = process.env.FLOOR || '2026-07-31T16:00:00Z';
/* BUG-63's fix (#4509, merged 2026-10-07 09:31 UTC): a direct edit's zeroing after it is a person's price. */
const BUG_FIXED_AT = process.env.BUG_FIXED_AT || '2026-10-07T10:00:00Z';
const list = (v) => new Set(String(v ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
const SKIP = list(process.env.SKIP_ORDERS);
const INCLUDE = list(process.env.INCLUDE_ORDERS);
const HISTORY = 'history';
const HISTORY_IGNORED = 'history-ignored';

const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const myt = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const out = (s) => console.log(`ROW|${s}`);
const n = (v) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) { console.error(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const [first] = await sql`SELECT min(changed_at) AS at FROM scm.so_total_changes WHERE source NOT IN (${HISTORY}, ${HISTORY_IGNORED})`;
    if (!first?.at) throw new Error('the recorder has no rows — nothing to anchor the end of the window on');
    const TO = new Date(first.at).toISOString();
    const fromMs = Date.parse(FROM);
    const toMs = Date.parse(TO);
    out(`window ${FROM} .. ${TO} (MYT ${myt(fromMs)} .. ${myt(toMs)}); zeroing traced back to ${FLOOR}`);
    const [already] = await sql`SELECT count(*)::int AS n FROM scm.so_total_changes WHERE source IN (${HISTORY}, ${HISTORY_IGNORED})`;
    out(`history rows already in the table: ${already.n}`);

    const docRows = await sql`SELECT DISTINCT a.so_doc_no FROM scm.mfg_so_audit_log a
      WHERE a.created_at >= ${FROM} AND a.created_at < ${TO}
        AND ((a.action IN ('ADD_LINE', 'DELETE_LINE', 'UPDATE_LINE') AND coalesce(a.source, 'web') <> 'auto-allocation') OR a.action = 'AMENDMENT_SO_APPROVED')`;
    const docs = docRows.map((r) => r.so_doc_no);
    out(`orders with a line change or an approved amendment in the window: ${docs.length}`);

    const headers = await sql`SELECT doc_no, company_id, created_at, status, delivery_fee_sen,
        (coalesce(mattress_sofa_sen,0) + coalesce(bedframe_sen,0) + coalesce(accessories_sen,0) + coalesce(others_sen,0))::bigint AS goods, local_total_sen
      FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docs})`;
    const lines = await sql`SELECT id::text, doc_no, item_code, item_group, qty, unit_price_sen, discount_sen, total_sen, cancelled, variants->>'buildKey' AS build_key
      FROM scm.mfg_sales_order_items WHERE doc_no = ANY(${docs})`;
    const events = await sql`SELECT id::text, so_doc_no, action, source, actor_name_snapshot, field_changes, created_at FROM scm.mfg_so_audit_log
      WHERE so_doc_no = ANY(${docs}) AND created_at >= ${FLOOR}
        AND (action IN ('CREATE', 'ADD_LINE', 'DELETE_LINE', 'AMENDMENT_SO_APPROVED') OR (action = 'UPDATE_LINE' AND coalesce(source, 'web') <> 'auto-allocation'))`;
    const revisions = await sql`SELECT so_doc_no, amendment_id::text, created_at, snapshot->'lines' AS lines FROM scm.so_revisions
      WHERE so_doc_no = ANY(${docs}) AND created_at >= ${FLOOR}`;
    const amendIds = [...new Set(revisions.map((r) => r.amendment_id).filter(Boolean))];
    const amendZeroRows = amendIds.length === 0 ? [] : await sql`SELECT l.sales_order_item_id::text AS line_id FROM scm.so_amendment_lines l
      WHERE l.amendment_id = ANY(${amendIds}::uuid[]) AND l.change_type = 'SPEC'
        AND COALESCE(l.old_snapshot->>'unitPriceSen', l.old_snapshot->>'unit_price_sen')::bigint > 0 AND COALESCE(l.new_unit_price_sen, 0) = 0`;
    const amendZero = new Set(amendZeroRows.map((r) => r.line_id));
    const recorded = await sql`SELECT so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen FROM scm.so_total_changes
      WHERE so_doc_no = ANY(${docs}) AND source NOT IN (${HISTORY}, ${HISTORY_IGNORED}) ORDER BY changed_at`;
    out(`read: ${lines.length} lines, ${events.length} history rows, ${revisions.length} amendment snapshots (${amendZero.size} SPEC lines at price 0), ${recorded.length} recorded changes`);

    const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const linesBy = by(lines, 'doc_no');
    const eventsBy = by(events, 'so_doc_no');
    const revBy = by(revisions, 'so_doc_no');
    const recBy = by(recorded, 'so_doc_no');

    const plan = [];
    const tally = { orders: 0, withRows: 0, flagged: 0, createOk: 0, createBad: 0, endOk: 0, endBad: 0 };
    for (const h of headers.sort((a, b) => String(a.doc_no).localeCompare(String(b.doc_no)))) {
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
      // CHECK 2: at the window's end, the rebuilt goods are what the recorder saw first (else the header now).
      const recs = recBy.get(doc) ?? [];
      const wantEnd = recs.length > 0 ? { goods: n(recs[0].before_goods_sen), total: n(recs[0].before_total_sen) } : { goods: n(h.goods), total: n(h.local_total_sen) };
      const gotEnd = totalsAt(w.steps, toMs, w.nowTotals);
      const endOk = gotEnd.goods === wantEnd.goods;
      if (endOk) tally.endOk += 1; else tally.endBad += 1;
      // the recorder's own chain must not jump (a jump = a change it missed)
      const gaps = [];
      for (let i = 1; i < recs.length; i += 1) if (n(recs[i].before_goods_sen) !== n(recs[i - 1].after_goods_sen)) gaps.push(new Date(recs[i].changed_at).toISOString());
      const nowOk = w.nowTotals.goods === n(h.goods);

      const winProblems = w.problems.filter((p) => p.at >= fromMs);
      const unreliable = rows.some((r) => !r.reliable);
      const flagged = !endOk || (create && !create.ok) || winProblems.length > 0 || unreliable || gaps.length > 0 || !nowOk;
      if (flagged) tally.flagged += 1;
      if (rows.length > 0) tally.withRows += 1;
      const take = rows.length > 0 && !SKIP.has(doc) && (!flagged || INCLUDE.has(doc));
      plan.push({ doc, companyId: n(h.company_id), createdAt: new Date(h.created_at).getTime(), rows, take, flagged });

      if (rows.length > 0 || flagged) {
        const tag = flagged ? (take ? 'FLAGGED, TAKEN (INCLUDE_ORDERS)' : 'FLAGGED, left out') : (take ? 'ok' : 'left out (SKIP_ORDERS)');
        out(`${doc} [${tag}] opened ${myt(new Date(h.created_at).getTime())} · end check ${endOk ? 'ok' : `REBUILT ${rm(gotEnd.goods)} vs ${rm(wantEnd.goods)}`}${create ? ` · create ${create.ok ? 'ok' : `REBUILT ${rm(create.got)} vs ${rm(create.want)}`}` : ''}${nowOk ? '' : ` · lines now ${rm(w.nowTotals.goods)} vs header ${rm(h.goods)}`}${gaps.length ? ` · recorder gap at ${gaps.join(', ')}` : ''}`);
        for (const r of rows) out(`    ${myt(r.at)} ${r.source.padEnd(15)} ${r.kind.padEnd(9)} goods ${rm(r.beforeGoods)} → ${rm(r.afterGoods)} (${r.afterGoods >= r.beforeGoods ? '+' : ''}${rm(r.afterGoods - r.beforeGoods)})${r.why ? ` [${r.why}]` : ''} · ${r.actor ?? '-'}${r.reliable ? '' : ' · NOT RELIABLE'}`);
        for (const p of winProblems) out(`    problem ${myt(p.at)} ${p.action}: ${p.what}`);
      }
    }
    const take = plan.filter((p) => p.take);
    const rowsToWrite = take.flatMap((p) => p.rows.map((r) => ({ ...r, doc: p.doc, companyId: p.companyId })));
    const sum = (rs, f) => rs.filter(f).reduce((s, r) => s + (r.afterGoods - r.beforeGoods), 0);
    out(`SUMMARY orders ${tally.orders}, with rows ${tally.withRows}, flagged ${tally.flagged}; CREATE check ok ${tally.createOk} / bad ${tally.createBad}; end check ok ${tally.endOk} / bad ${tally.endBad}`);
    out(`SUMMARY to write: ${rowsToWrite.length} rows on ${take.length} orders — history up RM ${rm(sum(rowsToWrite, (r) => r.source === HISTORY && r.afterGoods > r.beforeGoods))}, down RM ${rm(sum(rowsToWrite, (r) => r.source === HISTORY && r.afterGoods < r.beforeGoods))}; ignored RM ${rm(sum(rowsToWrite, (r) => r.source === HISTORY_IGNORED))}`);
    out(`SUMMARY left out (flagged, with rows): ${plan.filter((p) => p.flagged && p.rows.length > 0 && !p.take).map((p) => p.doc).join(', ') || 'none'}`);

    const insertRows = async (tx) => {
      for (const r of rowsToWrite) {
        await tx`INSERT INTO scm.so_total_changes (company_id, so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by)
          VALUES (${r.companyId}, ${r.doc}, ${new Date(r.at).toISOString()}, ${r.beforeGoods}, ${r.afterGoods}, ${r.beforeTotal}, ${r.afterTotal}, ${r.source}, ${r.actor})`;
      }
    };
    const report = async (tx, basis, companyId) => {
      const sb = pgrestShim(tx, 'scm');
      const c = {
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => ({ from: '2026-10-01', to: '2026-10-31', basis })[k], path: '/api/scm/acc-events/commission' },
        get: (k) => (k === 'companyId' ? companyId : k === 'supabase' ? sb : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await eventCommissionHandler(c);
      if (res.status !== 200) throw new Error(`report HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return res.body;
    };
    const brief = (rep) => ({
      total: n(rep.totals?.totalSen), payable: n(rep.totals?.payableSen), adjustments: n(rep.totals?.adjustmentsSen),
      changed: (rep.changedOrders ?? []).length,
      changedEffect: (rep.changedOrders ?? []).reduce((s, o) => s + n(o.effectSen), 0),
      earlier: (rep.earlierOrders ?? []).length,
      earlierCommission: (rep.earlierOrders ?? []).reduce((s, o) => s + n(o.commissionSen), 0),
    });

    const ROLLBACK = new Error('rollback');
    if (!APPLY) {
      try {
        await sql.begin(async (tx) => {
          const beforeOf = {};
          for (const basis of ['fair', 'so_date']) {
            beforeOf[basis] = await report(tx, basis, 1);
            out(`REPORT Oct 1–31 by ${basis}, before: ${JSON.stringify(brief(beforeOf[basis]))}`);
          }
          await insertRows(tx);
          const partOne = (rep) => new Map(rep.fairs.flatMap((f) => f.sos.map((s) => [s.docNo, { ...s, fair: f.name }])));
          for (const basis of ['fair', 'so_date']) {
            const rep = await report(tx, basis, 1);
            out(`REPORT Oct 1–31 by ${basis}, after: ${JSON.stringify(brief(rep))}`);
            const b = partOne(beforeOf[basis]);
            const a = partOne(rep);
            for (const doc of new Set([...b.keys(), ...a.keys()])) {
              const x = b.get(doc); const y = a.get(doc);
              if ((x?.commissionSen ?? null) === (y?.commissionSen ?? null)) continue;
              out(`    ${basis} PART 1 MOVED ${doc} ${y?.fair ?? x?.fair}: commission ${rm(x?.commissionSen)} → ${rm(y?.commissionSen)} · goods ${rm(x?.goodsSen)} → ${rm(y?.goodsSen)} · reached ${x?.reachedOn ?? '-'} → ${y?.reachedOn ?? '-'} · total ${rm(x?.totalSen)} → ${rm(y?.totalSen)}`);
            }
            for (const o of (rep.changedOrders ?? []).filter((x) => x.fromHistory)) {
              out(`    ${basis} changed ${o.docNo} ${o.part} ${o.brand ?? '-'} · ${o.fairName ?? '-'} · original ${rm(o.originalSen)} latest ${rm(o.latestSen)} amended ${rm(o.amendedSen)} · ${o.reachedOn ? `effect ${rm(o.effectSen)}` : 'not yet 30%'} · ${o.salesperson ?? '-'}`);
            }
          }
          throw ROLLBACK;
        });
      } catch (e) { if (e !== ROLLBACK) throw e; }
      out('PLAN only — nothing was written (the report ran inside a transaction that was rolled back).');
      return;
    }

    if (already.n > 0) throw new Error(`${already.n} history rows already exist — the back-fill runs once (see RE-RUN in the header)`);
    await sql.begin(async (tx) => { await insertRows(tx); });
    const sql2 = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const [chk] = await sql2`SELECT count(*)::int AS n, coalesce(sum(after_goods_sen - before_goods_sen), 0)::bigint AS net FROM scm.so_total_changes WHERE source IN (${HISTORY}, ${HISTORY_IGNORED})`;
      const want = rowsToWrite.reduce((s, r) => s + (r.afterGoods - r.beforeGoods), 0);
      out(`APPLIED: ${chk.n} rows (planned ${rowsToWrite.length}), net goods RM ${rm(chk.net)} (planned RM ${rm(want)}) — ${chk.n === rowsToWrite.length && n(chk.net) === want ? 'MATCHES' : 'DOES NOT MATCH'}`);
    } finally { await sql2.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
