#!/usr/bin/env node
/* Bring every live Sales Order's STATUS back to what the app's own rules derive
   from its facts — for the rows those rules were never run against.

   WHY. The status column is a CACHE with three writers (the Processing-Date
   rule, the stock sweep, the delivery reconciler), and each only fires from the
   route it lives in. Measured on production 2026-10-13, 3,635 live orders:
     171  Submitted while carrying a Processing Date — the create and the DRAFT
          confirm wrote 'CONFIRMED' without asking (fixed in the same PR)
       5  In Production with NO date — AutoCount import carried an old proceed
          marker; the owner ruled 那 5 张退回 Submitted
       4  Ready to Ship although every line is on a shipped delivery order —
          DOs migrated on 2026-09-07 as DELIVERED, reconciler never ran
       3  Delivered with a line ADDED after the last delivery and never shipped
          — adding a line now re-opens the order (same PR); these predate it

   The judgement is lib/so-status-resync.mjs (pure, tested). This file reads the
   facts, prints them, and writes exactly what the app's writers would have
   written: the status, version+1, and the two audit rows the status PATCH and
   the reconciler both leave (mfg_so_status_changes + mfg_so_audit_log,
   source 'script').

   WHAT IT NEVER DOES: move a DRAFT / CANCELLED / CLOSED / INVOICED order, move
   READY_TO_SHIP on the date rules (that is the stock sweep's), demote an order
   that has shipped, or release a DELIVERED order whose shipped DO has no line
   rows (the reconciler's own refusal). An order under a live edit lease is
   skipped and named.

   MODE=plan (default) prints every row it would move and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", moves one order at a
   time with a compare-and-set on (doc_no, company_id, status, version), and
   re-reads every moved order on a FRESH connection to assert its status now
   IS the target and still agrees with the facts.

   RE-RUN: inert. Every target is recomputed live from the facts, and an order
   whose status already agrees with them is not a target — a second run after a
   successful apply plans 0 rows, and a run after the app's writers have moved
   an order sees it as settled. */
import postgres from 'postgres';
import { resyncTarget } from './lib/so-status-resync.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
/* Optional: restrict to one company. Unset = every company (the drift was in both). */
const CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* THE FACTS, one row per live order, read exactly the way the app's writers
   read them:
     fully_covered   every non-cancelled line's qty is met by lines on delivery
                     orders that COUNT (status not DRAFT / CANCELLED — LOADED
                     counts, owner 2026-08-22), net of non-cancelled returns.
                     Linked lines only (so_item_id); the reconciler's unlinked
                     attribution is deliberately not reproduced — it can only
                     make MORE orders fully covered, never fewer, so leaving it
                     out under-moves rather than over-moves.
     late_uncovered  uncovered lines created AFTER the last counting delivery
                     order — goods added once the order already read Delivered.
     empty_live_dos  counting delivery orders with no line rows at all — the
                     reconciler's positive-evidence guard.
     has_downstream  a non-cancelled DO or sales invoice exists. */
const factsSql = (client, co) => client.unsafe(`
  WITH live AS (
    SELECT s.doc_no, s.company_id, s.status, s.version,
           s.processing_date::text AS processing_date
      FROM scm.mfg_sales_orders s
     WHERE s.status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED')
       AND ($1::int IS NULL OR s.company_id = $1::int)
  ),
  counting_do AS (
    SELECT d.id, d.so_doc_no, d.created_at
      FROM scm.delivery_orders d JOIN live ON live.doc_no = d.so_doc_no
     WHERE d.status NOT IN ('DRAFT','CANCELLED')
  ),
  covered AS (
    SELECT di.so_item_id, SUM(di.qty) AS qty
      FROM scm.delivery_order_items di JOIN counting_do cd ON cd.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
     GROUP BY di.so_item_id
  ),
  returned AS (
    SELECT di.so_item_id, SUM(ri.qty_returned) AS qty
      FROM scm.delivery_return_items ri
      JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id AND r.status <> 'CANCELLED'
      JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
      JOIN counting_do cd ON cd.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
     GROUP BY di.so_item_id
  ),
  lines AS (
    SELECT i.doc_no, i.qty, i.created_at,
           COALESCE(c.qty, 0) - COALESCE(r.qty, 0) AS net,
           (SELECT MAX(cd.created_at) FROM counting_do cd WHERE cd.so_doc_no = i.doc_no) AS last_do_at
      FROM scm.mfg_sales_order_items i JOIN live ON live.doc_no = i.doc_no
      LEFT JOIN covered c ON c.so_item_id = i.id
      LEFT JOIN returned r ON r.so_item_id = i.id
     WHERE i.cancelled = false
  ),
  per_doc AS (
    SELECT doc_no,
           COUNT(*)::int AS live_lines,
           BOOL_AND(net >= qty) AS all_covered,
           COUNT(*) FILTER (WHERE net < qty AND last_do_at IS NOT NULL AND created_at > last_do_at)::int AS late_uncovered
      FROM lines GROUP BY doc_no
  ),
  empties AS (
    SELECT cd.so_doc_no, COUNT(*)::int AS n
      FROM counting_do cd
     WHERE NOT EXISTS (SELECT 1 FROM scm.delivery_order_items di WHERE di.delivery_order_id = cd.id)
     GROUP BY cd.so_doc_no
  )
  SELECT live.doc_no, live.company_id, live.status, live.version, live.processing_date,
         COALESCE(pd.live_lines, 0) AS live_lines,
         (COALESCE(pd.live_lines, 0) > 0 AND COALESCE(pd.all_covered, false)) AS fully_covered,
         COALESCE(pd.late_uncovered, 0) AS late_uncovered,
         COALESCE(e.n, 0) AS empty_live_dos,
         (EXISTS (SELECT 1 FROM scm.delivery_orders d WHERE d.so_doc_no = live.doc_no AND d.status <> 'CANCELLED')
          OR EXISTS (SELECT 1 FROM scm.sales_invoices si WHERE si.so_doc_no = live.doc_no AND si.status <> 'CANCELLED')) AS has_downstream,
         (live.doc_no IN (SELECT s2.doc_no FROM scm.mfg_sales_orders s2
                           WHERE s2.edit_lease_token IS NOT NULL AND s2.edit_lease_expires_at > now())) AS leased
    FROM live
    LEFT JOIN per_doc pd ON pd.doc_no = live.doc_no
    LEFT JOIN empties e ON e.so_doc_no = live.doc_no
   ORDER BY live.company_id, live.doc_no`, [co]);

const judge = (r) => resyncTarget({
  status: r.status,
  processingDate: r.processing_date,
  fullyCovered: r.fully_covered,
  lateUncoveredLines: r.late_uncovered,
  emptyLiveDeliveries: r.empty_live_dos,
  hasDownstream: r.has_downstream,
});

const NOTE_BY_RULE = {
  'delivered-by-do': 'Script: Delivery Order fully covers this SO (reconciler never ran for a migrated DO)',
  'reopened-by-late-line': 'Script: a line added after delivery has not shipped — released to re-ship',
  'date-means-in-production': 'Script: Processing Date on the order means it is proceeded',
  'no-date-means-submitted': 'Script: no Processing Date — back to Submitted (owner 2026-10-13)',
};

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO ?? 'all'}`);

  const rows = await factsSql(sql, CO);
  note(`live orders read: ${rows.length}`);

  const moves = [], refused = [], leased = [];
  for (const r of rows) {
    const v = judge(r);
    if (!v) continue;
    if ('refused' in v) { refused.push({ ...r, why: v.refused }); continue; }
    if (r.leased) { leased.push({ ...r, to: v.to }); continue; }
    moves.push({ ...r, to: v.to, rule: v.rule });
  }

  note(`\n=== WHAT WOULD MOVE, BY RULE ===`);
  const byRule = new Map();
  for (const m of moves) byRule.set(m.rule, (byRule.get(m.rule) ?? 0) + 1);
  for (const [rule, n] of byRule) note(`  ${rule.padEnd(26)} ${n}`);
  note(`  total: ${moves.length}   refused: ${refused.length}   under edit lease (skipped): ${leased.length}`);

  note(`\n=== EVERY ROW ===`);
  for (const m of moves) {
    const fact = m.rule === 'delivered-by-do' ? `${m.live_lines} line(s) all on shipped DOs`
      : m.rule === 'reopened-by-late-line' ? `${m.late_uncovered} line(s) added after delivery, not shipped`
      : m.rule === 'date-means-in-production' ? `processing_date=${m.processing_date}`
      : 'processing_date=null, nothing downstream';
    note(`  co${m.company_id} ${m.doc_no.padEnd(18)} ${m.status.padEnd(14)} -> ${m.to.padEnd(14)} ${fact}`);
  }
  for (const r of refused) bad(`  co${r.company_id} ${r.doc_no.padEnd(18)} ${r.status.padEnd(14)} REFUSED — ${r.why}`);
  for (const l of leased) note(`  co${l.company_id} ${l.doc_no.padEnd(18)} ${l.status.padEnd(14)} -> ${l.to.padEnd(14)} SKIPPED — someone holds the edit lease; re-run later`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== MOVING ${moves.length} ORDER(S) ===`);
  const written = [];
  for (const m of moves) {
    /* Compare-and-set on everything the plan was judged against. A row that
       moved under us (a DO delivered, a date cleared) matches 0 rows and is
       named rather than overwritten; the next run re-judges it. */
    const back = await sql.unsafe(
      `UPDATE scm.mfg_sales_orders
          SET status = $3, version = version + 1, updated_at = now()
        WHERE doc_no = $1 AND company_id = $2 AND status = $4 AND version = $5
          AND (edit_lease_token IS NULL OR edit_lease_expires_at < now())
        RETURNING doc_no, version`,
      [m.doc_no, m.company_id, m.to, m.status, m.version]);
    if (back.length === 0) { bad(`  SKIP ${m.doc_no} — row changed since the plan (status/version/lease); re-run`); continue; }
    const noteText = NOTE_BY_RULE[m.rule];
    await sql.unsafe(
      `INSERT INTO scm.mfg_so_status_changes (company_id, doc_no, from_status, to_status, changed_by, notes)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [m.company_id, m.doc_no, m.status, m.to, noteText]);
    /* $::text::jsonb — the parameter arrives as TEXT and is PARSED; binding the
       serialized string straight to jsonb stores a json string
       (docs/jsonb-double-encoding-coe.md). */
    await sql.unsafe(
      `INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note)
       VALUES ($1, $2, 'UPDATE_STATUS', NULL, 'resync-so-status-to-rules', $3::text::jsonb, $4, 'script', $5)`,
      [m.doc_no, m.company_id, JSON.stringify([{ field: 'status', from: m.status, to: m.to }]), m.to, noteText]);
    written.push(m);
    note(`  OK   ${m.doc_no} ${m.status} -> ${m.to} (version ${back[0].version})`);
  }
  note(`  moved: ${written.length} of ${moves.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    /* Two questions, both about VALUES: is each moved order now AT its target,
       and — re-judged from the live facts — does the status now agree with them
       (a target the judge still wants to move is a write that did not take). */
    const after = await factsSql(check, CO);
    const byDoc = new Map(after.map((r) => [r.doc_no, r]));
    let wrong = 0;
    for (const m of written) {
      const now = byDoc.get(m.doc_no);
      const status = now?.status;
      const again = now ? judge(now) : null;
      const ok = typeof status === 'string' && status === m.to && (again === null || 'refused' in again);
      if (!ok) { wrong += 1; bad(`  ${m.doc_no}: expected ${m.to}, reads ${status ?? '(missing)'}${again && 'to' in again ? `, judge still wants ${again.to}` : ''}`); }
    }
    const stillWanted = after.map((r) => ({ r, v: judge(r) })).filter(({ v }) => v && 'to' in v);
    note(`  moved orders at their target: ${written.length - wrong} of ${written.length}`);
    note(`  orders the rules still want to move: ${stillWanted.length} (expected 0, plus any skipped above)`);
    for (const { r, v } of stillWanted.slice(0, 20)) note(`    co${r.company_id} ${r.doc_no} ${r.status} -> ${v.to}`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
