#!/usr/bin/env node
/* HC-0110 (Sim, 2026-10-15): "PO outstanding PO9024, PO8783 - please correct".
 * Give the sofa pieces the 2026-09 compartment round added to two purchase
 * orders the goods receipt (and, where the sofa has shipped, the delivery
 * order) their lead piece already carries.
 *
 * WHAT HAPPENED. apply-sofa-compartment-corrections.mjs split each collapsed
 * AutoCount sofa line into one ERP row per piece. The lead row was RE-CODED in
 * place and kept its goods-receipt line; the other pieces were INSERTed with
 * received_qty 0 and no receipt line of their own. That receipt line was the
 * WHOLE sofa (AutoCount received the set as one line), so after the split the
 * set reads as one piece received and the rest outstanding:
 *
 *   HC-PO-009024 / HC-SO-012025 - lead 9050-1A(LHF) on HC-GR-004940-PO-009024,
 *     pieces 9050-1NA, 9050-CNR, 9050-1A(RHF) at received 0. The same sofa went
 *     out on HC-DO-010936 against the lead SO line only, so the three SO pieces
 *     read undelivered / PENDING although the customer has the set.
 *   HC-PO-008783 / HC-SO-011733 - lead 9058-2A(LHF) on HC-GR-004863, pieces
 *     9058-CNR, 9058-1NA x2, 9058-CONSOLE, 9058-1A(RHF) at received 0, so their
 *     SO lines stay PENDING (company-1 sofa lines light only through their own
 *     received PO line - HARD_BOUND_COMPANY_ID).
 *
 * THE WRITE. For each piece: clone the lead's receipt line onto the piece
 * (purchase_order_item_id = the piece) and recount the piece's received_qty by
 * the recomputePoReceived rule. Where the lead SO line is on a delivered
 * migrated delivery order, clone that DO line onto each SO piece too. Clones
 * copy every column (information_schema, buildCloneInsert) and zero every
 * `_sen` column, so no document total moves; totals are summed before and
 * after inside the transaction and the build rolls back if one moved.
 * Nothing is deleted. Nothing is queued to AutoCount.
 *
 * GATES (each a refusal, never a fallback):
 *   - the live pieces are exactly the EXPECTED multiset below, same AutoCount
 *     line key as the lead, each at RM 0 with no receipt line;
 *   - the lead has exactly one live receipt line, received in full, on a
 *     migrated_no_stock receipt with zero inventory movements;
 *   - a DO is split only when it is DELIVERED, migrated_no_stock, carries zero
 *     inventory movements, and no SO piece has a DO line yet.
 *
 * NOT DONE HERE: the SO lines' stock_status. Run "Recompute SO stock
 * allocation" with doc HC-SO-011733 and then HC-SO-012025 afterwards; bound
 * mode turns a piece READY once its own PO line reads received.
 *
 * MODE=plan (default) runs every write inside a transaction and ROLLS BACK, so
 * the plan log is the apply's exact effect. MODE=apply with
 * CONFIRM="I HAVE REVIEWED THE DRY-RUN" commits, then re-reads on a FRESH
 * connection and asserts the shape.
 *
 * RE-RUN: inert. A piece is selected only while it has no live receipt line;
 * a successful apply gives it one, so a second run finds nothing to do.
 */
import postgres from 'postgres';
import { buildCloneInsert, multiset } from './lib/redecode-sofa-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const CO = 1;
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* Read off production 2026-10-15 before this was written. A live set that
   differs is somebody else's change since then and is refused, not followed. */
const EXPECTED = [
  { po: 'HC-PO-009024', so: 'HC-SO-012025', lead: '9050-1A(LHF)', pieces: ['9050-1NA', '9050-CNR', '9050-1A(RHF)'] },
  { po: 'HC-PO-008783', so: 'HC-SO-011733', lead: '9058-2A(LHF)', pieces: ['9058-CNR', '9058-1NA', '9058-1NA', '9058-CONSOLE', '9058-1A(RHF)'] },
];

const K = (s) => String(s ?? '').trim().toUpperCase();
const LIVE_GRN = ['CANCELLED', 'DRAFT'];
const ROLLBACK = Symbol('plan rollback');

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function insertableColumns(client, table) {
  const rows = await client`
    SELECT column_name, is_generated, identity_generation
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}
     ORDER BY ordinal_position`;
  if (!rows.length) throw new Error(`scm.${table} has no columns in information_schema - wrong database?`);
  return rows.filter((r) => r.is_generated !== 'ALWAYS' && r.identity_generation === null).map((r) => r.column_name);
}

const movementsOf = async (client, id, docNo) => Number((await client`
  SELECT COUNT(*)::int AS n FROM scm.inventory_movements m
   WHERE m.source_doc_id::text = ${id} OR m.source_doc_no = ${docNo}`)[0].n);

/** Read one build and decide, or return { refused }. */
async function planBuild(e) {
  const [po] = await sql`SELECT id::text AS id, po_number, status::text AS status, company_id
                           FROM scm.purchase_orders WHERE po_number = ${e.po} AND company_id = ${CO}`;
  if (!po) return { refused: `${e.po} not found in company ${CO}` };
  const lines = await sql`
    SELECT i.id::text AS id, i.item_code, i.item_group, i.material_name, i.description, i.supplier_sku,
           i.qty::float8 AS qty, COALESCE(i.received_qty, 0)::float8 AS received_qty,
           COALESCE(i.unit_price_sen, 0)::bigint AS unit_price_sen, i.linked_ac_dtlkey::text AS dtlkey,
           i.so_item_id::text AS so_item_id, jsonb_typeof(i.variants) AS vt
      FROM scm.purchase_order_items i WHERE i.purchase_order_id = ${po.id}::uuid`;
  const grnLines = await sql`
    SELECT gi.id::text AS id, gi.grn_id::text AS grn_id, gi.purchase_order_item_id::text AS poi,
           g.grn_number, g.status::text AS status, g.migrated_no_stock,
           GREATEST(0, COALESCE(gi.qty_accepted, 0) - COALESCE(gi.returned_qty, 0))::float8 AS net
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE gi.purchase_order_item_id = ANY(${lines.map((l) => l.id)}::uuid[])
       AND g.status::text <> ALL(${LIVE_GRN})`;
  const grnOf = (id) => grnLines.filter((g) => g.poi === id);

  const leads = lines.filter((l) => K(l.item_code) === K(e.lead));
  if (leads.length !== 1) return { refused: `${e.po}: expected one ${e.lead} row, found ${leads.length}` };
  const lead = leads[0];
  if (!lead.dtlkey) return { refused: `${e.po}: ${e.lead} carries no AutoCount line key, so its pieces cannot be told apart` };
  const pieces = lines.filter((l) => l.id !== lead.id && l.dtlkey === lead.dtlkey && grnOf(l.id).length === 0);
  if (multiset(pieces.map((p) => p.item_code)) !== multiset(e.pieces)) {
    return { refused: `${e.po}: unreceived pieces on ${e.lead}'s line are [${multiset(pieces.map((p) => p.item_code))}], expected [${multiset(e.pieces)}]` };
  }
  for (const p of pieces) {
    if (p.received_qty !== 0) return { refused: `${e.po}: ${p.item_code} already reads received ${p.received_qty}` };
    if (Number(p.unit_price_sen) !== 0) return { refused: `${e.po}: ${p.item_code} is priced - not an added piece` };
    if (p.qty !== lead.qty) return { refused: `${e.po}: ${p.item_code} qty ${p.qty} differs from the lead's ${lead.qty}` };
    if (p.vt !== 'object') return { refused: `${e.po}: ${p.item_code} variants are ${p.vt}, not an object` };
  }

  const leadGrn = grnOf(lead.id);
  if (leadGrn.length !== 1) return { refused: `${e.po}: ${e.lead} has ${leadGrn.length} live receipt lines, expected 1` };
  const g = leadGrn[0];
  if (g.migrated_no_stock !== true) return { refused: `${g.grn_number} is not migrated paperwork - it moved stock` };
  /* Exactly the lead's qty: the clone copies the lead receipt line's quantities onto each piece. */
  if (g.net !== lead.qty) return { refused: `${g.grn_number} received ${g.net} against ${lead.qty} on ${e.lead}` };
  const gMoves = await movementsOf(sql, g.grn_id, g.grn_number);
  if (gMoves) return { refused: `${g.grn_number} carries ${gMoves} inventory movement(s)` };

  /* The SO side. A piece without its own SO line cannot be delivered or made
     ready, which is a different defect from this one. */
  const soIds = [lead.so_item_id, ...pieces.map((p) => p.so_item_id)];
  if (soIds.some((x) => !x)) return { refused: `${e.po}: a piece is not dedicated to a sales-order line` };
  const soLines = await sql`
    SELECT id::text AS id, doc_no, item_code, item_group, description, qty::float8 AS qty,
           cancelled, jsonb_typeof(variants) AS vt
      FROM scm.mfg_sales_order_items WHERE id = ANY(${soIds}::uuid[])`;
  const soById = new Map(soLines.map((r) => [r.id, r]));
  for (const p of pieces) {
    const s = soById.get(p.so_item_id);
    if (!s || s.doc_no !== e.so) return { refused: `${e.po}: ${p.item_code} is dedicated to a line outside ${e.so}` };
    if (K(s.item_code) !== K(p.item_code)) return { refused: `${e.so}: ${p.item_code} is dedicated to SO line ${s.item_code}` };
    if (s.cancelled) return { refused: `${e.so}: ${s.item_code} is cancelled` };
    if (s.qty !== p.qty) return { refused: `${e.so}: ${s.item_code} qty ${s.qty} differs from its PO piece's ${p.qty}` };
    if (s.vt !== 'object') return { refused: `${e.so}: ${s.item_code} variants are ${s.vt}, not an object` };
  }

  const doLines = await sql`
    SELECT di.id::text AS id, di.delivery_order_id::text AS do_id, di.so_item_id::text AS so_item_id,
           di.qty::float8 AS qty, d.do_number, d.status::text AS status, d.migrated_no_stock
      FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id = ANY(${soIds}::uuid[]) AND d.status::text <> 'CANCELLED'`;
  const leadDo = doLines.filter((d) => d.so_item_id === lead.so_item_id);
  const pieceDo = doLines.filter((d) => d.so_item_id !== lead.so_item_id);
  let dl = null;
  if (leadDo.length) {
    if (leadDo.length !== 1) return { refused: `${e.so}: ${e.lead} is on ${leadDo.length} delivery-order lines, expected 1` };
    if (pieceDo.length) return { refused: `${e.so}: ${pieceDo.length} piece(s) already have a delivery-order line` };
    dl = leadDo[0];
    if (dl.status !== 'DELIVERED') return { refused: `${dl.do_number} is ${dl.status}, not DELIVERED` };
    if (dl.migrated_no_stock !== true) return { refused: `${dl.do_number} is not migrated paperwork - it moved stock` };
    if (dl.qty !== lead.qty) return { refused: `${dl.do_number} shipped ${dl.qty} against ${lead.qty} on ${e.lead}` };
    const dMoves = await movementsOf(sql, dl.do_id, dl.do_number);
    if (dMoves) return { refused: `${dl.do_number} carries ${dMoves} inventory movement(s)` };
  }

  return { e, po, lead, pieces, grn: g, soById, dl };
}

async function writeBuild(tx, b, grnCols, doCols) {
  const pick = (cols, o) => Object.fromEntries(Object.entries(o).filter(([c]) => cols.includes(c)));
  const grnOverrides = pick(grnCols, {
    purchase_order_item_id: 'uuid', item_code: null, item_group: null, material_name: null,
    description: null, supplier_sku: null, variants: 'text::jsonb',
  });
  const doOverrides = pick(doCols, { so_item_id: 'uuid', item_code: null, item_group: null, description: null, variants: 'text::jsonb' });
  const grnIns = buildCloneInsert({ table: 'scm.grn_items', columns: grnCols, overrides: grnOverrides });
  const doIns = buildCloneInsert({ table: 'scm.delivery_order_items', columns: doCols, overrides: doOverrides });

  const totals = async () => ({
    po: String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.purchase_order_items WHERE purchase_order_id = ${b.po.id}::uuid`)[0].t),
    grn: String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.grn_items WHERE grn_id = ${b.grn.grn_id}::uuid`)[0].t),
    do: b.dl ? String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.delivery_order_items WHERE delivery_order_id = ${b.dl.do_id}::uuid`)[0].t) : '0',
  });
  const before = await totals();

  /* Re-asserted inside the transaction: a document that grew a movement since
     the plan read is a different document. */
  if (await movementsOf(tx, b.grn.grn_id, b.grn.grn_number)) throw new Error(`${b.grn.grn_number} now carries inventory movements`);
  if (b.dl && await movementsOf(tx, b.dl.do_id, b.dl.do_number)) throw new Error(`${b.dl.do_number} now carries inventory movements`);

  const varsOf = async (table, id) => (await tx.unsafe(`SELECT variants::text AS v FROM ${table} WHERE id = $1::uuid`, [id]))[0].v;
  for (const p of b.pieces) {
    const bind = {
      purchase_order_item_id: p.id, item_code: p.item_code, item_group: p.item_group, material_name: p.material_name,
      description: p.description, supplier_sku: p.supplier_sku,
      variants: await varsOf('scm.purchase_order_items', p.id),
    };
    await tx.unsafe(grnIns.text, [b.grn.id, ...grnIns.params.map((c) => bind[c])]);
  }
  /* recomputePoReceived's rule: live receipt lines, net of returns, floored at 0. */
  await tx`
    UPDATE scm.purchase_order_items i
       SET received_qty = (SELECT COALESCE(SUM(GREATEST(0, COALESCE(gi.qty_accepted,0) - COALESCE(gi.returned_qty,0))), 0)
                             FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                            WHERE gi.purchase_order_item_id = i.id AND g.status::text <> ALL(${LIVE_GRN}))
     WHERE i.id = ANY(${b.pieces.map((p) => p.id)}::uuid[])`;

  if (b.dl) {
    for (const p of b.pieces) {
      const s = b.soById.get(p.so_item_id);
      const bind = {
        so_item_id: s.id, item_code: s.item_code, item_group: s.item_group, description: s.description,
        variants: await varsOf('scm.mfg_sales_order_items', s.id),
      };
      await tx.unsafe(doIns.text, [b.dl.id, ...doIns.params.map((c) => bind[c])]);
    }
    const [{ n }] = await tx`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE delivery_order_id = ${b.dl.do_id}::uuid`;
    await tx`UPDATE scm.delivery_orders SET line_count = ${n} WHERE id = ${b.dl.do_id}::uuid`;
  }

  const after = await totals();
  for (const k of ['po', 'grn', 'do']) {
    if (before[k] !== after[k]) throw new Error(`the ${k} total moved ${before[k]} -> ${after[k]}`);
  }
  const rcv = await tx`SELECT item_code, qty::float8 q, received_qty::float8 r FROM scm.purchase_order_items WHERE id = ANY(${b.pieces.map((p) => p.id)}::uuid[])`;
  const short = rcv.filter((r) => r.r !== r.q);
  if (short.length) throw new Error(`pieces still not received in full after the clone: ${short.map((r) => `${r.item_code} ${r.r}/${r.q}`).join(', ')}`);
  return before;
}

async function main() {
  log(`HC-0110 sofa piece receipts - mode=${APPLY ? 'APPLY' : 'PLAN (rehearsed in a transaction, rolled back)'}`);
  const grnCols = await insertableColumns(sql, 'grn_items');
  const doCols = await insertableColumns(sql, 'delivery_order_items');

  const builds = [];
  for (const e of EXPECTED) {
    const b = await planBuild(e);
    if (b.refused) { bad(`REFUSED ${b.refused}`); continue; }
    builds.push(b);
    log('');
    log(`${e.po} (${b.po.status}) / ${e.so} - lead ${b.lead.item_code} received on ${b.grn.grn_number}`);
    for (const p of b.pieces) log(`   ${p.item_code.padEnd(16)} received 0 -> ${p.qty}  (+1 line on ${b.grn.grn_number}, RM 0)`);
    if (b.dl) log(`   ${b.dl.do_number} (DELIVERED): +${b.pieces.length} line(s) for the SO pieces, RM 0`);
    else log(`   ${e.so}: lead not on a delivery order - no DO change`);
  }

  const applied = [];
  for (const b of builds) {
    try {
      const before = await sql.begin(async (tx) => {
        const t = await writeBuild(tx, b, grnCols, doCols);
        if (!APPLY) throw ROLLBACK;
        return t;
      });
      applied.push({ ...b, before });
      log(`  OK ${b.e.po} - committed; totals held (PO ${before.po}, GRN ${before.grn}, DO ${before.do})`);
    } catch (err) {
      if (err === ROLLBACK) { log(`  OK ${b.e.po} - rehearsal passed every check, rolled back`); continue; }
      bad(`  ROLLED BACK ${b.e.po} - ${err.message}`);
    }
  }
  await sql.end({ timeout: 5 });

  if (!APPLY) {
    log('');
    log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    process.exit(builds.length === EXPECTED.length ? 0 : 1);
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let held = 0;
  try {
    log('');
    log('=== VERIFIED ON A FRESH CONNECTION ===');
    for (const b of applied) {
      const ids = b.pieces.map((p) => p.id);
      const po = await check`SELECT item_code, qty::float8 q, received_qty::float8 r FROM scm.purchase_order_items WHERE id = ANY(${ids}::uuid[])`;
      const gr = await check`SELECT gi.item_code, gi.purchase_order_item_id::text AS poi, jsonb_typeof(gi.variants) AS vt
                               FROM scm.grn_items gi WHERE gi.grn_id = ${b.grn.grn_id}::uuid AND gi.purchase_order_item_id = ANY(${ids}::uuid[])`;
      const want = multiset(b.e.pieces);
      const poOk = po.length === ids.length && po.every((r) => r.r === r.q);
      const grOk = multiset(gr.map((r) => r.item_code)) === want && new Set(gr.map((r) => r.poi)).size === ids.length
        && gr.every((r) => r.vt === 'object');
      let doOk = true;
      if (b.dl) {
        const soIds = b.pieces.map((p) => p.so_item_id);
        const dl = await check`SELECT item_code, so_item_id::text AS so, jsonb_typeof(variants) AS vt
                                 FROM scm.delivery_order_items WHERE delivery_order_id = ${b.dl.do_id}::uuid AND so_item_id = ANY(${soIds}::uuid[])`;
        doOk = multiset(dl.map((r) => r.item_code)) === want && new Set(dl.map((r) => r.so)).size === soIds.length
          && dl.every((r) => r.vt === 'object');
      }
      const t = {
        po: String((await check`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.purchase_order_items WHERE purchase_order_id = ${b.po.id}::uuid`)[0].t),
        grn: String((await check`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.grn_items WHERE grn_id = ${b.grn.grn_id}::uuid`)[0].t),
      };
      const moneyOk = t.po === b.before.po && t.grn === b.before.grn;
      const ok = poOk && grOk && doOk && moneyOk;
      (ok ? log : bad)(`  ${b.e.po}: received ${poOk ? 'in full' : 'SHORT'}; receipt pieces ${grOk ? want : 'WRONG'}; DO ${b.dl ? (doOk ? 'pieces on ' + b.dl.do_number : 'WRONG') : 'untouched'}; money ${moneyOk ? 'unchanged' : 'MOVED'}`);
      if (ok) held++;
    }
    log(`  builds applied ${applied.length} of ${EXPECTED.length}; shapes verified ${held}`);
    log('  Next, NOT run by this script: Recompute SO stock allocation for HC-SO-011733 and HC-SO-012025.');
  } finally {
    await check.end({ timeout: 5 });
  }
  process.exit(held === EXPECTED.length ? 0 : 1);
}

main().catch(async (e) => {
  bad(e.stack || e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
