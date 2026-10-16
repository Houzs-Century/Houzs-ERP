#!/usr/bin/env node
/* HC-SO-2609-164: put back the three Dunlopillo prices amendment A4 zeroed (HC-0095).

   WHAT HAPPENED. HC-SO-2609-164/A4 (LINES lane, "sales choose wrong code",
   approved 29/09/2026) swapped three mattress item codes. The approval re-filled
   each line's price from the NEW SKU's sell price, which is 0, so RM 1,900.00 /
   RM 1,700.00 / RM 1,450.00 became RM 0.00 (census run 38788678021). The cause
   is fixed in #4675/#4676; this repairs the one order it already hit.

   WHERE THE OLD PRICE COMES FROM. The amendment's own rows:
   scm.so_amendment_lines.old_snapshot.unitPriceSen, cross-checked against the
   approval's audit row (mfg_so_audit_log AMENDMENT_SO_APPROVED,
   `line_<old code>_unit_price_sen` from -> to, written server-side by
   applySoAmendment). Both must agree, and must be 190000 / 170000 / 145000, or
   nothing is written.

   WHAT IS WRITTEN, mirroring the app exactly:
     line   the price-edit write in backend/src/scm/lib/so-revision.ts:776-786
            (applySoAmendment SPEC/QTY update): unit_price_sen, total_sen =
            total_inc_sen = balance_sen = qty * unit - discount,
            line_margin_sen = total - line_cost_sen. Cost is untouched.
     header recomputeTotals, backend/src/scm/routes/mfg-sales-orders.ts:6777
            (roll-up 6906-6995): category buckets + cost buckets, local_total_sen
            = balance_sen = total_revenue_sen = lines + legacy header fee,
            total_margin_sen, margin_pct_basis, line_count.
     audit  one mfg_so_audit_log UPDATE_LINE row per line, source 'script'
            (precedent: repair-bug101-processing-date.mjs).
   NOT done, and printed instead: the AutoCount edit the app would queue, PO cost
   (separate from the selling price), deposit invoices (per payment, not per total).

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes in one transaction, then
   re-reads on a fresh connection and asserts the shape.

   RE-RUN: convergent. A line already at its old price is "done"; when all three
   are, the run says nothing to do and writes nothing. */
import postgres from 'postgres';
import { isServiceLine, isDeliveryFeeServiceCode } from '../src/scm/shared/service-sku.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const SO = 'HC-SO-2609-164';
const AMENDMENT = 'HC-SO-2609-164/A4';
const EXPECTED_OLD = [145000, 170000, 190000];

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* recomputeTotals' roll-up (mfg-sales-orders.ts:6906-6995), from line rows. */
function rollUp(rows, headerFeeSen) {
  const h = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0, service_cost_sen: 0,
    mattress_sofa_cost_sen: 0, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0 };
  let total = 0, totalCost = 0;
  for (const it of rows) {
    const t = Number(it.total_sen || 0), c = Number(it.line_cost_sen || 0);
    total += t; totalCost += c;
    const g = String(it.item_group ?? '').toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) { h.service_sen += t; h.service_cost_sen += c; }
    else if (g.includes('mattress') || g.includes('sofa')) { h.mattress_sofa_sen += t; h.mattress_sofa_cost_sen += c; }
    else if (g.includes('bedframe')) { h.bedframe_sen += t; h.bedframe_cost_sen += c; }
    else if (g.includes('accessor')) { h.accessories_sen += t; h.accessories_cost_sen += c; }
    else { h.others_sen += t; h.others_cost_sen += c; }
  }
  const fee = rows.some((r) => isDeliveryFeeServiceCode(r.item_code)) ? 0 : Number(headerFeeSen ?? 0);
  const grand = total + fee, margin = grand - totalCost;
  return { ...h, local_total_sen: grand, balance_sen: grand, total_revenue_sen: grand, total_cost_sen: totalCost,
    total_margin_sen: margin, margin_pct_basis: grand > 0 ? Math.round((margin / grand) * 10000) : 0, line_count: rows.length };
}
const HEADER_COLS = Object.keys(rollUp([], 0));

/* Everything the decision needs, read with the company predicate. */
async function readState(db) {
  const [so] = await db`
    SELECT doc_no, status::text AS status, delivery_fee_sen, linked_ac_docno, deposit_sen, version,
           ${db(HEADER_COLS)}
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${SO}`;
  const lines = await db`
    SELECT id::text AS id, line_no, item_code, description, item_group, qty::numeric AS qty,
           unit_price_sen::bigint AS unit_price_sen, discount_sen::bigint AS discount_sen,
           total_sen::bigint AS total_sen, total_inc_sen::bigint AS total_inc_sen, balance_sen::bigint AS balance_sen,
           line_cost_sen::bigint AS line_cost_sen, line_margin_sen::bigint AS line_margin_sen, linked_ac_dtlkey
      FROM scm.mfg_sales_order_items
     WHERE company_id = ${CO} AND doc_no = ${SO} AND cancelled = false
     ORDER BY line_no`;
  const [am] = await db`
    SELECT id::text AS id, amendment_no, status::text AS status, so_approved_at
      FROM scm.so_amendments
     WHERE company_id = ${CO} AND so_doc_no = ${SO} AND amendment_no IN (${AMENDMENT}, 'A4')`;
  const amLines = am ? await db`
    SELECT l.sales_order_item_id::text AS item_id, l.change_type, l.new_item_code,
           l.new_unit_price_sen, l.old_snapshot->>'itemCode' AS old_code,
           (l.old_snapshot->>'unitPriceSen')::bigint AS old_price, (l.old_snapshot->>'qty')::numeric AS old_qty
      FROM scm.so_amendment_lines l
     WHERE l.amendment_id = ${am.id} AND coalesce(l.company_id, ${CO}) = ${CO}` : [];
  const audits = am ? await db`
    SELECT field_changes FROM scm.mfg_so_audit_log
     WHERE company_id = ${CO} AND so_doc_no = ${SO} AND action = 'AMENDMENT_SO_APPROVED'
       AND field_changes @> ${db.json([{ field: 'amendment_id', to: am.id }])}` : [];
  const [pay] = await db`
    SELECT coalesce(sum(amount_sen), 0)::bigint AS paid, count(*)::int AS n, bool_or(is_deposit) AS dep
      FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = ${SO}`;
  return { so, lines, am, amLines, audits, pay };
}

/* The three lines to repair, or why not. done = already at the old price. */
function decide(st) {
  const why = [];
  if (!st.so) return { why: [`${SO} not found for company ${CO}`] };
  if (st.so.status !== 'CONFIRMED') why.push(`SO status is ${st.so.status}, expected CONFIRMED`);
  if (!st.am) return { why: [...why, `${AMENDMENT} not found`] };
  const auditPrice = new Map();
  for (const a of st.audits) for (const c of a.field_changes ?? []) {
    const m = /^line_(.*)_unit_price_sen$/.exec(String(c.field ?? ''));
    if (m) auditPrice.set(m[1], { from: Number(c.from ?? 0), to: Number(c.to ?? 0) });
  }
  if (!st.audits.length) why.push('no AMENDMENT_SO_APPROVED audit row for this amendment');
  const picks = [];
  for (const l of st.amLines) {
    if (!(Number(l.old_price) > 0) || !l.new_item_code || l.new_item_code === l.old_code) continue;
    const line = st.lines.find((x) => x.id === l.item_id);
    const au = auditPrice.get(l.old_code);
    if (!line) { why.push(`amendment line for ${l.old_code} points at ${l.item_id}, not a live line of ${SO}`); continue; }
    if (au && au.to !== 0) continue; // the approval did not zero this one
    if (!au || au.from !== Number(l.old_price)) {
      why.push(`${l.old_code}: snapshot says ${l.old_price}, audit says ${au ? `${au.from} -> ${au.to}` : 'nothing'}`); continue;
    }
    picks.push({ ...l, line });
  }
  const olds = picks.map((p) => Number(p.old_price)).sort((a, b) => a - b);
  if (JSON.stringify(olds) !== JSON.stringify(EXPECTED_OLD)) why.push(`old prices are [${olds}], expected [${EXPECTED_OLD}]`);
  const todo = [], done = [];
  for (const p of picks) {
    const ln = p.line;
    if (ln.item_code !== p.new_item_code) why.push(`line ${ln.line_no} carries ${ln.item_code}, amendment set ${p.new_item_code}`);
    if (Number(ln.qty) !== 1) why.push(`line ${ln.line_no} qty is ${Number(ln.qty)}, expected 1`);
    if (Number(ln.unit_price_sen) === Number(p.old_price)) done.push(p);
    else if (Number(ln.unit_price_sen) === 0) todo.push(p);
    else why.push(`line ${ln.line_no} is at ${rm(ln.unit_price_sen)}, neither 0 nor the old ${rm(p.old_price)}: someone re-priced it`);
  }
  return { why, todo, done };
}

/* The app's line write (so-revision.ts:776-786) for a new unit price. */
const priced = (ln, unit) => {
  const total = Number(ln.qty) * unit - Number(ln.discount_sen || 0);
  return { ...ln, unit_price_sen: unit, total_sen: total, total_inc_sen: total, balance_sen: total,
    line_margin_sen: total - Number(ln.line_cost_sen || 0) };
};

async function sideEffects(db, st) {
  const ids = st.lines.map((l) => l.id);
  const [dos, sis, dis, pos, allocs, outbox, [wb]] = await Promise.all([
    db`SELECT DISTINCT d.do_number, d.status::text AS status FROM scm.delivery_order_items di
         JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
        WHERE d.company_id = ${CO} AND di.so_item_id IN ${db(ids)} AND upper(d.status::text) <> 'CANCELLED'`,
    db`SELECT invoice_number, status::text AS status FROM scm.sales_invoices
        WHERE company_id = ${CO} AND so_doc_no = ${SO} AND upper(status::text) <> 'CANCELLED'`,
    db`SELECT di_number, amount_sen, status FROM scm.acc_deposit_invoices WHERE company_id = ${CO} AND so_doc_no = ${SO}`,
    db`SELECT po.po_number, po.status::text AS status, poi.so_item_id::text AS so_item_id FROM scm.purchase_order_items poi
         JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
        WHERE po.company_id = ${CO} AND poi.so_item_id IN ${db(ids)}`,
    db`SELECT a.so_item_id::text AS so_item_id, a.qty FROM scm.purchase_order_item_allocations a
        WHERE a.company_id = ${CO} AND a.so_item_id IN ${db(ids)}`,
    db`SELECT op, status, created_at FROM scm.autocount_outbox
        WHERE company_id = ${CO} AND doc_type = 'SO' AND doc_no = ${SO} ORDER BY created_at DESC LIMIT 5`,
    db`SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`,
  ]);
  return { dos, sis, dis, pos, allocs, outbox, wb: wb?.value ?? null };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} order=${SO} amendment=${AMENDMENT}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const st = await readState(sql);
  const d = decide(st);
  if (st.am) note(`amendment ${st.am.amendment_no} status=${st.am.status} approved=${st.am.so_approved_at?.toISOString?.() ?? st.am.so_approved_at}`);
  if (d.why.length) {
    for (const w of d.why) bad(`REFUSED: ${w}`);
    note('Nothing written.');
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  if (!d.todo.length) {
    note(`Nothing to do: all ${d.done.length} lines already carry their pre-A4 price.`);
    await sql.end({ timeout: 5 });
    return;
  }

  const fx = await sideEffects(sql, st);
  if (fx.dos.length || fx.sis.length) {
    bad(`REFUSED: live DO ${fx.dos.map((x) => x.do_number).join(', ') || '-'} / invoice ${fx.sis.map((x) => x.invoice_number).join(', ') || '-'} carry this order; re-price through the app instead`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  const newPrice = new Map(d.todo.map((p) => [p.line.id, Number(p.old_price)]));
  const after = st.lines.map((ln) => newPrice.has(ln.id) ? priced(ln, newPrice.get(ln.id)) : ln);

  note('');
  note('=== LINES (before -> after) ===');
  for (const p of d.todo) {
    const b = p.line, a = after.find((x) => x.id === b.id);
    note(`  line ${b.line_no} ${b.item_code} (was ${p.old_code}) "${b.description ?? ''}" qty ${Number(b.qty)}`);
    for (const k of ['unit_price_sen', 'total_sen', 'total_inc_sen', 'balance_sen', 'line_margin_sen']) {
      note(`      ${k.padEnd(16)} ${rm(b[k])} -> ${rm(a[k])}`);
    }
  }
  note(`  other live lines unchanged: ${st.lines.length - d.todo.length}`);

  const hb = st.so, ha = rollUp(after, st.so.delivery_fee_sen);
  const hNow = rollUp(st.lines, st.so.delivery_fee_sen);
  note('');
  note('=== HEADER (before -> after, recomputeTotals roll-up) ===');
  for (const k of HEADER_COLS) {
    const fmt = k === 'margin_pct_basis' || k === 'line_count' ? String : rm;
    note(`  ${k.padEnd(24)} ${fmt(hb[k])} -> ${fmt(ha[k])}${Number(hb[k]) !== Number(hNow[k]) ? `   (stored differs from today's roll-up ${fmt(hNow[k])})` : ''}`);
  }
  const paid = Number(st.pay.paid);
  note('');
  note(`=== PAID / BALANCE (ledger: ${st.pay.n} payment row(s), is_deposit=${st.pay.dep}; header deposit_sen ${rm(hb.deposit_sen)}) ===`);
  note(`  before: total ${rm(hb.local_total_sen)} = paid ${rm(paid)} + balance ${rm(Number(hb.local_total_sen) - paid)}`);
  note(`  after:  total ${rm(ha.local_total_sen)} = paid ${rm(paid)} + balance ${rm(ha.local_total_sen - paid)}`);
  note('  (header balance_sen is the gross total by recomputeTotals design; the screen balance is total - paid)');

  note('');
  note('=== SIDE EFFECTS (reported, not changed) ===');
  note(`  AutoCount: linked_ac_docno=${hb.linked_ac_docno ?? '-'}; line dtlkeys=${d.todo.map((p) => p.line.linked_ac_dtlkey ?? '-').join(',')}; write-back flag=${fx.wb ?? '(unset = off)'}`);
  note(`    recent outbox rows: ${fx.outbox.map((o) => `${o.op}/${o.status}`).join(', ') || 'none'}. This script queues NO AutoCount edit (the app's queueAcSoEdit would, when the flag covers company ${CO}).`);
  note(`  deposit invoices: ${fx.dis.map((x) => `${x.di_number} ${rm(x.amount_sen)} ${x.status}`).join(', ') || 'none'} (per payment, the total does not move them)`);
  const bound = (id) => fx.pos.filter((x) => x.so_item_id === id).map((x) => `${x.po_number} (${x.status})`)
    .concat(fx.allocs.filter((x) => x.so_item_id === id).map((x) => `allocation qty ${x.qty}`));
  for (const p of d.todo) note(`  PO bound to line ${p.line.line_no}: ${bound(p.line.id).join(', ') || 'none'} (PO cost is separate; not changed)`);
  note(`  DO / invoice: none live`);

  if (!APPLY) {
    note('');
    note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note('');
  note('=== APPLYING (one transaction) ===');
  await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${SO} FOR UPDATE`;
    const fresh = decide(await readState(tx));
    if (fresh.why.length || fresh.todo.length !== d.todo.length) throw new Error(`order moved since the plan: ${fresh.why.join('; ') || `${fresh.todo.length} line(s) to do`}`);
    for (const p of d.todo) {
      const a = after.find((x) => x.id === p.line.id);
      const u = await tx`
        UPDATE scm.mfg_sales_order_items
           SET unit_price_sen = ${a.unit_price_sen}, total_sen = ${a.total_sen}, total_inc_sen = ${a.total_inc_sen},
               balance_sen = ${a.balance_sen}, line_margin_sen = ${a.line_margin_sen}
         WHERE company_id = ${CO} AND doc_no = ${SO} AND id = ${p.line.id} AND unit_price_sen = 0
         RETURNING id`;
      if (u.length !== 1) throw new Error(`line ${p.line.line_no}: updated ${u.length} rows`);
      await tx`
        INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
        VALUES (${SO}, ${CO}, 'UPDATE_LINE', 'System (HC-0095 repair)',
                ${tx.json([{ field: 'itemCode', to: p.line.item_code }, { field: 'unitPriceSen', from: 0, to: a.unit_price_sen }])},
                ${st.so.status}, 'script',
                ${`HC-0095: price restored to ${rm(a.unit_price_sen)}, the price before ${AMENDMENT} swapped ${p.old_code} -> ${p.line.item_code} and its approval set it to RM 0.00.`})`;
    }
    const h = await tx`
      UPDATE scm.mfg_sales_orders SET ${tx(ha, HEADER_COLS)}, version = version + 1, updated_at = now()
       WHERE company_id = ${CO} AND doc_no = ${SO} RETURNING doc_no`;
    if (h.length !== 1) throw new Error(`header: updated ${h.length} rows`);
  });
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    const back = await readState(check);
    const v = decide(back);
    const problems = [...v.why];
    if (v.todo.length) problems.push(`${v.todo.length} line(s) still at RM 0`);
    for (const p of v.done) {
      const l = p.line, want = Number(l.qty) * Number(l.unit_price_sen) - Number(l.discount_sen || 0);
      for (const k of ['total_sen', 'total_inc_sen', 'balance_sen']) if (Number(l[k]) !== want) problems.push(`line ${l.line_no} ${k} ${l[k]} is not qty x unit - discount (${want})`);
      if (Number(l.line_margin_sen) !== want - Number(l.line_cost_sen || 0)) problems.push(`line ${l.line_no} margin ${l.line_margin_sen} is not total - cost`);
    }
    const want = rollUp(back.lines, back.so.delivery_fee_sen);
    for (const k of HEADER_COLS) if (Number(back.so[k]) !== Number(want[k])) problems.push(`header ${k} ${back.so[k]} is not the roll-up ${want[k]}`);
    const paidNow = Number(back.pay.paid);
    note(`  header total ${rm(back.so.local_total_sen)} = paid ${rm(paidNow)} + balance ${rm(Number(back.so.local_total_sen) - paidNow)}`);
    for (const p of problems) bad(`  WRONG SHAPE ${p}`);
    if (problems.length) process.exitCode = 1;
    else note(`  OK: ${v.done.length} lines at their pre-A4 price, every line total = qty x unit - discount, header = recomputeTotals roll-up.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
