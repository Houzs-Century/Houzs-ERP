#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Give back the compartments the migration could not read at the time —
// and ONLY the ones AutoCount's own text still says out loud today.
//
// WHAT WENT WRONG. When the sofa importer could not decode a build out of
// AutoCount's Desc2 it refused to guess: it opened ONE line on the bare
// `{model}-1S` placeholder, put `SOFA UNPARSED` in the remark, and left the
// pieces to a human. That was the right call. But the decoder has been taught
// since — `1EFL`, `1Console`, `L2L(...)`, `1R(P)`, `1B/S seater` all landed in
// the 2026-08-30 sweep — so a subset of those rows now decode CLEANLY from the
// text they already hold. They are not waiting on a photograph. They are
// waiting on a re-run.
//
// This finds that subset AT RUN TIME and re-derives the build from the book's
// own words. It carries NO hand-curated list, which is the difference between
// it and split-collapsed-sofa-lines.mjs: that script applies piece lists read
// off photographs by a person, this one copies what AutoCount wrote — the
// migration's standing rule (`docs/bugs/`, migration-copy-never-compute).
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────
//   MATCH AND UPDATE IN PLACE, NEVER DROP AND RE-INSERT. The existing row is
//   RE-CODED as the FIRST piece and the remaining pieces are INSERTed beside
//   it. The row id survives, and with it the
//   purchase_order_items.so_item_id dedication that bound-mode readiness reads.
//   Nothing is ever deleted (owner: 不可以删只可以 cancel).
//
//   THE MONEY DOES NOT MOVE BY ONE CENT. The importer put the whole build's
//   price on its first piece and 0 on the rest. The UPDATE writes item_code,
//   variants and the remark and NO money column at all, so the first piece
//   still carries the whole price by construction; every inserted piece has
//   every `%_sen` column at 0. The document total is summed before and after
//   INSIDE the same transaction and the build is rolled back if it moved.
//
//   THE SO AND THE PO MOVE TOGETHER. A sofa build is one physical thing
//   described on two documents. Both sides are corrected in ONE transaction,
//   each new PO piece is dedicated to the SO piece carrying the same
//   compartment, and a build whose two sides decode to DIFFERENT piece lists is
//   REFUSED rather than reconciled.
//
//   A BUILD WHOSE DOWNSTREAM HAS MOVED IS REFUSED. Any goods-receipt line
//   against the purchase-order row, any delivery-order line against the
//   sales-order row, and the build is reported and left alone. That is STRICTER
//   than "a GRN line or a posted DO": a draft delivery is refused too, and the
//   log says which kind each refusal was, so the cost of the wider rule is
//   visible rather than assumed.
//
// ── SAFETY ─────────────────────────────────────────────────────────────────
//   MODE=plan is the default and writes nothing. MODE=apply needs
//   CONFIRM="I HAVE REVIEWED THE DRY-RUN". Every build is its own transaction.
//   The verification re-reads on a FRESH connection and asserts the SHAPE — the
//   piece multiset now on the document and that every variants block is a jsonb
//   OBJECT — never a row count (docs/jsonb-double-encoding-coe.md: a repair
//   counted 7 of 7 while re-corrupting all 7).
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        the phrase above, on apply
//   COMPANY        default 1 (Houzs Century)
//   DOC            optional — one document number, to rehearse a single build
//
// RE-RUN: inert. A corrected row no longer carries the `SOFA UNPARSED` marker
// and no longer sits on the bare `-1S`, so the second run does not select it at
// all; a build it refused is refused again for the same reason, and a build
// whose decode IS the single piece the row already is stays untouched every
// time.
// ---------------------------------------------------------------------------
import postgres from 'postgres';
import { SOFA_MODEL_ALIAS, parseSofa } from './lib/parse-sofa.mjs';
import { buildFabricColourIndex, isPendingColour } from './lib/fabric-colour-match.mjs';
import {
  buildCloneInsert, compartmentOf, isPlaceholderLine, mergeVariants, modelOf,
  multiset, pieceCodes, planRow, sameBuild, senColumns,
} from './lib/redecode-sofa-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 1);
const ONLY = (process.env.DOC || '').trim().toUpperCase();
const STAMP = new Date().toISOString().slice(0, 10);

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const K = (s) => String(s ?? '').trim().toUpperCase();
const oneLine = (s) => String(s ?? '').replace(/\r/g, '').replace(/\n/g, '\\n').replace(/[ \t]+/g, ' ').trim();

/** Every column of an scm table that a clone may write into: generated and
 *  identity columns are the server's to fill, and NEVER_CLONE takes the rest. */
async function insertableColumns(client, table) {
  const rows = await client`
    SELECT column_name, is_generated, identity_generation
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}
     ORDER BY ordinal_position`;
  if (!rows.length) throw new Error(`scm.${table} has no columns in information_schema — wrong database?`);
  return rows.filter((r) => r.is_generated !== 'ALWAYS' && r.identity_generation === null)
    .map((r) => r.column_name);
}

/** The variants block the importer WOULD have written for this decode. */
function decodedVariants(ps, findColour) {
  const colour = isPendingColour(ps.color) ? null : ps.color;
  const fc = colour ? findColour(colour) : null;
  return {
    variants: {
      seatHeight: ps.size ?? null,
      fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
      fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : (colour || null),
      fabricLabel: fc ? fc.fabric_id : null, specials: ps.specials,
    },
    colourResolved: Boolean(fc),
  };
}

async function main() {
  log(`re-decode the collapsed sofa lines — mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}${ONLY ? ` DOC=${ONLY}` : ''}`);

  // ── masters ──────────────────────────────────────────────────────────────
  const prods = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  const nameOf = new Map(prods.map((p) => [K(p.code), p.name]));
  const codeSet = new Set(prods.map((p) => K(p.code)));
  const RECL = ['-1S(R)', '-1A(R)(LHF)', '-1A(P)(LHF)', '-1S(P)'];
  const reclOf = (m) => RECL.some((s) => codeSet.has(K(m + s)));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  /* Exactly the predicate import-ac-outstanding-so.mjs:177 hands the decoder.
     Without it a colour-first Desc2 ("BO315-5 (FOSSIL)/32”/1R(P)+1R(P)") reads
     its own fabric code as an unknown STRUCTURE token and the whole build dies
     — which is why this script must consult the live library, not a constant. */
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  log(`masters: ${codeSet.size} product codes, ${fcRows.length} fabric colours`);

  const soCols = await insertableColumns(sql, 'mfg_sales_order_items');
  const poCols = await insertableColumns(sql, 'purchase_order_items');
  log(`clone shape: sales-order line ${soCols.length} columns (${senColumns(soCols).length} money), purchase-order line ${poCols.length} columns (${senColumns(poCols).length} money)`);

  // ── the corpus ───────────────────────────────────────────────────────────
  const soRows = await sql`
    SELECT i.id::text AS id, h.doc_no AS doc, i.item_code AS code, i.description2 AS d2,
           i.remark, i.variants, i.cancelled, i.qty, i.unit_price_sen, i.total_sen
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY h.doc_no, i.line_no`;
  const poRows = await sql`
    SELECT i.id::text AS id, p.id::text AS po_id, p.po_number AS doc, i.item_code AS code,
           i.description2 AS d2, i.notes AS remark, i.variants, i.supplier_sku,
           i.so_item_id::text AS so_item_id, p.status AS po_status
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY p.po_number`;

  const decode = (r) => {
    const model = modelOf(r.code, SOFA_MODEL_ALIAS);
    const ps = parseSofa(r.d2, model, reclOf(model), { knownColour });
    const codes = pieceCodes(model, ps.pieces);
    const missing = codes.filter((c) => !codeSet.has(K(c)));
    const readable = codes.length > 0 && ps.conf !== 'low';
    return { model, ps, codes, missing, readable, clean: readable && missing.length === 0 };
  };

  const soPh = soRows.filter((r) => isPlaceholderLine({ itemCode: r.code, remark: r.remark }));
  const poPh = poRows.filter((r) => isPlaceholderLine({ itemCode: r.code, remark: r.remark }));
  log('');
  log(`placeholders on a bare "-1S": ${soPh.length} sales-order line(s) on ${new Set(soPh.map((r) => r.doc)).size} document(s), `
    + `${poPh.length} purchase-order line(s) on ${new Set(poPh.map((r) => r.doc)).size} document(s)`);

  const poPhById = new Map(poPh.map((r) => [r.id, r]));
  const poBySoItem = new Map();
  for (const r of poRows) if (r.so_item_id) {
    if (!poBySoItem.has(r.so_item_id)) poBySoItem.set(r.so_item_id, []);
    poBySoItem.get(r.so_item_id).push(r);
  }
  const soPhById = new Map(soPh.map((r) => [r.id, r]));

  // ── units: a build is a sales-order line and the purchase-order line(s)
  //    dedicated to it. A purchase-order placeholder nobody dedicated stands
  //    alone. Neither side is ever corrected without the other. ─────────────
  const units = [];
  const claimedPo = new Set();
  for (const so of soPh) {
    const pos = poBySoItem.get(so.id) ?? [];
    units.push({ so, pos });
    for (const p of pos) claimedPo.add(p.id);
  }
  for (const po of poPh) {
    if (claimedPo.has(po.id)) continue;
    units.push({ so: null, pos: [po] });
  }

  const refusals = [];
  const noops = [];
  const skipped = [];
  const builds = [];

  for (const u of units) {
    const docs = [u.so?.doc, ...u.pos.map((p) => p.doc)].filter(Boolean);
    const label = docs.join(' / ');
    if (ONLY && !docs.some((d) => K(d) === ONLY)) continue;
    const refuse = (why) => refusals.push({ label, why });

    /* A cancelled document is not a build waiting to be understood. Nothing is
       ever deleted here, so a cancelled line stays exactly as the book left
       it — including its placeholder. */
    if (u.so?.cancelled) { skipped.push({ label, why: 'the sales-order line is cancelled' }); continue; }
    if (u.pos.some((p) => K(p.po_status) === 'CANCELLED')) { skipped.push({ label, why: 'the purchase order is cancelled' }); continue; }

    // Which members can speak? A member decodes cleanly, or it does not.
    const members = [];
    if (u.so) members.push({ side: 'SO', row: u.so, ...decode(u.so), placeholder: true });
    for (const p of u.pos) {
      members.push({ side: 'PO', row: p, ...decode(p), placeholder: poPhById.has(p.id) });
    }
    const speakers = members.filter((m) => m.placeholder && m.clean);
    if (!speakers.length) {
      // Not this script's population: the text still carries no readable build,
      // or a piece SKU is not minted. Counted, never touched.
      const anyReadable = members.some((m) => m.placeholder && m.readable);
      skipped.push({ label, why: anyReadable ? `a piece SKU is not minted: ${[...new Set(members.flatMap((m) => m.missing))].join(', ')}` : 'the text still carries no readable build' });
      continue;
    }

    // Both sides speaking and disagreeing is a real divergence, not a tie to break.
    const first = speakers[0];
    const dissent = speakers.find((m) => !sameBuild(m.ps.pieces, first.ps.pieces));
    if (dissent) {
      refuse(`the two documents decode to DIFFERENT builds — ${first.row.doc} says ${first.ps.pieces.join('+')}, ${dissent.row.doc} says ${dissent.ps.pieces.join('+')}`);
      continue;
    }
    if (speakers.some((m) => m.model !== first.model)) {
      refuse(`the two documents are on different models (${[...new Set(speakers.map((m) => m.model))].join(', ')})`);
      continue;
    }
    const target = pieceCodes(first.model, first.ps.pieces);

    // A purchase-order line dedicated to this order line that is NOT a
    // placeholder already states a build of its own; re-coding the order line
    // under it would leave the two disagreeing.
    const settled = u.pos.filter((p) => !poPhById.has(p.id));
    if (settled.length) {
      refuse(`the purchase order raised from it already states a build (${settled.map((p) => `${p.doc} ${p.code}`).join(', ')})`);
      continue;
    }
    // Two collapsed purchase-order lines on one order line: expanding both
    // leaves no single answer to "which piece is this one dedicated to".
    if (u.pos.length > 1) {
      refuse(`${u.pos.length} collapsed purchase-order lines are dedicated to the same order line — which piece each one becomes is a human's call`);
      continue;
    }
    // A purchase-order placeholder standing alone but dedicated to an order
    // line that is NOT a placeholder: same divergence from the other end.
    if (!u.so && u.pos[0].so_item_id && !soPhById.has(u.pos[0].so_item_id)) {
      refuse('it is dedicated to a sales-order line that already states a build');
      continue;
    }

    // Downstream. Stricter than the rule it implements, and the log says so.
    let blocked = null;
    if (u.so) {
      const dos = await sql`
        SELECT d.do_number AS doc, UPPER(COALESCE(d.status::text, '')) AS status
          FROM scm.delivery_order_items di
          JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
         WHERE di.so_item_id = ${u.so.id}`;
      if (dos.length) blocked = `${dos.length} delivery-order line(s) already state this build (${dos.map((d) => `${d.doc} ${d.status}`).join(', ')})`;
    }
    for (const p of u.pos) {
      if (blocked) break;
      const grs = await sql`
        SELECT g.grn_number AS doc, g.migrated_no_stock AS migrated
          FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
         WHERE gi.purchase_order_item_id = ${p.id}`;
      if (grs.length) blocked = `${grs.length} goods-receipt line(s) already state this build (${grs.map((g) => `${g.doc}${g.migrated ? ' migrated' : ' REAL STOCK'}`).join(', ')})`;
    }
    if (blocked) { refuse(blocked); continue; }

    // The plan, per member row.
    const rows = [];
    let noop = true;
    for (const m of members) {
      const p = planRow({ currentCode: m.row.code, targetCodes: target });
      if (p.kind === 'refuse') { noop = false; break; }
      if (p.kind === 'expand') noop = false;
      const src = m.clean ? m : first;   // a silent side adopts the side that speaks
      const { variants, colourResolved } = decodedVariants(src.ps, findColour);
      rows.push({ ...m, plan: p, variants, colourResolved, borrowed: !m.clean });
    }
    if (noop) {
      noops.push({ label, pieces: target.join('+') });
      continue;
    }
    builds.push({ label, target, model: first.model, rows, why: first.ps.why });
  }

  // ── the plan, in full ────────────────────────────────────────────────────
  log('');
  log(`=== ${builds.length} BUILD(S) THE BOOK'S OWN TEXT CAN ANSWER ===`);
  let nUpd = 0, nIns = 0;
  for (const b of builds) {
    log(`  ${b.label}  [${b.model}]  ${b.target.map(compartmentOf).join('+')}`);
    for (const r of b.rows) {
      log(`     ${r.side} ${r.row.doc}  ${JSON.stringify(oneLine(r.row.d2))}${r.borrowed ? '   (pieces taken from the paired document — this side\'s own text does not decode)' : ''}`);
      if (r.plan.kind === 'noop') { log('        already states this piece — untouched'); continue; }
      log(`        re-code  ${compartmentOf(r.row.code)} -> ${compartmentOf(r.plan.update)}   (money untouched)`);
      nUpd++;
      for (const c of r.plan.inserts) { log(`        insert   ${compartmentOf(c)}   (every money column 0)`); nIns++; }
      const seat = r.variants.seatHeight;
      log(`        variants seatHeight=${seat ?? '(none)'} colour=${r.variants.colourLabel ?? '(none)'}${r.colourResolved ? ' [library-confirmed]' : ''} specials=${(r.variants.specials || []).length}`);
    }
    if (b.why.length) log(`     decoder notes: ${b.why.join('; ')}`);
  }
  log('');
  log(`lines re-coded ${nUpd} · lines inserted ${nIns} · deletions 0`);
  log('');
  log(`=== ${noops.length} LINE(S) WHOSE DECODE IS THE PIECE THEY ALREADY ARE — untouched ===`);
  for (const n of noops) log(`  ${n.label}  -> ${n.pieces}  (the marker stays: confirming a build is not this script's claim to make)`);
  log('');
  log(`=== ${refusals.length} BUILD(S) REFUSED ===`);
  for (const r of refusals) bad(`  ${r.label} — ${r.why}`);
  log('');
  log(`=== ${skipped.length} PLACEHOLDER(S) OUT OF SCOPE (the photograph is still the only answer) ===`);
  const bySkip = new Map();
  for (const s of skipped) bySkip.set(s.why, (bySkip.get(s.why) ?? 0) + 1);
  for (const [why, n] of [...bySkip.entries()].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${why}`);

  if (!APPLY) {
    log('');
    log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── apply, one transaction per build ─────────────────────────────────────
  log('');
  log(`=== APPLYING ${builds.length} BUILD(S) ===`);
  const applied = [];
  for (const b of builds) {
    try {
      /* The receipt is taken from what sql.begin RETURNS, so a build only joins
         `applied` once its transaction has actually committed — pushing from
         inside the callback would record a build that a failing COMMIT then
         threw away. */
      const receipt = await sql.begin(async (tx) => {
        const soRow = b.rows.find((r) => r.side === 'SO');
        const poRow = b.rows.find((r) => r.side === 'PO');
        const soDoc = soRow?.row.doc ?? null;
        const poId = poRow?.row.po_id ?? null;

        const totalBefore = {
          so: soDoc ? String((await tx`SELECT COALESCE(SUM(total_sen),0)::bigint AS t FROM scm.mfg_sales_order_items WHERE doc_no = ${soDoc}`)[0].t) : null,
          po: poId ? String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.purchase_order_items WHERE purchase_order_id = ${poId}`)[0].t) : null,
        };

        // The sales order first: the purchase-order pieces dedicate to its ids.
        const soPieceId = new Map();
        if (soRow && soRow.plan.kind === 'expand') {
          const codes = [soRow.plan.update, ...soRow.plan.inserts];
          const remark = `sofa: re-decoded from the AutoCount text ${STAMP}${soRow.ps.why.length ? '; ' + soRow.ps.why.join('; ') : ''}`;
          const v = mergeVariants(soRow.row.variants, soRow.variants, { colourResolved: soRow.colourResolved });
          await tx`UPDATE scm.mfg_sales_order_items
                      SET item_code = ${codes[0]}, description = ${nameOf.get(K(codes[0])) ?? codes[0]},
                          variants = ${JSON.stringify(v)}::text::jsonb, remark = ${remark}
                    WHERE id = ${soRow.row.id}`;
          soPieceId.set(K(codes[0]), soRow.row.id);
          const ins = buildCloneInsert({
            table: 'scm.mfg_sales_order_items',
            columns: soCols,
            overrides: { item_code: null, description: null, variants: 'text::jsonb', remark: null },
            exprs: soCols.includes('line_no')
              ? { line_no: '(SELECT COALESCE(MAX(x.line_no),0)+1 FROM scm.mfg_sales_order_items x WHERE x.doc_no = i.doc_no)' }
              : {},
          });
          for (const code of soRow.plan.inserts) {
            const bind = { item_code: code, description: nameOf.get(K(code)) ?? code, variants: JSON.stringify(v), remark };
            const [row] = await tx.unsafe(ins.text, [soRow.row.id, ...ins.params.map((p) => bind[p])]);
            soPieceId.set(K(code), row.id);
          }
        }

        if (poRow && poRow.plan.kind === 'expand') {
          const codes = [poRow.plan.update, ...poRow.plan.inserts];
          const notes = `${poRow.row.d2 ? poRow.row.d2 + ' | ' : ''}sofa: re-decoded from the AutoCount text ${STAMP}`;
          const v = mergeVariants(poRow.row.variants, poRow.variants, { colourResolved: poRow.colourResolved });
          const skuOf = (code) => (poRow.row.supplier_sku ? `${poRow.row.supplier_sku} ${compartmentOf(code)}` : null);
          await tx`UPDATE scm.purchase_order_items
                      SET item_code = ${codes[0]}, material_name = ${nameOf.get(K(codes[0])) ?? codes[0]},
                          supplier_sku = ${skuOf(codes[0])},
                          variants = ${JSON.stringify(v)}::text::jsonb, notes = ${notes}
                    WHERE id = ${poRow.row.id}`;
          const ins = buildCloneInsert({
            table: 'scm.purchase_order_items',
            columns: poCols,
            overrides: {
              item_code: null, material_name: null, supplier_sku: null,
              variants: 'text::jsonb', notes: null, so_item_id: 'uuid',
            },
          });
          for (const code of poRow.plan.inserts) {
            /* The dedication is what bound-mode readiness reads, so each piece
               points at the ORDER line carrying the SAME compartment — not at
               the first one, and never at a line this script did not create. */
            const bind = {
              item_code: code, material_name: nameOf.get(K(code)) ?? code, supplier_sku: skuOf(code),
              variants: JSON.stringify(v), notes, so_item_id: soPieceId.get(K(code)) ?? null,
            };
            await tx.unsafe(ins.text, [poRow.row.id, ...ins.params.map((p) => bind[p])]);
          }
        }

        const totalAfter = {
          so: soDoc ? String((await tx`SELECT COALESCE(SUM(total_sen),0)::bigint AS t FROM scm.mfg_sales_order_items WHERE doc_no = ${soDoc}`)[0].t) : null,
          po: poId ? String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.purchase_order_items WHERE purchase_order_id = ${poId}`)[0].t) : null,
        };
        if (totalBefore.so !== totalAfter.so) throw new Error(`the sales-order total moved ${totalBefore.so} -> ${totalAfter.so}`);
        if (totalBefore.po !== totalAfter.po) throw new Error(`the purchase-order total moved ${totalBefore.po} -> ${totalAfter.po}`);
        return { ...b, soDoc, poId, totalBefore };
      });
      applied.push(receipt);
      log(`  OK ${b.label} — totals held (order ${receipt.totalBefore.so ?? '-'}, purchase ${receipt.totalBefore.po ?? '-'})`);
    } catch (e) {
      bad(`  ROLLED BACK ${b.label} — ${e.message}`);
    }
  }

  // ── verification, on a connection that did none of the writing ───────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    log('');
    log('=== VERIFIED ON A FRESH CONNECTION ===');
    let held = 0;
    for (const b of applied) {
      const want = multiset(b.target);
      if (b.soDoc) {
        const rows = await check`SELECT item_code AS code, jsonb_typeof(variants) AS vt, remark
                                   FROM scm.mfg_sales_order_items
                                  WHERE doc_no = ${b.soDoc} AND item_group = 'sofa'`;
        const got = multiset(rows.map((r) => r.code));
        const shapes = [...new Set(rows.map((r) => r.vt))];
        const left = rows.filter((r) => /SOFA UNPARSED/.test(String(r.remark ?? ''))).length;
        const ok = got === want && shapes.every((s) => s === 'object') && left === 0;
        (ok ? log : bad)(`  ${b.soDoc}: pieces ${got} ${ok ? '==' : '!='} ${want}; variants ${shapes.join('/')}; placeholders left ${left}`);
        if (ok) held++;
      }
      if (b.poId) {
        const rows = await check`SELECT item_code AS code, jsonb_typeof(variants) AS vt, notes, so_item_id::text AS so_item_id
                                   FROM scm.purchase_order_items
                                  WHERE purchase_order_id = ${b.poId} AND item_group = 'sofa'`;
        const got = multiset(rows.map((r) => r.code));
        const shapes = [...new Set(rows.map((r) => r.vt))];
        const left = rows.filter((r) => /SOFA UNPARSED/.test(String(r.notes ?? ''))).length;
        const dedicated = rows.filter((r) => r.so_item_id).length;
        const ok = got === want && shapes.every((s) => s === 'object') && left === 0;
        (ok ? log : bad)(`  ${b.poId}: pieces ${got} ${ok ? '==' : '!='} ${want}; variants ${shapes.join('/')}; placeholders left ${left}; dedicated ${dedicated}/${rows.length}`);
      }
      const totals = {
        so: b.soDoc ? String((await check`SELECT COALESCE(SUM(total_sen),0)::bigint AS t FROM scm.mfg_sales_order_items WHERE doc_no = ${b.soDoc}`)[0].t) : null,
        po: b.poId ? String((await check`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.purchase_order_items WHERE purchase_order_id = ${b.poId}`)[0].t) : null,
      };
      if (totals.so !== b.totalBefore.so || totals.po !== b.totalBefore.po) {
        bad(`  ${b.label}: the total READS BACK different — order ${b.totalBefore.so} -> ${totals.so}, purchase ${b.totalBefore.po} -> ${totals.po}`);
      }
    }
    log(`  builds applied ${applied.length} of ${builds.length}; sales-order shapes verified ${held}`);
    log('  Counts above are this run\'s. Re-run the read-only probe for the population.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.stack || e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
