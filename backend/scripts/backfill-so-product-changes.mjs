#!/usr/bin/env node
/* Put the product changes of the months before the record went live into
   scm.so_product_changes, so Finance's Product changes reports read them too.

   WHY. The record (lib/so-product-change-record.ts) is written when a change is
   saved or approved, from the day it went live. The owner asked for the months
   before it as well (2026-11-23: 「补，从 9 月开始」). Those changes are rebuilt
   from each order's own history: its lines as they are now, walked back through
   scm.mfg_so_audit_log and the line snapshots scm.so_revisions keeps before each
   approved amendment (lib/so-product-change-history.mjs, the 2026-11-23
   analysis carried over line for line).

   WHAT IT WRITES. One row per event, as the live record writes it: DIRECT = one
   order's direct edits of one Malaysia day (window_key = the day), AMENDMENT =
   one approved submission (window_key = its first half's id). Product lines
   only; the costs the order recorded, never a re-cost. Each row says
   rebuilt = true, and cost_estimated = true when a changed line's cost was not
   in the history and was taken from the product's own cost. Left out, and
   counted: an event whose cost cannot be told or whose walk lost the thread, a
   quantity change that moved no selling (a typo fix), and one that moved neither
   selling nor cost. Orders CANCELLED or DRAFT are not read. Nothing on the
   orders themselves is read for writing or written.

   FROM (default 2026-09-01) is the first change day to rebuild; COMPANIES
   (default 1,2) the companies. A window the live record already holds stays
   as the live record wrote it (the insert skips it).

   MODE=plan (default) prints what it would write, as counts only (the Actions
   log of this public repository is public: no order number and no amount is
   printed), and writes nothing. MODE=apply needs
   CONFIRM="REBUILD PRODUCT CHANGES": it inserts in one transaction, then
   re-reads on a FRESH connection that every rebuilt row has the shape the
   reports read (a bucket, at least one change type, its lines as a json array).

   REVERSAL: DELETE FROM scm.so_product_changes WHERE rebuilt; (the live rows
   are never rebuilt).

   RE-RUN: inert. Every row goes in under its window key with ON CONFLICT DO
   NOTHING, so a second run inserts nothing. */
import postgres from 'postgres';
import { rebuildRecordRows } from './lib/so-product-change-history.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REBUILD PRODUCT CHANGES';
const FROM = process.env.FROM || '2026-09-01';
const COMPANIES = String(process.env.COMPANIES || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!/^\d{4}-\d\d-\d\d$/.test(FROM)) { bad(`FROM must be YYYY-MM-DD, got "${FROM}"`); process.exit(2); }
if (COMPANIES.length === 0) { bad('COMPANIES names no company'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The orders a product change can have touched since FROM: a line written by a
   person or the automation after the opening day, or an amendment approved after
   it. Their whole history is read: the walk starts from today's lines. */
async function readHistory(db) {
  const fromTs = `${FROM}T00:00:00+08:00`;
  const scope = db`
    with o as (
      select doc_no, company_id, status::text st, so_date, created_at,
             (created_at at time zone 'Asia/Kuala_Lumpur')::date open_day
        from scm.mfg_sales_orders
       where company_id = any(${COMPANIES}::bigint[]) and status::text not in ('CANCELLED', 'DRAFT')
    ), dd as (
      select distinct l.company_id, l.so_doc_no doc_no
        from scm.mfg_so_audit_log l join o on o.doc_no = l.so_doc_no and o.company_id = l.company_id
       where l.action in ('UPDATE_LINE', 'ADD_LINE', 'DELETE_LINE') and l.source in ('web', 'automation')
         and l.created_at >= ${fromTs}::timestamptz
         and (l.created_at at time zone 'Asia/Kuala_Lumpur')::date > o.open_day
         and (l.action <> 'UPDATE_LINE' or exists (
               select 1 from jsonb_array_elements(case when jsonb_typeof(l.field_changes) = 'array' then l.field_changes else '[]'::jsonb end) fc
                where fc->>'field' in ('qty', 'spec', 'sofaBuild') or (fc->>'field' = 'itemCode' and fc ? 'from')))
    ), am as (
      select distinct a.company_id, a.so_doc_no doc_no
        from scm.so_amendments a join o on o.doc_no = a.so_doc_no and o.company_id = a.company_id
       where a.status::text in ('SO_APPROVED', 'PO_APPROVED', 'SENT')
         and a.so_approved_at >= ${fromTs}::timestamptz
         and (a.so_approved_at at time zone 'Asia/Kuala_Lumpur')::date > o.open_day
    )
    select * from dd union select * from am`;

  const orders = await db`
    with s as (${scope})
    select json_build_object('d', o.doc_no, 'c', o.company_id, 'st', o.status::text, 'sd', o.so_date::text, 'ca', o.created_at,
             'od', ((o.created_at at time zone 'Asia/Kuala_Lumpur')::date)::text, 'ac', o.linked_ac_docno) j
      from scm.mfg_sales_orders o join s on s.doc_no = o.doc_no and s.company_id = o.company_id
     where o.status::text not in ('CANCELLED', 'DRAFT')`;
  const lines = await db`
    with s as (${scope})
    select json_build_object('id', i.id, 'd', i.doc_no, 'c', i.company_id, 'ln', i.line_no, 'ic', i.item_code, 'g', i.item_group, 'q', i.qty,
             'u', i.unit_price_sen, 'ds', i.discount_sen, 't', i.total_sen, 'uc', i.unit_cost_sen, 'lc', i.line_cost_sen, 'x', i.cancelled,
             'ca', i.created_at, 'h', i.variants->>'seatHeight', 'bk', i.variants->>'buildKey', 'fc', i.variants->>'fabricCode') j
      from scm.mfg_sales_order_items i join s on s.doc_no = i.doc_no and s.company_id = i.company_id
     order by i.doc_no, i.line_no`;
  const audit = await db`
    with s as (${scope})
    select json_build_object('id', l.id, 'd', l.so_doc_no, 'c', l.company_id, 'a', l.action, 's', l.source, 'at', l.created_at, 'by', l.actor_name_snapshot,
             'f', (select jsonb_agg(fc) from jsonb_array_elements(l.field_changes) fc
                    where fc->>'field' in ('itemCode', 'qty', 'unitPriceSen', 'discountSen', 'cancelled', 'itemGroup', 'unitCostSen', 'spec', 'sofaBuild',
                                           'totalSen', 'deliveryFeeSen', 'unitPriceCenti', 'totalCenti', 'unitCostCenti', 'deliveryFeeCenti',
                                           'localTotalSen', 'localTotalCenti', 'lineCount', 'amendment_id', 'revision', 'lines_applied')
                       or fc->>'field' like 'line\_%')) j
      from scm.mfg_so_audit_log l join s on s.doc_no = l.so_doc_no and s.company_id = l.company_id
     where l.action in ('CREATE', 'UPDATE_LINE', 'ADD_LINE', 'DELETE_LINE', 'AMENDMENT_SO_APPROVED') and coalesce(l.source, '') <> 'auto-allocation'
       and jsonb_typeof(l.field_changes) = 'array'
       and (l.action <> 'UPDATE_LINE' or exists (
             select 1 from jsonb_array_elements(l.field_changes) fc
              where fc->>'field' in ('qty', 'unitPriceSen', 'discountSen', 'cancelled', 'itemGroup', 'unitCostSen', 'spec', 'sofaBuild', 'totalSen',
                                     'deliveryFeeSen', 'unitPriceCenti', 'totalCenti', 'unitCostCenti', 'deliveryFeeCenti')
                 or (fc->>'field' = 'itemCode' and fc ? 'from') or fc->>'field' like 'line\_%'))
     order by l.so_doc_no, l.created_at`;
  const revisions = await db`
    with s as (${scope})
    select json_build_object('d', r.so_doc_no, 'c', r.company_id, 'rev', r.revision, 'amd', r.amendment_id, 'at', r.created_at,
             'L', (select json_agg(json_build_object('id', x->>'id', 'ln', x->'line_no', 'ic', x->>'item_code', 'g', x->>'item_group', 'q', x->'qty',
                       'u', x->'unit_price_sen', 'ds', x->'discount_sen', 't', x->'total_sen', 'uc', x->'unit_cost_sen', 'lc', x->'line_cost_sen',
                       'x', x->'cancelled', 'ca', x->>'created_at', 'h', x->'variants'->>'seatHeight', 'bk', x->'variants'->>'buildKey',
                       'fc', x->'variants'->>'fabricCode'))
                    from jsonb_array_elements(case when jsonb_typeof(r.snapshot->'lines') = 'array' then r.snapshot->'lines' else '[]'::jsonb end) x)) j
      from scm.so_revisions r join s on s.doc_no = r.so_doc_no and s.company_id = r.company_id
     where r.amendment_id is not null`;
  const amendments = await db`
    with s as (${scope})
    select json_build_object('id', a.id, 'd', a.so_doc_no, 'c', a.company_id, 'no', a.amendment_no, 'lane', a.lane, 'ap', a.so_approved_at,
             'cr', a.created_at, 'rb', a.requested_by, 'reason', a.reason,
             'L', (select json_agg(json_build_object('ct', l.change_type, 'sid', l.sales_order_item_id, 'nic', l.new_item_code, 'nq', l.new_qty,
                       'nh', l.new_variants->>'seatHeight', 'oic', l.old_snapshot->>'itemCode', 'oq', l.old_snapshot->'qty',
                       'og', l.old_snapshot->>'itemGroup', 'oh', l.old_snapshot->'variants'->>'seatHeight'))
                    from scm.so_amendment_lines l where l.amendment_id = a.id)) j
      from scm.so_amendments a join s on s.doc_no = a.so_doc_no and s.company_id = a.company_id
     where a.status::text in ('SO_APPROVED', 'PO_APPROVED', 'SENT')`;
  const products = await db`
    select company_id, code, category, base_price_sen, cost_price_sen, price1_sen, seat_height_prices
      from scm.mfg_products where company_id = any(${COMPANIES}::bigint[])`;
  const history = await db`
    select company_id, item_code, effective_from::text effective_from, created_at, base_price_sen, price1_sen, seat_height_prices
      from scm.mfg_product_cost_history where company_id = any(${COMPANIES}::bigint[])`;
  const requesters = [...new Set(amendments.map((r) => r.j.rb).filter(Boolean))];
  const staff = requesters.length
    ? await db`select id::text id, name from scm.staff where id::text = any(${requesters}::text[])` : [];
  const live = await db`
    select company_id, so_doc_no, route, window_key from scm.so_product_changes where company_id = any(${COMPANIES}::bigint[])`;
  return {
    orders: orders.map((r) => r.j), lines: lines.map((r) => r.j), audit: audit.map((r) => r.j),
    revisions: revisions.map((r) => r.j), amendments: amendments.map((r) => r.j),
    products, history, staff, live,
  };
}

const tally = (rows, f) => {
  const m = new Map();
  for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, n]) => `${k}: ${n}`).join(', ');
};

/** What every rebuilt row must look like for the reports to read it. */
async function shapeProblems(db) {
  const [r] = await db`
    select count(*) filter (where bucket is null or bucket not in ('SELLING', 'COST_ONLY'))::int bad_bucket,
           count(*) filter (where coalesce(cardinality(change_types), 0) = 0)::int no_types,
           count(*) filter (where jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) = 0)::int bad_lines,
           count(*) filter (where jsonb_typeof(before_lines) <> 'array')::int bad_before,
           count(*) filter (where change_day < ${FROM}::date)::int before_from
      from scm.so_product_changes where rebuilt and company_id = any(${COMPANIES}::bigint[])`;
  return Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`);
}

try {
  note(`Rebuilding product changes from ${FROM}, companies ${COMPANIES.join(', ')}`);
  const h = await readHistory(sql);
  const { rows, left } = rebuildRecordRows(h, FROM);
  note(`orders read: ${h.orders.length}; rows to write: ${rows.length}`);
  note(`by company and month: ${tally(rows, (r) => `${r.company_id} ${r.change_day.slice(0, 7)}`) || 'none'}`);
  note(`by company and kind: ${tally(rows, (r) => `${r.company_id} ${r.bucket}`) || 'none'}`);
  note(`by company and route: ${tally(rows, (r) => `${r.company_id} ${r.route}`) || 'none'}`);
  note(`cost estimated: ${rows.filter((r) => r.cost_estimated).length}; on imported orders: ${rows.filter((r) => r.imported).length}`);
  note(`left out: cost not told or walk lost ${left.notJudged}, qty typo or no product change ${left.typoOrNoType}, nothing moved ${left.noMove}, already in the live record ${left.live}; walk steps not placed ${left.walkProblems}`);

  if (!APPLY) {
    note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    process.exit(0);
  }

  let written = 0;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const got = await tx`
        insert into scm.so_product_changes (company_id, so_doc_no, route, window_key, change_day, changed_at, changed_by, approved_by, amendment_nos,
          change_types, bucket, selling_before_sen, selling_after_sen, cost_before_sen, cost_after_sen, lines, before_lines, rebuilt, cost_estimated)
        values (${r.company_id}, ${r.so_doc_no}, ${r.route}, ${r.window_key}, ${r.change_day}::date, ${r.changed_at}::timestamptz,
          ${r.changed_by}::text[], ${r.approved_by}::text[], ${r.amendment_nos}::text[], ${r.change_types}::text[], ${r.bucket},
          ${r.selling_before_sen}, ${r.selling_after_sen}, ${r.cost_before_sen}, ${r.cost_after_sen},
          ${sql.json(r.lines)}, ${sql.json(r.before_lines)}, true, ${r.cost_estimated})
        on conflict (company_id, so_doc_no, route, window_key) do nothing
        returning id`;
      written += got.length;
    }
  });
  note(`written: ${written} of ${rows.length} (the rest were already recorded)`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const problems = await shapeProblems(check);
    if (problems.length) { bad(`rebuilt rows of the wrong shape: ${problems.join(', ')}`); process.exitCode = 1; }
    else note('fresh re-read: every rebuilt row has a bucket, a change type and its lines.');
    const again = rebuildRecordRows(await readHistory(check), FROM);
    if (again.rows.length) { bad(`a second plan still finds ${again.rows.length} row(s) to write`); process.exitCode = 1; }
    else note('fresh re-read: a second run would write nothing.');
  } finally {
    await check.end({ timeout: 5 });
  }
} catch (err) {
  bad(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
}
