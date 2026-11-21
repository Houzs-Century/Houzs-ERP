/* The database half of repair-so-margin-fields.mjs: read a company's orders,
   plan each with lib/so-margin.mjs, and write one chunk inside a transaction
   the caller opened. Kept here so tests-pg can execute the same SQL. */
import { planOrderMargins } from './so-margin.mjs';

export const MARGIN_REPAIR_SOURCE = 'script:repair-so-margin-fields';
const AUDIT_NOTE = 'Margin fields put where a save writes them: line margin = line total - line cost; revenue = order total; margin = revenue - cost; margin % = margin / revenue. No cost or price changed.';

/** Every header and line of one company, as the plan reads them. */
export async function readOrderMargins(db, co) {
  const headers = await db`
    SELECT doc_no, so_date::text AS so_date, status::text AS status, local_total_sen, total_revenue_sen, total_cost_sen,
           total_margin_sen, margin_pct_basis, delivery_fee_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${co} ORDER BY doc_no`;
  const lines = await db`
    SELECT id::text AS id, doc_no, item_code, total_sen, line_cost_sen, line_margin_sen, cancelled
      FROM scm.mfg_sales_order_items WHERE company_id = ${co} ORDER BY doc_no, id`;
  return { headers, linesByDoc: Map.groupBy(lines, (l) => l.doc_no) };
}

/**
 * Every order that needs a change, every one refused, and how many orders in a
 * left-alone status (DRAFT, CANCELLED) are off but not touched.
 */
export function planCompanyMargins({ headers, linesByDoc }, leftAlone) {
  const todo = [], refused = [];
  let skippedOff = 0;
  for (const h of headers) {
    const lines = linesByDoc.get(h.doc_no) ?? [];
    const plan = planOrderMargins(h, lines);
    if (leftAlone.has(String(h.status))) {
      if (plan.status === 'refused' || plan.header || plan.lines.length) skippedOff++;
      continue;
    }
    if (plan.status === 'refused') { refused.push({ doc: h.doc_no, why: plan.why }); continue; }
    if (!plan.header && plan.lines.length === 0) continue;
    todo.push({ h, plan, codeOf: new Map(lines.map((l) => [l.id, l.item_code])) });
  }
  return { todo, refused, leftAlone: skippedOff };
}

const complete = (o, heads, lines) => (!o.plan.header || heads.has(o.h.doc_no)) && o.plan.lines.every((l) => lines.has(l.id));

/**
 * Write one chunk of planned orders on `tx` (a transaction the caller holds).
 * Every UPDATE is guarded on the values the plan read, so a row edited since is
 * left alone. One audit row per order that changed. With lane 'background',
 * the portal queue rows THIS transaction created move to the reconcile lane.
 */
export async function writeMarginChunk(tx, co, chunk, lane) {
  const lineRows = chunk.flatMap((o) => o.plan.lines);
  const wroteLines = new Set();
  if (lineRows.length) {
    const hit = await tx`
      UPDATE scm.mfg_sales_order_items AS t SET line_margin_sen = d.to_m
        FROM unnest(${lineRows.map((l) => l.id)}::uuid[], ${lineRows.map((l) => l.from)}::int[], ${lineRows.map((l) => l.to)}::int[]) AS d(id, from_m, to_m)
       WHERE t.id = d.id AND t.company_id = ${co} AND NOT t.cancelled
         AND t.line_margin_sen = d.from_m AND t.total_sen - t.line_cost_sen = d.to_m
      RETURNING t.id::text AS id`;
    for (const r of hit) wroteLines.add(r.id);
  }

  // Revenue, margin and basis together: naming total_margin_sen wakes the
  // portal's trigger, so a header off only in its basis is re-sent as well.
  const wroteHeads = new Set();
  const heads = chunk.filter((o) => o.plan.header);
  if (heads.length) {
    const g = (f) => heads.map(f);
    const hit = await tx`
      UPDATE scm.mfg_sales_orders AS t SET total_revenue_sen = d.rev, total_margin_sen = d.mar, margin_pct_basis = d.pct
        FROM unnest(${g((o) => o.h.doc_no)}::text[], ${g((o) => Number(o.h.local_total_sen))}::int[], ${g((o) => Number(o.h.total_cost_sen))}::int[],
                    ${g((o) => Number(o.h.total_revenue_sen))}::int[], ${g((o) => Number(o.h.total_margin_sen))}::int[], ${g((o) => Number(o.h.margin_pct_basis))}::int[],
                    ${g((o) => o.plan.header.total_revenue_sen)}::int[], ${g((o) => o.plan.header.total_margin_sen)}::int[], ${g((o) => o.plan.header.margin_pct_basis)}::int[])
             AS d(doc_no, lt, cost, old_rev, old_mar, old_pct, rev, mar, pct)
       WHERE t.doc_no = d.doc_no AND t.company_id = ${co} AND t.local_total_sen = d.lt AND t.total_cost_sen = d.cost
         AND t.total_revenue_sen = d.old_rev AND t.total_margin_sen = d.old_mar AND t.margin_pct_basis = d.old_pct
      RETURNING t.doc_no`;
    for (const r of hit) wroteHeads.add(r.doc_no);
  }

  const audited = [];
  for (const o of chunk) {
    const fc = [];
    if (wroteHeads.has(o.h.doc_no)) {
      for (const f of ['total_revenue_sen', 'total_margin_sen', 'margin_pct_basis']) {
        if (o.plan.header[f] !== Number(o.h[f])) fc.push({ field: f, from: Number(o.h[f]), to: o.plan.header[f] });
      }
    }
    for (const l of o.plan.lines) {
      if (wroteLines.has(l.id)) fc.push({ field: `line_${o.codeOf.get(l.id) ?? ''}_line_margin_sen`, from: l.from, to: l.to, lineId: l.id });
    }
    if (fc.length) audited.push({ o, fc, complete: complete(o, wroteHeads, wroteLines) });
  }
  if (audited.length) {
    // text -> jsonb PARSES each array; binding a JSON string to a jsonb parameter
    // would store a jsonb string instead (docs/jsonb-double-encoding-coe.md).
    await tx`
      INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
      SELECT d.doc_no, ${co}, 'UPDATE_DETAILS', 'System (margin repair)', d.fc::jsonb, d.status, ${MARGIN_REPAIR_SOURCE}, ${AUDIT_NOTE}
        FROM unnest(${audited.map((a) => a.o.h.doc_no)}::text[], ${audited.map((a) => JSON.stringify(a.fc))}::text[], ${audited.map((a) => String(a.o.h.status))}::text[])
             AS d(doc_no, fc, status)`;
  }

  // company-scope: the outbox has no company column; its rows are addressed by
  // the doc numbers this chunk just wrote, and only rows this transaction made
  // (created_at = now(), the transaction's own start). A row a live save queued
  // earlier keeps its lane.
  let laned = 0;
  if (lane === 'background' && audited.length) {
    const moved = await tx`
      UPDATE scm.venture_portal_outbox SET op = 'RECONCILE'
       WHERE status = 'pending' AND created_at = now() AND op <> 'RECONCILE'
         AND doc_no = ANY(${audited.map((a) => a.o.h.doc_no)}::text[])
      RETURNING doc_no`;
    laned = moved.length;
  }
  return { audited, laned, lines: wroteLines.size, heads: wroteHeads.size };
}
