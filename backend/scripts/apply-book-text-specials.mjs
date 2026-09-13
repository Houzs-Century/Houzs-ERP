#!/usr/bin/env node
// Carry the options the LINE'S OWN book text asks for onto all six documents —
// the headboard covering, the divan covering, the drawer, the nylon, the
// backrest — and move the stock with the line wherever goods are already in.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE ASK (owner, 2026-09-12): 「你顺便看完 HB FULLY COVER 的东西，也是顺便标选
// HB FULLY COVER，就是全部 special。你能尽量补齐的，就尽量补齐」 — after
// 「SO PO GR DO SI PI 全部」 and 「它历史全部都要补齐到完」.
//
// WHY A SECOND SOURCE. `apply-supplier-specials.mjs` carries what the SUPPLIER
// states, and it can only reach the 375 documents the supplier export names.
// Every other order — the ones the export does not cover, the pre-cutover ones,
// the ones another factory built — states its options in its OWN book text, and
// that text is already in the system on three columns:
//
//     HB FULL COVERED / COL:KIV / DIVAN8+0 with side drawer / GAP:12
//     Leftside Drawer / HeadBoard Straight / Divan:8"+No Leg / Gap:14"
//
// Nothing here re-reads a slip or a photo. It reads what the line already says.
//
// THE DECODER IS NOT NEW. `lib/special-order-phrase-mapper.mjs` (31 families,
// each carrying the owner ruling that created it) turns that text into LIVE
// picker codes, and it is the same module `backfill-specials-into-variants.mjs`
// used. What is new is THREE things that backfill did not do:
//
//   1. it stopped at the SALES line. The purchase order, the receipt, the
//      delivery note and both invoices kept saying nothing, which is exactly the
//      complaint — a service case reads the delivery note, not the sales order.
//   2. it HELD BACK any option carrying a price (SKIP_PRICED: 338 lines held).
//      Owner 2026-09-12: 「我们的卖价都是跟着 salesprice 去放的，所以没有影响卖价。
//      你不需要理那个 selling points 的，你只需要看我们的 maintenance variant
//      那些而已」 — the spec is the point, the charge is not. Nothing is held back
//      here, and no price column is touched by this tool at all.
//   3. it did not move the STOCK. `specials` composes computeVariantKey.
//
// THE CHAIN CONVERGES. The owner's rule 「整条流程看到的都要一样」: the option set
// written is the UNION of what the chain already carries and what the text asks
// for, written to every line of that chain, so the sales order, the purchase
// order, the receipt, the delivery note and the invoices stop disagreeing.
//
// IT ADDS. The ONE removal it makes is the drawer, and only when the text names
// a HAND: a line whose book text says `Leftside Drawer` while the line carries
// `Front Drawer` is the defect of docs/bugs/0824, and keeping both would put two
// contradictory drawers on one bed. A drawer whose hand nobody stated is left
// exactly as it is and reported — the catalogue has no neutral drawer, so
// guessing a hand there would be inventing a spec.
//
// THE STOCK MOVES WITH THE LINE. Where goods are already in, the chain's rows in
// inventory_lots / inventory_movements / inventory_lot_consumptions are re-keyed
// in the SAME transaction. A bucket shared with a document OUTSIDE the chain is
// refused and named: docs/bugs/0722 is what that refusal exists to avoid.
//
// RE-RUN: convergent. A chain already carrying its text's options produces no
// plan entry on the next run.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: CARRY THE BOOK TEXT OPTIONS
//   LIMIT          optional, cap the number of chains written (default all)
//   Run under tsx for the TS import:
//     npx tsx scripts/apply-book-text-specials.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import {
  loadPhraseMap, buildLiveIndex, classifyLine, K,
} from './lib/special-order-phrase-mapper.mjs';

const CONFIRM_PHRASE = 'CARRY THE BOOK TEXT OPTIONS';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Number(process.env.LIMIT || 0);
const LABEL = '账本原文:';
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

/* The drawer family is the only one this tool is allowed to DISPLACE: a bed
   whose text or ruling names a hand must not also keep the other hand.
   They are not strictly exclusive, though — a PAIR is legitimate, one drawer on
   each side, and the owner confirmed HC-SO-013353 is exactly that on 2026-09-13
   (「1 right+left」). So a ruling may name more than one, and only the drawers
   NOT wanted are removed. */
const DRAWERS = ['Left Drawer', 'Right Drawer', 'Front Drawer'];
const isDrawer = (c) => DRAWERS.some((d) => K(d) === K(c));

const norm = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();
const objOf = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : null);

/** The owner's rulings and the slip PHOTOS, read into two lookups.
 *  These OUTRANK the line's own text: a slip that says only "side drawer" has
 *  no hand in its words, and the drawing or the owner is the only place the
 *  answer exists. `data/drawer-side-owner-rulings.json` carries the evidence for
 *  every entry and the reading convention they all apply. */
function loadRulings() {
  const raw = JSON.parse(fs.readFileSync(path.join(here, 'data', 'drawer-side-owner-rulings.json'), 'utf8'));
  const drawer = new Map();
  for (const r of raw.rulings ?? []) drawer.set(`${r.doc}|${K(r.itemCode)}`, r);
  const extras = new Map();
  for (const p of raw.photoSpecials ?? []) {
    const cur = extras.get(p.doc) ?? [];
    for (const a of p.add ?? []) if (!cur.some((x) => K(x) === K(a))) cur.push(a);
    extras.set(p.doc, cur);
  }
  return { drawer, extras, unresolved: raw.unresolved ?? [] };
}

function loadSnapshot() {
  try {
    const p = path.join(here, 'data', 'ac-line-desc2.json.gz');
    const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    const so = new Map();
    for (const [k, v] of Object.entries(parsed.so ?? {})) so.set(Number(k), String(v ?? ''));
    return { ok: true, so, exportedAt: parsed.exportedAt ?? '?' };
  } catch (e) { return { ok: false, so: new Map(), reason: e.message }; }
}

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('BOOK TEXT OPTIONS — carry what OUR OWN line says onto all six documents');
  line('='.repeat(78));
  const snap = loadSnapshot();
  line(snap.ok
    ? `   book snapshot: ${snap.so.size} sales Desc2 values, exported ${snap.exportedAt}`
    : `   book snapshot UNREADABLE (${snap.reason}) — that source reads 0. A gap, not a zero.`);
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  const addons = await sql`
    SELECT code, label, categories, selling_price_sen, cost_price_sen
      FROM scm.special_addons WHERE company_id = ${CO}`;
  const { liveByCat } = buildLiveIndex(addons);
  const map = loadPhraseMap();
  line(`   catalogue options for this company: ${addons.length}`
    + `   (sofa ${liveByCat.get('SOFA').size}, bedframe ${liveByCat.get('BEDFRAME').size} lookup entries)`);

  /* Self-test the decoder on REAL production wordings before reporting anything.
     A decoder that cannot match must never read as "nothing to do". */
  {
    const decode = (grp, code, text) => classifyLine(
      { grp, code, d2: text, variants: {} }, map, liveByCat).gained.map(String);
    const cases = [
      ['bedframe', 'JAGER-(Q)', 'HB FULL COVERED / COL:KIV/DIVAN8+0 with side drawer/GAP:12', 'HB Fully Cover', true],
      ['bedframe', 'TRION (A)-(K)', 'Leftside Drawer/HeadBoard Straight/Divan:8"+No Leg/Gap:14"', 'Left Drawer', true],
      ['bedframe', 'TRION (A)-(K)', 'Leftside Drawer/HeadBoard Straight/Divan:8"+No Leg/Gap:14"', 'HB Straight', true],
      ['bedframe', 'CODY-(Q)', 'Divan: 8" no leg/Gap: 12"/Col: PC151-01/add on right side drawer', 'Right Drawer', true],
      ['bedframe', 'X-(K)', 'div:10inch / gap:14inch / Front Drawer, HB Fully Cover', 'Front Drawer', true],
      /* docs/bugs/0824, the direction that MATTERS: a side drawer whose hand
         nobody stated must decode to NOTHING. The catalogue holds only
         Front/Left/Right, and filing an unstated hand as Front is the defect
         this whole round exists to undo. Caught live on 2026-09-12 — the
         parser had been fixed, the phrase map had not. */
      ['bedframe', 'FENRIR-(Q)', 'sidedrawer/PC151-01/divan10/gap12', 'Front Drawer', false],
      ['bedframe', 'JAGER-(Q)', 'HB FULL COVERED / COL:KIV/DIVAN8+0 with side drawer/GAP:12', 'Front Drawer', false],
    ];
    const bad = cases.filter(([g, c, txt, want, expect]) => decode(g, c, txt).some((x) => K(x) === K(want)) !== expect);
    if (bad.length) {
      console.error(`SELF-TEST FAILED — the decoder is wrong on ${bad.length} of ${cases.length} real book wordings.`);
      for (const [, , txt, want, expect] of bad) console.error(`   expected ${expect ? '' : 'NOT '}${want} from: ${txt}`);
      console.error('Refusing to run: a verdict computed over nothing must not read as a pass.');
      process.exit(1);
    }
    line(`   decoder self-test: ${cases.length} real book wordings decode as expected`);
  }

  /* ── the chains ──────────────────────────────────────────────────────────
     Rooted at the SALES line, because that is where the customer's own words
     live and because an order with no purchase order yet still has to be
     right. */
  const soRows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.description2, i.remark,
           i.variants, i.linked_ac_dtlkey,
           lower(coalesce(i.item_group, '')) AS grp
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group, '')) IN ('sofa', 'bedframe')
     ORDER BY i.doc_no, i.line_no`;
  line(`   sofa + bedframe sales lines: ${soRows.length}`);

  const plan = [];
  const stats = { noText: 0, nothingAsked: 0, alreadyRight: 0, arrayShaped: 0 };
  const unmapped = new Map();
  const rulings = loadRulings();
  const ruledMissingCode = [];
  let ruledUsed = 0;
  let photoUsed = 0;
  line(`   owner rulings / photo readings on file: ${rulings.drawer.size} drawer,`
    + ` ${rulings.extras.size} order(s) with a photo-stated option,`
    + ` ${rulings.unresolved.length} still unanswered`);

  for (const r of soRows) {
    const v = objOf(r.variants);
    if (!v) { stats.arrayShaped += 1; continue; }

    const d2 = norm(r.description2);
    const rem = norm(r.remark);
    const idx = rem.lastIndexOf(LABEL);
    const fromRemark = idx === -1 ? '' : norm(rem.slice(idx + LABEL.length));
    const dtl = r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey);
    const fromSnap = dtl == null ? '' : (snap.so.get(dtl) ?? '');
    const text = d2 || fromRemark || fromSnap;
    /* A line with a RULING is never skipped for having no text — the ruling is
       there precisely because the words do not carry the answer. */
    const hasRuling = rulings.drawer.has(`${r.doc_no}|${K(r.item_code)}`) || rulings.extras.has(r.doc_no);
    if (!text && !hasRuling) { stats.noText += 1; continue; }

    const c = classifyLine({ grp: r.grp, code: r.item_code, d2: text, variants: v }, map, liveByCat);
    for (const u of c.unmapped) unmapped.set(u, (unmapped.get(u) ?? 0) + 1);

    /* The ruling and the photo come FIRST, because the line's own words do not
       carry the answer at all — that is why those entries exist. */
    const gained = [...c.gained];
    const ruled = rulings.drawer.get(`${r.doc_no}|${K(r.item_code)}`);
    const cat = r.grp === 'sofa' ? 'SOFA' : 'BEDFRAME';
    const liveCode = (want) => liveByCat.get(cat).get(K(want)) ?? null;
    if (ruled) {
      /* A ruling may name TWO codes. HC-SO-013353's `2 SIDE DRAWER` is a PAIR -
         one drawer on each side - and the owner confirmed it on 2026-09-13
         (「1 right+left」). So `is` is a string OR an array, and every code it
         names is written; the drawer displacement still clears whatever the
         chain carried first, so a pair replaces a single and never doubles up. */
      const want = (Array.isArray(ruled.is) ? ruled.is : [ruled.is]).map((x) => liveCode(x));
      if (want.every(Boolean) && want.length) {
        for (let i = gained.length - 1; i >= 0; i -= 1) if (isDrawer(gained[i])) gained.splice(i, 1);
        for (const code of want) if (!gained.some((x) => K(x) === K(code))) gained.push(code);
        ruledUsed += 1;
      } else {
        const named = Array.isArray(ruled.is) ? ruled.is.join(' + ') : ruled.is;
        ruledMissingCode.push(`${r.doc_no} ${named}`);
      }
    }
    for (const a of (rulings.extras.get(r.doc_no) ?? [])) {
      const code = liveCode(a);
      if (code && !gained.some((x) => K(x) === K(code))) { gained.push(code); photoUsed += 1; }
    }
    c.gained = gained;
    if (!c.gained.length) { stats.nothingAsked += 1; continue; }

    /* The chain: the purchase lines this sales line drives, their receipts,
       this line's delivery notes, and both invoices. */
    const pos = await sql`
      SELECT i.id::text AS id, i.item_code, i.variants,
             lower(coalesce(i.item_group,'')) AS grp,
             p.po_number
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id AND p.company_id = ${CO}
       WHERE i.so_item_id = ${r.id}`;
    const poIds = pos.map((x) => x.id);
    const grn = poIds.length
      ? await sql`SELECT gi.id::text AS id, gi.item_code, gi.variants,
                         lower(coalesce(gi.item_group,'')) AS grp
                    FROM scm.grn_items gi WHERE gi.purchase_order_item_id = ANY(${poIds})`
      : [];
    /* item_code and item_group are selected on the DELIVERY line for the same
       reason they are on the purchase line: the OUT movement a shipment writes
       is bucketed on the DELIVERY line's OWN code and key
       (routes/delivery-orders-mfg.ts:927), which is NOT always the purchase
       line's code — a purchase line names the SUPPLIER's model
       (po-item-code-is-the-suppliers-model). Leaving it out would move the IN
       side of a delivered line and strand its OUT side in the old bucket, which
       is docs/bugs/0722 in the direction that produces a phantom. */
    const dos = await sql`
      SELECT di.id::text AS id, di.item_code, di.variants,
             lower(coalesce(di.item_group,'')) AS grp
        FROM scm.delivery_order_items di WHERE di.so_item_id = ${r.id}`;
    const grnIds = grn.map((x) => x.id);
    const pinv = grnIds.length
      ? await sql`SELECT pi.id::text AS id FROM scm.purchase_invoice_items pi WHERE pi.grn_item_id = ANY(${grnIds})`
      : [];
    const sinv = await sql`SELECT si.id::text AS id FROM scm.sales_invoice_items si WHERE si.so_item_id = ${r.id}`;

    /* What the whole chain already carries, unioned — the convergence rule. */
    const have = [];
    const pushHave = (vv) => {
      const o = objOf(vv) ?? {};
      for (const s of (Array.isArray(o.specials) ? o.specials : [])) {
        const t = String(s).trim();
        if (t && !have.some((x) => K(x) === K(t))) have.push(t);
      }
    };
    pushHave(v);
    for (const p of pos) pushHave(p.variants);
    for (const g of grn) pushHave(g.variants);
    for (const d of dos) pushHave(d.variants);

    /* Every drawer the line is now known to want. More than one is legitimate
       (a pair, one per side); the ones NOT wanted are displaced. */
    const wantDrawers = c.gained.filter((x) => isDrawer(x));
    const next = [];
    const displaced = [];
    for (const x of have) {
      if (wantDrawers.length && isDrawer(x) && !wantDrawers.some((w) => K(w) === K(x))) { displaced.push(x); continue; }
      next.push(x);
    }
    for (const g of c.gained) if (!next.some((x) => K(x) === K(g))) next.push(g);

    const lineAgrees = (vv) => {
      const o = objOf(vv) ?? {};
      const cur = (Array.isArray(o.specials) ? o.specials : []).map(String);
      return cur.length === next.length && next.every((x) => cur.some((y) => K(x) === K(y)));
    };
    const everyLineAgrees = [v, ...pos.map((p) => p.variants), ...grn.map((g) => g.variants), ...dos.map((d) => d.variants)]
      .every(lineAgrees);
    if (everyLineAgrees) { stats.alreadyRight += 1; continue; }

    plan.push({
      doc: r.doc_no, soItemId: r.id, grp: r.grp, itemCode: r.item_code, text,
      have, next, displaced,
      added: next.filter((x) => !have.some((y) => K(x) === K(y))),
      pos, grn, doRows: dos, dos: dos.map((d) => d.id),
      pinv: pinv.map((x) => x.id), sinv: sinv.map((x) => x.id),
      soRow: { item_code: r.item_code, variants: v, grp: r.grp },
    });
  }

  /* ── classify against the stock ledger ─────────────────────────────────── */
  async function stockRows(itemCode, key) {
    const one = async (t) => Number((await sql.unsafe(
      `SELECT count(*)::int AS n FROM scm.${t} WHERE company_id = $1 AND item_code = $2 AND coalesce(variant_key,'') = $3`,
      [CO, itemCode, key]))[0]?.n ?? 0);
    return {
      lots: await one('inventory_lots'),
      movements: await one('inventory_movements'),
      consumptions: await one('inventory_lot_consumptions'),
      untouchable: (await one('warehouse_rack_items')) + (await one('warehouse_rack_movements'))
        + (await one('stock_take_lines')) + (await one('stock_transfer_lines')),
    };
  }
  async function consumersOf(itemCode, group, key) {
    const hits = [];
    const scan = async (table, docCol, joinSql) => {
      const rows = await sql.unsafe(
        `SELECT ${docCol} AS doc, i.id, i.variants FROM scm.${table} i ${joinSql}
          WHERE upper(coalesce(i.item_group, '')) = $1 AND i.item_code = $2`,
        [String(group).toUpperCase(), itemCode]);
      for (const r of rows) if (computeVariantKey(group, r.variants || {}) === key) hits.push({ doc: r.doc, id: String(r.id) });
    };
    await scan('mfg_sales_order_items', 'i.doc_no', `JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = ${CO}`);
    await scan('purchase_order_items', 'p.po_number', `JOIN scm.purchase_orders p ON p.id = i.purchase_order_id AND p.company_id = ${CO}`);
    await scan('grn_items', 'g.grn_number', `JOIN scm.grns g ON g.id = i.grn_id AND g.company_id = ${CO}`);
    await scan('delivery_order_items', 'd.do_number', `JOIN scm.delivery_orders d ON d.id = i.delivery_order_id AND d.company_id = ${CO}`);
    await scan('purchase_invoice_items', 'h.invoice_number', `JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id AND h.company_id = ${CO}`);
    return hits;
  }

  /* Every stock bucket a chain would move. EVERY line of the chain is asked,
     not only the purchase side: the IN movement is bucketed on the receipt
     line's code, the OUT movement on the DELIVERY line's code, and those two
     are not always the same string. Moving one without the other is exactly the
     phantom of docs/bugs/0722. */
  for (const p of plan) {
    p.buckets = [];
    const seen = new Set();
    for (const row of [p.soRow, ...p.pos, ...p.grn, ...p.doRows]) {
      const before = objOf(row.variants) ?? {};
      const grp = row.grp || p.grp;
      const oldKey = computeVariantKey(grp, before);
      const newKey = computeVariantKey(grp, { ...before, specials: p.next });
      if (oldKey === newKey) continue;
      const k = `${row.item_code}|${oldKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      p.buckets.push({ itemCode: row.item_code, grp, oldKey, newKey, rows: await stockRows(row.item_code, oldKey) });
    }
  }

  /* Identities that belong to THIS chain — a bucket shared only with them is
     ours to move. */
  const inPlan = new Map();
  for (const p of plan) {
    for (const b of p.buckets) {
      const k = `${b.itemCode}|${b.oldKey}`;
      const ids = inPlan.get(k) ?? new Set();
      ids.add(p.soItemId);
      for (const x of p.pos) ids.add(x.id);
      for (const x of p.grn) ids.add(x.id);
      for (const x of p.dos) ids.add(x);
      for (const x of p.pinv) ids.add(x);
      for (const x of p.sinv) ids.add(x);
      inPlan.set(k, ids);
    }
  }

  /* ONE BUCKET, TWO ANSWERS — refuse both.
     Two lines can share an item code and an identical OLD key while their texts
     ask for DIFFERENT options: HC-SO-010183 carries two CODY-(Q) beds, same
     divan, same gap, same colour, one drawer left and one right. Their chains
     are separate, so the shared-bucket test above sees only "members of the
     plan" and lets both through — and then the first write moves every lot in
     that bucket to LEFT and the second finds nothing to move, silently filing
     the right-hand bed's stock under the left-hand key.
     Splitting a lot by quantity is a different operation from renaming a key,
     and this tool does not do it. Both are refused and named. */
  const splits = new Map();
  for (const p of plan) {
    for (const b of p.buckets) {
      const k = `${b.itemCode}|${b.oldKey}`;
      const s = splits.get(k) ?? { newKeys: new Set(), rows: b.rows, docs: new Set() };
      s.newKeys.add(b.newKey);
      s.docs.add(p.doc);
      splits.set(k, s);
    }
  }

  const writable = [];
  const refused = [];
  for (const p of plan) {
    let why = null;
    for (const b of p.buckets) {
      if (b.rows.untouchable) { why = `${b.rows.untouchable} row(s) in rack / stock-take / transfer tables this tool does not move (${b.itemCode})`; break; }
      const s = splits.get(`${b.itemCode}|${b.oldKey}`);
      if (s && s.newKeys.size > 1 && (b.rows.lots + b.rows.movements + b.rows.consumptions) > 0) {
        why = `${b.itemCode} would have to SPLIT one stock bucket into ${s.newKeys.size}`
          + ` — ${[...s.docs].slice(0, 4).join(', ')} share it and ask for different options.`
          + ' Splitting a lot by quantity is not a re-key; this needs a person.';
        break;
      }
      if ((b.rows.lots + b.rows.movements + b.rows.consumptions) === 0) continue;
      const mine = inPlan.get(`${b.itemCode}|${b.oldKey}`) ?? new Set();
      const others = (await consumersOf(b.itemCode, b.grp, b.oldKey)).filter((cc) => !mine.has(String(cc.id)));
      if (others.length) { why = `the stock bucket ${b.itemCode} is shared with ${others.length} line(s) outside this chain (${others.slice(0, 4).map((o) => o.doc).join(', ')})`; break; }
    }
    if (why) refused.push({ ...p, why }); else writable.push(p);
  }

  /* ── report ────────────────────────────────────────────────────────────── */
  rule();
  line(`   sales lines with NO book text on any column        ${stats.noText}`);
  line(`   book text asks for no catalogue option             ${stats.nothingAsked}`);
  line(`   chain already carries exactly those options        ${stats.alreadyRight}`);
  line(`   variants not an object (skipped, never coerced)    ${stats.arrayShaped}`);
  line(`   drawer hand taken from an owner ruling / a photo   ${ruledUsed}`);
  line(`   option taken from a slip PHOTO                     ${photoUsed}`);
  line(`   CHAINS TO CHANGE                                   ${plan.length}`);
  line(`   WRITABLE                                           ${writable.length}`);
  line(`   REFUSED                                            ${refused.length}`);
  rule();
  const byAdd = new Map();
  for (const p of writable) for (const a of p.added) byAdd.set(a, (byAdd.get(a) ?? 0) + 1);
  line('   options that would be ADDED:');
  if (!byAdd.size) line('      (none)');
  for (const [k, n] of [...byAdd].sort((a, b) => b[1] - a[1])) line(`      ${String(n).padStart(4)}  ${k}`);
  const byDisp = new Map();
  for (const p of writable) for (const a of p.displaced) byDisp.set(a, (byDisp.get(a) ?? 0) + 1);
  line('   drawers DISPLACED because the line own text names the other hand:');
  if (!byDisp.size) line('      (none)');
  for (const [k, n] of [...byDisp].sort((a, b) => b[1] - a[1])) line(`      ${String(n).padStart(4)}  ${k}`);
  rule();
  let shown = 0;
  for (const p of writable) {
    if (shown >= 40) break;
    shown += 1;
    line(`   ${p.doc.padEnd(15)} ${String(p.itemCode).padEnd(24)} + ${p.added.join(', ') || '(align only)'}`
      + (p.displaced.length ? `   - ${p.displaced.join(', ')}` : '')
      + `   chain: ${p.pos.length} PO, ${p.grn.length} GR, ${p.dos.length} DO, ${p.pinv.length} PI, ${p.sinv.length} SI`
      + `   buckets ${p.buckets.length}`);
  }
  if (writable.length > shown) line(`   ... and ${writable.length - shown} more`);
  rule();
  for (const p of refused.slice(0, 30)) line(`   REFUSED ${p.doc.padEnd(15)} ${String(p.itemCode).padEnd(24)} ${p.why}`);
  if (refused.length > 30) line(`   ... and ${refused.length - 30} more refusals`);
  rule();
  line('   book phrases with NO catalogue option — free-text instructions whose home is');
  line('   the special-order NOTE, never the variant key. Never invented here:');
  for (const [k, n] of [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 20)) line(`      ${String(n).padStart(4)}  ${k}`);
  if (ruledMissingCode.length) {
    rule();
    line('   A RULING NAMES A CODE THIS CATALOGUE DOES NOT HOLD — nothing was written for it:');
    for (const s of ruledMissingCode) line(`      ${s}`);
  }
  rule();
  line('   still UNANSWERED — a side drawer whose hand is in no text, no photo and no ruling.');
  line('   These are left exactly as they are; they need the salesperson or the supplier:');
  for (const u of rulings.unresolved) line(`      ${String(u.doc).padEnd(15)} ${String(u.itemCode ?? '').padEnd(24)} ${u.why}`);

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    const todo = LIMIT > 0 ? writable.slice(0, LIMIT) : writable;
    let docLines = 0;
    let stockMoved = 0;
    for (const p of todo) {
      await sql.begin(async (t) => {
        const bump = async (table, id) => {
          /* A TEXT ARRAY the server turns into jsonb. Never a pre-serialized
             string on a jsonb parameter — postgres.js runs its own
             JSON.stringify over anything typed jsonb and the value lands
             double-encoded (docs/jsonb-double-encoding-coe.md, docs/bugs/0814). */
          const res = await t.unsafe(
            `UPDATE scm.${table}
                SET variants = coalesce(variants, '{}'::jsonb) || jsonb_build_object('specials', to_jsonb($1::text[]))
              WHERE id = $2 AND jsonb_typeof(coalesce(variants, '{}'::jsonb)) = 'object'`,
            [p.next, id]);
          if (Number(res.count ?? 0) === 0) throw new Error(`${table} ${id}: variants is not an object`);
          docLines += 1;
        };
        await bump('mfg_sales_order_items', p.soItemId);
        for (const x of p.pos) await bump('purchase_order_items', x.id);
        for (const x of p.grn) await bump('grn_items', x.id);
        for (const x of p.dos) await bump('delivery_order_items', x);
        for (const x of p.pinv) await bump('purchase_invoice_items', x);
        for (const x of p.sinv) await bump('sales_invoice_items', x);
        for (const b of p.buckets) {
          for (const table of ['inventory_lots', 'inventory_movements', 'inventory_lot_consumptions']) {
            const res = await t.unsafe(
              `UPDATE scm.${table} SET variant_key = $1
                WHERE company_id = $2 AND item_code = $3 AND coalesce(variant_key,'') = $4`,
              [b.newKey, CO, b.itemCode, b.oldKey]);
            stockMoved += Number(res.count ?? 0);
          }
        }
      });
    }
    line(`APPLIED — ${docLines} document line(s) over ${todo.length} chain(s), ${stockMoved} stock row(s) re-keyed.`);

    /* VERIFY on a FRESH connection, asserting the SHAPE. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const bad = [];
      for (const p of todo) {
        const [row] = await check`SELECT variants FROM scm.mfg_sales_order_items WHERE id = ${p.soItemId}`;
        const vv = objOf(row?.variants);
        if (!vv) { bad.push(`${p.doc}: variants is not an object`); continue; }
        const now = Array.isArray(vv.specials) ? vv.specials.map(String) : null;
        if (now === null) { bad.push(`${p.doc}: specials is not an array`); continue; }
        const missed = p.next.filter((x) => !now.some((y) => K(x) === K(y)));
        const extra = now.filter((y) => !p.next.some((x) => K(x) === K(y)));
        if (missed.length || extra.length) bad.push(`${p.doc}: missing ${missed.join(', ') || '-'} / extra ${extra.join(', ') || '-'}`);
        for (const b of p.buckets) {
          const left = Number((await check.unsafe(
            `SELECT count(*)::int AS n FROM scm.inventory_lots WHERE company_id=$1 AND item_code=$2 AND coalesce(variant_key,'')=$3`,
            [CO, b.itemCode, b.oldKey]))[0]?.n ?? 0);
          if (left) bad.push(`${p.doc} ${b.itemCode}: ${left} lot(s) left in the old bucket`);
        }
      }
      if (bad.length) { line(`VERIFY FAILED — ${bad.length}: ${bad.slice(0, 8).join(' · ')}`); process.exitCode = 1; }
      else line(`VERIFY OK — ${todo.length} chain(s) carry their book text options, re-read on a fresh connection.`);
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
