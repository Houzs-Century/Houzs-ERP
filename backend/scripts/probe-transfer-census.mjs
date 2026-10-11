#!/usr/bin/env node
/* Read-only. Three questions about document transfer, measured on production.
 *
 * 1. WHAT THE GRN PICKER'S 500-ROW CAP WAS HIDING (owner, 2026-08-17). He opened
 *    "Pick PO lines for this GRN" scoped to one PO, got zero rows, and was told
 *    "every line has been received". The PO had never been received.
 *    `GET /grns/outstanding-po-items` ran `.limit(500)` on the RAW
 *    `purchase_order_items` select and applied the parent-status and
 *    remaining-qty filters AFTERWARDS, in JavaScript, over rows ordered by
 *    `purchase_order_id DESC`. This replays that query and counts the
 *    outstanding lines — and the whole POs — it could not see.
 *
 * 2. WHAT STATUSES LIVE POs CARRY. The picker only shows lines whose parent is
 *    SUBMITTED or PARTIALLY_RECEIVED. `purchase-doc-vocab.ts` says the set is
 *    DRAFT / SUBMITTED / PARTIALLY_RECEIVED / RECEIVED / CANCELLED, but the
 *    AutoCount import writes PO rows too, so what is actually there is a
 *    question about production. Every excluded status is marked.
 *
 * 3. THE DOUBLE-TRANSFER CENSUS. The owner's rule: every transfer is once-only,
 *    per LINE, except the Purchase Order (which follows MRP's shortage and is
 *    deliberately repeatable). A MISSING guard is the direction he has not
 *    noticed: the same line transferred twice, producing duplicate downstream
 *    documents. For each of ten pairs this counts source lines whose downstream
 *    total EXCEEDS the source quantity, plus the destination lines whose binding
 *    is NULL — which no quantity ceiling in this system can see at all
 *    (`convert-ceilings.test.ts` names that exposure twice and it has never been
 *    counted).
 *
 * WRITES NOTHING. One statement per question, no DDL, no transaction.
 *
 * RE-RUN: identical output for identical data. There is no state, no marker row
 * and no side effect, so a second run is free and tells you the same thing.
 *
 * Env:
 *   DATABASE_URL  required.
 *   COMPANY       optional; default is EVERY company in public.companies.
 *   PO_DOC_NO     optional; a PO number to dump line by line (the screenshot).
 *   WINDOW        optional; the cap to replay. Default 500, the real one.
 */
import postgres from 'postgres';
import * as Q from './lib/transfer-census-queries.mjs';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);
const WINDOW = Number(process.env.WINDOW || 500);
const ROW_CAP = 15;

/** Verify every identifier a pair needs before running a census over it.
 *  A pair whose columns are absent is REPORTED ABSENT — never counted as zero.
 *  `scm`'s DDL is not in this repo, so this is the only honest way to ask. */
async function missingIdentifiers(pair) {
  const missing = [];
  for (const { table, column } of Q.pairIdentifiers(pair)) {
    const [r] = column === null
      ? await Q.hasTable(sql, 'scm', table)
      : await Q.hasColumn(sql, 'scm', table, column);
    if (r.n === 0) missing.push(column === null ? `scm.${table}` : `scm.${table}.${column}`);
  }
  return [...new Set(missing)];
}

async function main() {
  const cos = await Q.companies(sql);
  const only = process.env.COMPANY ? Number(process.env.COMPANY) : null;
  const targets = only ? cos.filter((c) => c.id === only) : cos;
  if (targets.length === 0) {
    warn(`COMPANY=${process.env.COMPANY} matches no row in public.companies. Nothing measured.`);
    return;
  }
  note(`companies measured: ${targets.map((c) => `${c.id}=${c.code}`).join(', ')}`);
  note(`replaying the GRN picker's window at LIMIT ${WINDOW}`);

  /* Resolve the pair table ONCE — schema shape does not vary by company, and
     asking per company would multiply the round trips for no new fact. */
  const pairState = [];
  for (const pair of Q.PAIRS) {
    pairState.push({ pair, missing: await missingIdentifiers(pair) });
  }
  const absent = pairState.filter((p) => p.missing.length > 0);
  if (absent.length > 0) {
    warn(`${absent.length} of ${Q.PAIRS.length} pairs cannot be measured — identifiers absent:`);
    for (const { pair, missing } of absent) warn(`  ${pair.key}: ${missing.join(', ')}`);
  }

  for (const co of targets) {
    note(`\n${'='.repeat(66)}`);
    note(`COMPANY ${co.id} — ${co.code} (${co.name})${co.is_active ? '' : '  [INACTIVE]'}`);
    note('='.repeat(66));

    // ── 1. The window ──────────────────────────────────────────────────────
    const [w] = await Q.oldWindowBlastRadius(sql, co.id, WINDOW);
    note(`\n--- 1. the GRN picker's old ${WINDOW}-row window ---`);
    note(`  PO lines in this company (any status): ${w.po_lines_total}`);
    note(`  OUTSTANDING lines (live status, qty > received): ${w.outstanding_total}`);
    note(`  ... of which the picker could SEE:  ${w.outstanding_in_window}`);
    note(`  ... of which the picker HID:        ${w.outstanding_hidden}`);
    note(`  POs holding outstanding lines: ${w.pos_with_outstanding}`);
    note(`  POs COMPLETELY invisible:      ${w.pos_hidden}`);
    if (Number(w.pos_hidden) > 0) {
      warn(`  company ${co.id}: ${w.pos_hidden} PO(s) had outstanding lines and showed ZERO rows.`);
      warn('  Each one told the operator "every line has been received". This is the report.');
    } else if (Number(w.outstanding_total) === 0) {
      note('  nothing outstanding here, so the cap cost this company nothing TODAY.');
      note('  That is a statement about now, not about the cap being safe.');
    } else {
      note(`  the cap fit this company's ${w.outstanding_total} outstanding lines.`);
    }

    // ── 2. The status histogram ────────────────────────────────────────────
    const hist = await Q.poStatusHistogram(sql, co.id);
    note(`\n--- 2. statuses of POs holding unreceived lines ---`);
    if (hist.length === 0) note('  none.');
    for (const r of hist) {
      const mark = r.excluded_by_picker ? '  <- EXCLUDED by the picker' : '';
      note(`  ${String(r.status).padEnd(20)} POs=${String(r.pos).padStart(6)}  unreceived lines=${String(r.unreceived_lines).padStart(7)}${mark}`);
    }
    const hidden = hist.filter((r) => r.excluded_by_picker);
    if (hidden.length > 0) {
      note(`  ${hidden.length} status value(s) are excluded, holding `
        + `${hidden.reduce((a, r) => a + Number(r.unreceived_lines), 0)} unreceived lines.`);
      note('  DRAFT / CANCELLED are correct exclusions. Anything ELSE in that list');
      note('  is a status the picker does not know about — report it.');
    }

    // ── 3. The double-transfer census ──────────────────────────────────────
    note(`\n--- 3. double-transfer census (per pair, per line) ---`);
    note('  SO -> PO is absent on purpose: the owner ruled the PO follows MRP');
    note('  and is not once-only, so "transferred twice" is not a defect there.');
    for (const { pair, missing } of pairState) {
      if (missing.length > 0) {
        note(`  ${pair.label.padEnd(46)} NOT MEASURABLE (${missing.join(', ')})`);
        continue;
      }
      const [over] = await Q.doubleTransferred(sql, pair, co.id);
      const [bind] = await Q.unboundDestLines(sql, pair, co.id);
      const pct = Number(bind.total) > 0
        ? ((Number(bind.unbound) / Number(bind.total)) * 100).toFixed(1) : '0.0';
      note(`  ${pair.label}`);
      note(`      over-transferred lines: ${over.lines_over}   units over: ${over.units_over}   worst line: +${over.worst_line}`);
      note(`      destination lines: ${bind.total}   UNBOUND (invisible to the ceiling): ${bind.unbound} (${pct}%)`);
      if (Number(over.lines_over) > 0) {
        warn(`  ${pair.key}: ${over.lines_over} line(s) transferred PAST their own quantity in company ${co.id}.`);
        const rows = await Q.doubleTransferredRows(sql, pair, co.id, ROW_CAP);
        for (const r of rows) {
          note(`        src ${r.src_id}  qty=${r.src_qty}  moved=${r.qty_moved}  over by ${r.over_by}`);
        }
        if (rows.length === ROW_CAP) note(`        (first ${ROW_CAP} only)`);
      }
      if (Number(bind.unbound) > 0) {
        warn(`  ${pair.key}: ${bind.unbound} destination line(s) carry a NULL binding in company ${co.id} — `
          + 'no quantity ceiling can see them, so the source stays transferable.');
      }
    }
  }

  // ── 4. The specific PO from the screenshot ───────────────────────────────
  if (process.env.PO_DOC_NO) {
    note(`\n${'='.repeat(66)}`);
    note(`PO ${process.env.PO_DOC_NO} — line by line`);
    note('='.repeat(66));
    const rows = await Q.poByDocNo(sql, process.env.PO_DOC_NO);
    if (rows.length === 0) {
      warn(`no PO with number ${process.env.PO_DOC_NO} exists in scm.purchase_orders.`);
      warn('That is itself the answer: the picker cannot show lines for a PO that is not there.');
    } else {
      const h = rows[0];
      note(`  po_id=${h.po_id}  company=${h.company_id}  status=${h.status}`);
      const receivable = h.status === 'SUBMITTED' || h.status === 'PARTIALLY_RECEIVED';
      note(receivable
        ? '  status IS receivable, so the picker was entitled to show its lines.'
        : `  status ${h.status} is NOT receivable — the picker excludes it, and used to say "received".`);
      let anyRemaining = 0;
      for (const r of rows) {
        if (!r.po_item_id) { note('  (this PO has no line items at all)'); continue; }
        anyRemaining += Number(r.remaining) > 0 ? 1 : 0;
        note(`  ${String(r.material_code).padEnd(24)} qty=${r.qty} received=${r.received_qty} `
          + `remaining=${r.remaining}  grn lines bound to it=${r.grn_lines}`);
      }
      note(`\n  lines still outstanding: ${anyRemaining}`);
      if (anyRemaining > 0 && receivable) {
        warn('  This PO HAS outstanding lines and IS receivable, so the empty grid was');
        warn('  the fetch window, not the goods. That refutes "every line has been received".');
      } else if (anyRemaining === 0) {
        note('  Every line really is fully received. The old message was TRUE here —');
        note('  which is not the same as it having been justified.');
      }
    }
  } else {
    note('\n(no PO_DOC_NO given, so the screenshot PO was not looked up)');
  }
}

/* Exit 0 for every legitimate answer — a red job reads as "the check broke", and
   the answer IS the output. Non-zero is reserved for an unreachable database. */
main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error(`probe failed: ${e.message}`);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
