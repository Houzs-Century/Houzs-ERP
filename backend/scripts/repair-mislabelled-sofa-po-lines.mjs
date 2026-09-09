#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Re-file the sofa purchase lines the importer wrote as `others` — onto the
// compartments the sales order they were raised from already holds.
//
// WHAT WENT WRONG (traced, docs/bugs — "the sofa purchase line was filed as
// others"). The SO-linked purchase-order importer asked the catalogue about the
// MAPPED code (`5540-1S`) before folding it through SOFA_MODEL_ALIAS
// (5540 -> 8030). No 5540 code has ever existed in the catalogue, so the group
// came back as `others`, the sofa decomposition — which only runs on `sofa` —
// was skipped, and the row landed on the aliased placeholder `8030-1S` with NO
// `SOFA UNPARSED` marker, because nothing had failed to parse: the decoder was
// never asked. The importer has since been fixed (the alias fold, docs/bugs/0577
// and 0686); the rows it wrote before that are what this repairs.
//
// WHY IT MATTERS. Every reader that turns a purchase line into stock or into a
// dedication selects `item_group = 'sofa'`:
//   - import-ac-sofa-stock.mjs never sees the line, so no stock lot is opened
//     for the build even though AutoCount received it;
//   - the sales-order side DID decompose (its lane folds the alias first), so
//     the order holds `8030-2A(LHF)` + `8030-1A(RHF)` with no purchase line
//     dedicated to either — PENDING forever, and the Delivery Order is refused
//     at the sofa batch guard with "no live supplier PO linked".
//   - redecode-collapsed-sofa-lines.mjs cannot reach it either: it selects
//     `sofa` + the marker, and refuses any build with a goods-receipt line.
// Measured on production 2026-09-08: 14 such lines on 14 purchase orders, every
// one an HOK-5530/5536/5537/5540 alias model, every one RECEIVED with exactly one
// migrated goods-receipt line and zero inventory movements. 9 of their sales
// orders are open with the staff note READY; the first customer date is
// 2026-09-09 (HC-SO-012565).
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────
//   THE SALES ORDER IS THE SOURCE. The book links the purchase line to its
//   sales line by PODTL.FromSODtlKey (both exports carry it; the ERP carries the
//   purchase key in linked_ac_dtlkey and the sales key on every compartment of
//   the order). The order's compartments, in line order, become the purchase
//   line's pieces — and only when the purchase text, read by the SAME decoder,
//   says the same pieces in the same order (or is the same text). The variants
//   are COPIED off the sales compartment, never recomputed, so the stock lot the
//   sofa import later opens lands in the bucket the allocator reads for that
//   order line.
//
//   MATCH AND UPDATE IN PLACE, NEVER DROP AND RE-INSERT. The existing purchase
//   row is RE-CODED as the first piece, filed as `sofa`, dedicated to the first
//   sales compartment; the remaining pieces are INSERTed beside it, each
//   dedicated to the sales compartment carrying the same code. Nothing is ever
//   deleted (owner: 不可以删只可以 cancel).
//
//   THE GOODS RECEIPT SPLITS WITH THE LINE (owner 2026-08-11: 全部有联动性的文件
//   都是一起换的, the precedent is split-collapsed-sofa-lines.mjs). Only a
//   migrated_no_stock receipt with ZERO inventory movements — paperwork, so no
//   stock can move. Each receipt piece points at its purchase piece.
//
//   THE MONEY DOES NOT MOVE BY ONE CENT. The re-coded rows have no money column
//   written; every inserted piece carries 0 in every `%_sen` column. Purchase
//   total and receipt total are summed before and after INSIDE the transaction
//   and the build is rolled back if either moved.
//
//   A BUILD WHOSE DELIVERY HAS MOVED IS REFUSED. A delivery-order line against
//   any of the sales compartments and the build is reported and left alone: its
//   sofa has left, and opening stock for it would put a delivered sofa back on
//   the shelf. (5 of the 14 on 2026-09-08.)
//
// AFTER THIS, TWO EXISTING WORKFLOWS FINISH THE JOB, and neither is claimed
// here to have been run: `Import AutoCount sofa stock` opens the lots for the
// now-visible builds (capped by the AutoCount balance, as always), and the
// allocation recompute binds the batch so the lines read READY.
//
// ── SAFETY ─────────────────────────────────────────────────────────────────
//   MODE=plan is the default and writes nothing. MODE=apply needs
//   CONFIRM="I HAVE REVIEWED THE DRY-RUN". Every build is its own transaction.
//   The verification re-reads on a FRESH connection and asserts the SHAPE — the
//   piece multiset on the purchase order and on the receipt, that every piece
//   is filed `sofa`, dedicated to a distinct sales compartment, carries a jsonb
//   OBJECT for variants, and that the totals read back unchanged — never a row
//   count (docs/jsonb-double-encoding-coe.md).
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        the phrase above, on apply
//   COMPANY        default 1 (Houzs Century)
//   DOC            optional — one purchase-order number (ERP or AutoCount), to
//                  rehearse a single build
//
// RE-RUN: inert. A corrected row is filed `sofa` and no longer sits on the bare
// `-1S`, so the second run does not select it at all; a build it refused is
// refused again for the same reason.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { SOFA_MODEL_ALIAS, parseSofa } from './lib/parse-sofa.mjs';
import { buildFabricColourIndex } from './lib/fabric-colour-match.mjs';
import { loadAcBinding } from './lib/ac-stock-compare.mjs';
import { buildCloneInsert, canonicaliser, compartmentOfVerbatim, modelOf, multiset } from './lib/redecode-sofa-plan.mjs';
import { acSofaItemOfSku, isMislabelledSofaPoLine, planMislabelledBuild } from './lib/mislabelled-sofa-po-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 1);
const ONLY = (process.env.DOC || '').trim().toUpperCase().replace(/^HC-/, '');
/* Correcting a build whose goods already shipped is a change to HISTORY, so it
   is never inherited by silence: unset, every delivered build is refused, which
   is what this script did from the day it was written. The owner turned it on
   for five named purchase orders on 2026-09-09 (see the gate's own comment in
   lib/mislabelled-sofa-po-plan.mjs). Pair it with DOC= so it applies to the
   document you meant and not to every delivered build in the company. */
const ALLOW_DELIVERED = process.env.ALLOW_DELIVERED === '1';
const STAMP = new Date().toISOString().slice(0, 10);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const K = (s) => String(s ?? '').trim().toUpperCase();
const oneLine = (s) => String(s ?? '').replace(/\r/g, '').replace(/\n/g, '\\n').replace(/[ \t]+/g, ' ').trim();
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^\uFEFF/, ''));

async function insertableColumns(client, table) {
  const rows = await client`
    SELECT column_name, is_generated, identity_generation
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}
     ORDER BY ordinal_position`;
  if (!rows.length) throw new Error(`scm.${table} has no columns in information_schema — wrong database?`);
  return rows.filter((r) => r.is_generated !== 'ALWAYS' && r.identity_generation === null).map((r) => r.column_name);
}

async function main() {
  log(`re-file the mislabelled sofa purchase lines — mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}${ONLY ? ` DOC=${ONLY}` : ''}`);

  // ── the book's own edge: purchase line key -> sales line key ─────────────
  // Both exports carry PODTL.DtlKey and FromSODtlKey. The SO-linked lane is the
  // newer cut; the fidelity lines cover the documents that had already been
  // received in full when that lane was exported and so fell out of it.
  const soKeyByPoKey = new Map();
  const acDocByPoKey = new Map();
  for (const f of ['ac-so-linked-pos.json.gz', 'ac-fidelity-po-lines.json.gz']) {
    for (const r of gz(f)) {
      if (r.DtlKey == null || r.FromSODtlKey == null) continue;
      if (!soKeyByPoKey.has(Number(r.DtlKey))) {
        soKeyByPoKey.set(Number(r.DtlKey), Number(r.FromSODtlKey));
        acDocByPoKey.set(Number(r.DtlKey), r.DocNo);
      }
    }
  }
  log(`book edges (purchase line -> sales line): ${soKeyByPoKey.size}`);

  const { sofaFurniture } = loadAcBinding(fs.readFileSync(path.join(here, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8'));
  log(`binding: ${sofaFurniture.size} AutoCount items in the SOFA category`);

  // ── masters ──────────────────────────────────────────────────────────────
  const prods = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  const nameOf = new Map(prods.map((p) => [K(p.code), p.name]));
  const codeSet = new Set(prods.map((p) => K(p.code)));
  const canonical = canonicaliser(prods.map((p) => p.code));
  const RECL = ['-1S(R)', '-1A(R)(LHF)', '-1A(P)(LHF)', '-1S(P)'];
  const reclOf = (m) => RECL.some((s) => codeSet.has(K(m + s)));
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  const poCols = await insertableColumns(sql, 'purchase_order_items');
  const grnCols = await insertableColumns(sql, 'grn_items');
  log(`masters: ${codeSet.size} product codes, ${fcRows.length} fabric colours; clone shape: purchase line ${poCols.length} columns, receipt line ${grnCols.length} columns`);

  // ── the population ──────────────────────────────────────────────────────
  const candidates = await sql`
    SELECT i.id::text AS id, p.id::text AS po_id, p.po_number AS doc, p.linked_ac_docno AS ac_doc,
           p.status::text AS po_status, i.item_code AS code, i.item_group AS grp, i.supplier_sku,
           i.qty, i.received_qty, i.so_item_id::text AS so_item_id, i.linked_ac_dtlkey AS key,
           i.description2 AS d2, i.notes, i.variants, i.warehouse_id::text AS warehouse_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO}
       AND i.item_code ~* '-1S$'
       AND LOWER(COALESCE(i.item_group, '')) <> 'sofa'
       AND i.supplier_sku IS NOT NULL
     ORDER BY p.po_number`;
  const rows = candidates.filter((r) => isMislabelledSofaPoLine({ itemCode: r.code, itemGroup: r.grp, supplierSku: r.supplier_sku }, sofaFurniture));
  log(`bare -1S purchase lines not filed as sofa: ${candidates.length}; of those on a SOFA-category AutoCount item: ${rows.length}`);

  const refusals = [];
  const builds = [];
  for (const r of rows) {
    const docs = [r.doc, r.ac_doc].filter(Boolean);
    if (ONLY && !docs.some((d) => K(d).replace(/^HC-/, '') === ONLY)) continue;
    const label = `${r.doc} (${r.ac_doc ?? 'no AutoCount doc'}) ${r.code} <- ${r.supplier_sku}`;
    const refuse = (why) => refusals.push({ label, why });
    if (K(r.po_status) === 'CANCELLED') { refuse('the purchase order is cancelled'); continue; }
    const key = r.key == null ? null : Number(r.key);
    if (key == null) { refuse('the purchase line carries no AutoCount line key, so the book cannot name its sales line'); continue; }
    const soKey = soKeyByPoKey.get(key);
    if (soKey == null) { refuse(`neither export carries purchase line key ${key}`); continue; }

    const soLines = await sql`
      SELECT i.id::text AS id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp, i.remark,
             i.cancelled, i.line_no, i.description2 AS d2, i.variants, i.qty,
             h.status::text AS so_status
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ${soKey}
       ORDER BY i.doc_no, i.line_no`;
    const soDocs = [...new Set(soLines.map((l) => l.doc))];
    if (soDocs.length > 1) { refuse(`sales key ${soKey} resolves to ${soDocs.length} orders (${soDocs.join(', ')})`); continue; }
    const so = soLines.length
      ? {
        doc: soDocs[0],
        cancelled: K(soLines[0].so_status) === 'CANCELLED',
        lines: soLines.map((l) => ({ id: l.id, code: l.code, group: l.grp, remark: l.remark, cancelled: l.cancelled, lineNo: l.line_no, d2: l.d2, variants: l.variants })),
      }
      : null;
    const soIds = (so?.lines ?? []).map((l) => l.id);
    const doLines = soIds.length
      ? Number((await sql`SELECT COUNT(*)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ANY(${soIds}::uuid[])`)[0].n)
      : 0;
    const grns = await sql`
      SELECT gi.id::text AS id, gi.grn_id::text AS grn_id, g.grn_number AS doc, g.migrated_no_stock AS migrated,
             (SELECT COUNT(*)::int FROM scm.inventory_movements m
               WHERE m.source_doc_id::text = g.id::text OR m.source_doc_no = g.grn_number) AS movements
        FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
       WHERE gi.purchase_order_item_id = ${r.id}::uuid`;

    const model = modelOf(r.code, SOFA_MODEL_ALIAS);
    const decoded = parseSofa(r.d2, model, reclOf(model), { knownColour });
    const plan = planMislabelledBuild({
      po: { doc: r.doc, code: r.code, qty: r.qty, soItemId: r.so_item_id, d2: r.d2, model },
      so, grns: grns.map((g) => ({ doc: g.doc, migrated: g.migrated, movements: g.movements })), doLines, decoded, codeSet, canonical,
      allowDelivered: ALLOW_DELIVERED,
    });
    if (plan.kind === 'refuse') { refuse(plan.why); continue; }
    builds.push({ label, row: r, so, grns, target: plan.target, model, acItem: acSofaItemOfSku(r.supplier_sku, sofaFurniture) });
  }

  // ── the plan, in full ───────────────────────────────────────────────────
  log('');
  log(`=== ${builds.length} BUILD(S) THE BOOK LINKS TO A DECODED SALES ORDER ===`);
  let nUpd = 0, nIns = 0, nGrnUpd = 0, nGrnIns = 0;
  for (const b of builds) {
    log(`  ${b.label}  ->  ${b.so.doc}  [${b.model}]  ${b.target.map((t) => t.code).join(' + ')}`);
    log(`     purchase text ${JSON.stringify(oneLine(b.row.d2))}`);
    log(`     re-code  ${b.row.code} -> ${b.target[0].code}   item_group others -> sofa   dedicated to ${b.so.doc} line ${b.target[0].code}   (money untouched)`);
    nUpd++;
    for (const t of b.target.slice(1)) { log(`     insert   ${t.code}   dedicated to ${b.so.doc} line ${t.code}   (every money column 0)`); nIns++; }
    for (const g of b.grns) {
      log(`     receipt ${g.doc} (migrated, ${g.movements} movements): re-code -> ${b.target[0].code}; insert ${b.target.slice(1).map((t) => t.code).join(', ') || '(nothing)'}`);
      nGrnUpd++; nGrnIns += b.target.length - 1;
    }
  }
  log('');
  log(`purchase lines re-coded ${nUpd} · inserted ${nIns} · receipt lines re-coded ${nGrnUpd} · inserted ${nGrnIns} · deletions 0`);
  log('');
  log(`=== ${refusals.length} LINE(S) REFUSED ===`);
  for (const r of refusals) bad(`  ${r.label} — ${r.why}`);

  if (!APPLY) {
    log('');
    log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── apply, one transaction per build ────────────────────────────────────
  log('');
  log(`=== APPLYING ${builds.length} BUILD(S) ===`);
  const applied = [];
  const poIns = buildCloneInsert({
    table: 'scm.purchase_order_items',
    columns: poCols,
    overrides: { item_code: null, item_group: null, material_name: null, supplier_sku: null, variants: 'text::jsonb', notes: null, so_item_id: 'uuid' },
  });
  const grnIns = buildCloneInsert({
    table: 'scm.grn_items',
    columns: grnCols,
    overrides: { item_code: null, item_group: null, material_name: null, supplier_sku: null, variants: 'text::jsonb', purchase_order_item_id: 'uuid' },
  });
  for (const b of builds) {
    try {
      const receipt = await sql.begin(async (tx) => {
        const grnIds = [...new Set(b.grns.map((g) => g.grn_id))];
        const totals = async () => ({
          po: String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.purchase_order_items WHERE purchase_order_id = ${b.row.po_id}::uuid`)[0].t),
          grn: grnIds.length ? String((await tx`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.grn_items WHERE grn_id = ANY(${grnIds}::uuid[])`)[0].t) : '0',
        });
        const before = await totals();
        /* Re-asserted inside the transaction, not trusted from the plan: a
           receipt that has grown a movement since the plan was read is a
           different receipt. */
        for (const g of b.grns) {
          const [{ n }] = await tx`SELECT COUNT(*)::int AS n FROM scm.inventory_movements m WHERE m.source_doc_id::text = ${g.grn_id} OR m.source_doc_no = ${g.doc}`;
          if (Number(n) > 0) throw new Error(`${g.doc} now carries ${n} inventory movement(s)`);
        }
        const [{ n: dn }] = await tx`SELECT COUNT(*)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ANY(${b.target.map((t) => t.soItemId)}::uuid[])`;
        if (Number(dn) > 0) throw new Error(`${b.so.doc} now carries ${dn} delivery-order line(s)`);

        const notes = `${b.row.notes ? b.row.notes + ' | ' : ''}sofa: re-filed from the alias placeholder ${b.row.code} ${STAMP} (importer filed it as others; pieces are ${b.so.doc}'s own)`;
        const skuOf = (code) => `${b.row.supplier_sku} ${compartmentOfVerbatim(code)}`;
        const varOf = (t) => JSON.stringify(t.variants && typeof t.variants === 'object' && !Array.isArray(t.variants) ? t.variants : {});
        const [first, ...rest] = b.target;
        await tx`UPDATE scm.purchase_order_items
                    SET item_code = ${first.code}, item_group = 'sofa',
                        material_name = ${nameOf.get(K(first.code)) ?? first.code},
                        supplier_sku = ${skuOf(first.code)},
                        variants = ${varOf(first)}::text::jsonb, notes = ${notes},
                        so_item_id = ${first.soItemId}::uuid
                  WHERE id = ${b.row.id}::uuid`;
        const poPieceId = new Map([[K(first.code), b.row.id]]);
        for (const t of rest) {
          const bind = {
            item_code: t.code, item_group: 'sofa', material_name: nameOf.get(K(t.code)) ?? t.code,
            supplier_sku: skuOf(t.code), variants: varOf(t), notes, so_item_id: t.soItemId,
          };
          const [row] = await tx.unsafe(poIns.text, [b.row.id, ...poIns.params.map((p) => bind[p])]);
          poPieceId.set(K(t.code), row.id);
        }
        for (const g of b.grns) {
          await tx`UPDATE scm.grn_items
                      SET item_code = ${first.code}, item_group = 'sofa',
                          material_name = ${nameOf.get(K(first.code)) ?? first.code},
                          supplier_sku = ${skuOf(first.code)},
                          variants = ${varOf(first)}::text::jsonb
                    WHERE id = ${g.id}::uuid`;
          for (const t of rest) {
            const bind = {
              item_code: t.code, item_group: 'sofa', material_name: nameOf.get(K(t.code)) ?? t.code,
              supplier_sku: skuOf(t.code), variants: varOf(t), purchase_order_item_id: poPieceId.get(K(t.code)),
            };
            await tx.unsafe(grnIns.text, [g.id, ...grnIns.params.map((p) => bind[p])]);
          }
        }
        const after = await totals();
        if (before.po !== after.po) throw new Error(`the purchase-order total moved ${before.po} -> ${after.po}`);
        if (before.grn !== after.grn) throw new Error(`the goods-receipt total moved ${before.grn} -> ${after.grn}`);
        return { ...b, before, grnIds, poPieceIds: [...poPieceId.values()] };
      });
      applied.push(receipt);
      log(`  OK ${b.label} — totals held (purchase ${receipt.before.po}, receipt ${receipt.before.grn})`);
    } catch (e) {
      bad(`  ROLLED BACK ${b.label} — ${e.message}`);
    }
  }

  // ── verification, on a connection that did none of the writing ─────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    log('');
    log('=== VERIFIED ON A FRESH CONNECTION ===');
    let held = 0;
    for (const b of applied) {
      const want = multiset(b.target.map((t) => t.code));
      const wantSo = multiset(b.target.map((t) => t.soItemId));
      const po = await check`SELECT id::text AS id, item_code AS code, item_group AS grp, jsonb_typeof(variants) AS vt, so_item_id::text AS so_item_id
                               FROM scm.purchase_order_items WHERE id = ANY(${b.poPieceIds}::uuid[])`;
      const gotPo = multiset(po.map((r) => r.code));
      const gotSo = multiset(po.map((r) => r.so_item_id));
      const poOk = gotPo === want && gotSo === wantSo && po.every((r) => r.grp === 'sofa' && r.vt === 'object' && !/-1S$/i.test(r.code));
      (poOk ? log : bad)(`  ${b.row.doc}: pieces ${gotPo} ${poOk ? '==' : '!='} ${want}; dedicated ${gotSo === wantSo ? 'to each compartment' : 'WRONG ' + gotSo}; groups ${[...new Set(po.map((r) => r.grp))].join('/')}; variants ${[...new Set(po.map((r) => r.vt))].join('/')}`);
      let grnOk = true;
      for (const gid of b.grnIds) {
        const gr = await check`SELECT item_code AS code, item_group AS grp, jsonb_typeof(variants) AS vt, purchase_order_item_id::text AS po_item
                                 FROM scm.grn_items WHERE grn_id = ${gid}::uuid AND purchase_order_item_id = ANY(${b.poPieceIds}::uuid[])`;
        const got = multiset(gr.map((r) => r.code));
        const distinct = new Set(gr.map((r) => r.po_item)).size === gr.length;
        const ok = got === want && distinct && gr.every((r) => r.grp === 'sofa' && r.vt === 'object');
        grnOk = grnOk && ok;
        (ok ? log : bad)(`     receipt: pieces ${got} ${ok ? '==' : '!='} ${want}; each piece on its own purchase piece ${distinct}`);
      }
      const totals = {
        po: String((await check`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.purchase_order_items WHERE purchase_order_id = ${b.row.po_id}::uuid`)[0].t),
        grn: b.grnIds.length ? String((await check`SELECT COALESCE(SUM(line_total_sen),0)::bigint AS t FROM scm.grn_items WHERE grn_id = ANY(${b.grnIds}::uuid[])`)[0].t) : '0',
      };
      const totalsOk = totals.po === b.before.po && totals.grn === b.before.grn;
      if (!totalsOk) bad(`  ${b.label}: the total READS BACK different — purchase ${b.before.po} -> ${totals.po}, receipt ${b.before.grn} -> ${totals.grn}`);
      if (poOk && grnOk && totalsOk) held++;
    }
    log(`  builds applied ${applied.length} of ${builds.length}; shapes verified ${held}`);
    log('  Next, and NOT run by this script: Import AutoCount sofa stock (opens the lots), then the allocation recompute.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.stack || e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
