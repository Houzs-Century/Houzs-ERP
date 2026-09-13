#!/usr/bin/env node
// Fold a legacy SPELLING onto the catalogue code it means, across all six
// documents, and merge the stock buckets that spelling had split.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE ASK (owner, 2026-09-13): 「3 统一nylon」 — answering the measurement that
// 200 raw slip phrases sit in `variants.specials` on 1,491 document lines, of
// which 32 spellings across 595 lines all mean one thing: `Nylon Fabric`.
//
// WHY IT MATTERS, in one sentence: `specials` composes `computeVariantKey`, so
// every spelling is its OWN stock bucket. The same sofa with the same nylon
// bottom is sitting in 32 different buckets, and MRP cannot see it as one thing.
//
// WHAT IT IS NOT. `align-line-specials-to-catalogue.mjs` already does this shape
// of repair and is NOT the tool for this job, for two reasons that are worth
// writing down rather than rediscovering:
//   1. it works from a hand-written allow-list which holds exactly ONE line;
//   2. it has no concept of stock at all — no `inventory_lots`, no
//      `variant_key`, no `computeVariantKey` anywhere in the file. Folding 595
//      lines with it would strand the goods, which is docs/bugs/0722.
// That tool stays as it is: for a single line with no stock it is correct and
// its money guard is stronger than this one's need.
//
// SCOPE IS A FILE, NOT A FLAG. `data/legacy-specials-unify.json` holds the
// families the owner has authorised, with the words he used. A value is folded
// only when BOTH hold: the phrase mapper decodes it to exactly ONE catalogue
// code, and that code is authorised. The list narrows what may be touched; it
// never widens what a rule decides.
//
// THE ORIGINAL WORDS ARE NOT LOST. The slip text lives on `description2` and on
// the `账本原文:` remark, which this tool never touches. What changes is the
// picker value the document renders and the key the stock sits in.
//
// THE STOCK MOVES WITH THE LINE, and the gate is the shared one:
// `lib/spec-chain-guard.mjs`, which refuses a bucket reached from outside the
// chain and refuses a bucket two chains would send to different keys. Both
// refusals were bought on production (docs/bugs/0844) and both are tested.
//
// RE-RUN: convergent. A chain carrying only catalogue codes produces no plan
// entry on the next run.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: FOLD THE LEGACY SPELLINGS
//   LIMIT          optional, cap the number of chains written (default all)
//   Run under tsx for the TS import:
//     npx tsx scripts/unify-legacy-specials.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import { loadPhraseMap, buildLiveIndex, mapPhrase, K } from './lib/special-order-phrase-mapper.mjs';
import { classifyPlans } from './lib/spec-chain-guard.mjs';

const CONFIRM_PHRASE = 'FOLD THE LEGACY SPELLINGS';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Number(process.env.LIMIT || 0);
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
const objOf = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : null);
const specialsOf = (v) => { const o = objOf(v) ?? {}; return Array.isArray(o.specials) ? o.specials.map(String) : []; };

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('LEGACY SPELLINGS — fold them onto the catalogue code, and merge the buckets');
  line('='.repeat(78));
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  const scope = JSON.parse(fs.readFileSync(path.join(here, 'data', 'legacy-specials-unify.json'), 'utf8'));
  const authorised = new Map((scope.authorised ?? []).map((a) => [K(a.code), a]));
  if (!authorised.size) { line('   NOTHING IS AUTHORISED in data/legacy-specials-unify.json. Stopping.'); process.exit(0); }
  line(`   authorised families: ${[...authorised.values()].map((a) => a.code).join(', ')}`);
  for (const a of authorised.values()) line(`      ${a.code} — ${a.by}`);

  const addons = await sql`
    SELECT code, label, categories, selling_price_sen, cost_price_sen
      FROM scm.special_addons WHERE company_id = ${CO}`;
  const { liveByCat } = buildLiveIndex(addons);
  const map = loadPhraseMap();
  const known = new Set(addons.map((a) => K(a.code)));
  for (const k of authorised.keys()) {
    if (!known.has(k)) {
      console.error(`REFUSED: the authorised code "${authorised.get(k).code}" is not in this company's catalogue.`);
      console.error('Nothing was written. A target that does not exist cannot be a target.');
      process.exit(1);
    }
  }

  /** A legacy value -> the authorised codes it means, or [].
   *
   *  A value may genuinely ask for TWO things: `HB & DIVAN BOTTOM FULLY COVER`
   *  decodes to HB Fully Cover AND Divan Full Cover, and that is not ambiguity,
   *  it is what the sentence says. Such a value folds into ALL of its codes —
   *  but ONLY when every one of them is authorised. If even one is not, the
   *  value is left alone: folding it would silently drop the meaning that is out
   *  of scope, which is worse than not folding at all. */
  const foldTo = (value, cat) => {
    if (known.has(K(value))) return [];                    // already a catalogue code
    const hit = mapPhrase(value, liveByCat.get(cat), cat, map);
    if (!hit.length) return [];                            // means no catalogue option
    if (!hit.every((c) => authorised.has(K(c)))) return []; // partially out of scope
    return hit;
  };

  /* Self-test the fold on REAL production spellings, in both directions, before
     reporting anything. A fold that cannot match must never read as "nothing to
     do", and one that matches too much must never read as "all clean". */
  {
    const must = ['Bottom wrap nylon', 'BOTTOM USE UMBRELLA FABRIC', 'Nilon bottom',
      'wrap bottom to Nilon', 'Bttm upgrade to umbrella fabric'];
    const mustNot = ['fully cover', 'Fully Covered To floor no leg', '1 side power slider', 'Nylon Fabric'];
    const bad = [...must.filter((v) => !foldTo(v, 'SOFA').some((c) => K(c) === K('Nylon Fabric'))),
      ...mustNot.filter((v) => foldTo(v, 'SOFA').length > 0)];
    if (bad.length) {
      console.error(`SELF-TEST FAILED on ${bad.length} real spelling(s). Refusing to run.`);
      for (const v of bad) console.error(`   ${v} -> ${JSON.stringify(foldTo(v, 'SOFA'))}`);
      process.exit(1);
    }
    line(`   fold self-test: ${must.length} must-fold and ${mustNot.length} must-NOT-fold spellings all correct`);
  }

  /* ── the chains, rooted at the sales line, exactly as the specials round ── */
  const soRows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.variants,
           lower(coalesce(i.item_group, '')) AS grp
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group, '')) IN ('sofa', 'bedframe')
     ORDER BY i.doc_no, i.line_no`;
  line(`   sofa + bedframe sales lines: ${soRows.length}`);

  const plan = [];
  let untouched = 0;
  const ambiguous = new Map();
  for (const r of soRows) {
    const v = objOf(r.variants);
    if (!v) continue;
    const cat = r.grp === 'sofa' ? 'SOFA' : 'BEDFRAME';

    const pos = await sql`
      SELECT i.id::text AS id, i.item_code, i.variants, lower(coalesce(i.item_group,'')) AS grp, p.po_number
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id AND p.company_id = ${CO}
       WHERE i.so_item_id = ${r.id}`;
    const poIds = pos.map((x) => x.id);
    const grn = poIds.length
      ? await sql`SELECT gi.id::text AS id, gi.item_code, gi.variants, lower(coalesce(gi.item_group,'')) AS grp
                    FROM scm.grn_items gi WHERE gi.purchase_order_item_id = ANY(${poIds})`
      : [];
    const dos = await sql`
      SELECT di.id::text AS id, di.item_code, di.variants, lower(coalesce(di.item_group,'')) AS grp
        FROM scm.delivery_order_items di WHERE di.so_item_id = ${r.id}`;
    const grnIds = grn.map((x) => x.id);
    const pinv = grnIds.length
      ? await sql`SELECT pi.id::text AS id FROM scm.purchase_invoice_items pi WHERE pi.grn_item_id = ANY(${grnIds})`
      : [];
    const sinv = await sql`SELECT si.id::text AS id FROM scm.sales_invoice_items si WHERE si.so_item_id = ${r.id}`;

    /* The chain's union, and the fold applied to it. */
    const have = [];
    for (const vv of [v, ...pos.map((x) => x.variants), ...grn.map((x) => x.variants), ...dos.map((x) => x.variants)]) {
      for (const s of specialsOf(vv)) if (!have.some((x) => K(x) === K(s))) have.push(s);
    }
    const folded = [];
    const changes = [];
    for (const x of have) {
      const to = foldTo(x, cat);
      if (!to.length) {
        if (!known.has(K(x))) {
          const hit = mapPhrase(x, liveByCat.get(cat), cat, map);
          /* Report the near-misses: a value that DOES mean catalogue options but
             not all of them are in scope. That list is what the owner reads when
             deciding whether to widen the authorisation. */
          if (hit.length && !hit.every((c) => authorised.has(K(c)))) {
            const label = `${x}  ->  ${hit.join(' + ')}`;
            ambiguous.set(label, (ambiguous.get(label) ?? 0) + 1);
          }
        }
        if (!folded.some((y) => K(y) === K(x))) folded.push(x);
        continue;
      }
      changes.push({ from: x, to: to.join(' + ') });
      for (const code of to) if (!folded.some((y) => K(y) === K(code))) folded.push(code);
    }
    if (!changes.length) { untouched += 1; continue; }

    const allAgree = [v, ...pos.map((x) => x.variants), ...grn.map((x) => x.variants), ...dos.map((x) => x.variants)]
      .every((vv) => {
        const cur = specialsOf(vv);
        return cur.length === folded.length && folded.every((x) => cur.some((y) => K(x) === K(y)));
      });
    if (allAgree) { untouched += 1; continue; }

    plan.push({
      doc: r.doc_no, soItemId: r.id, grp: r.grp, itemCode: r.item_code,
      have, next: folded, changes,
      pos, grn, doRows: dos, dos: dos.map((d) => d.id),
      pinv: pinv.map((x) => x.id), sinv: sinv.map((x) => x.id),
      soRow: { item_code: r.item_code, variants: v, grp: r.grp },
    });
  }

  /* ── the stock buckets, every line of the chain asked (docs/bugs/0844) ──── */
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

  const { writable, refused } = await classifyPlans(plan, consumersOf);

  /* ── report ────────────────────────────────────────────────────────────── */
  rule();
  line(`   chains already carrying only catalogue codes   ${untouched}`);
  line(`   CHAINS TO CHANGE                              ${plan.length}`);
  line(`   WRITABLE                                      ${writable.length}`);
  line(`   REFUSED                                       ${refused.length}`);
  rule();
  const byFold = new Map();
  for (const p of writable) for (const c of p.changes) {
    const k = `${c.from}  ->  ${c.to}`;
    byFold.set(k, (byFold.get(k) ?? 0) + 1);
  }
  line('   the folds that would be made (chains, not document lines):');
  for (const [k, n] of [...byFold].sort((a, b) => b[1] - a[1])) line(`      ${String(n).padStart(4)}  ${k}`);
  rule();
  for (const p of writable.slice(0, 25)) {
    line(`   ${p.doc.padEnd(15)} ${String(p.itemCode).padEnd(24)} ${p.changes.map((c) => `${c.from} -> ${c.to}`).join('; ')}`
      + `   chain: ${p.pos.length} PO, ${p.grn.length} GR, ${p.dos.length} DO, ${p.pinv.length} PI, ${p.sinv.length} SI`
      + `   buckets ${p.buckets.length}`);
  }
  if (writable.length > 25) line(`   ... and ${writable.length - 25} more`);
  rule();
  for (const p of refused.slice(0, 25)) line(`   REFUSED ${p.doc.padEnd(15)} ${String(p.itemCode).padEnd(24)} ${p.why}`);
  if (refused.length > 25) line(`   ... and ${refused.length - 25} more refusals`);
  if (ambiguous.size) {
    rule();
    line('   legacy values that mean a catalogue option NOT in scope — left alone, because');
    line('   folding them would silently drop the meaning that is out of scope:');
    for (const [k, n] of [...ambiguous].sort((a, b) => b[1] - a[1]).slice(0, 15)) line(`      ${String(n).padStart(4)}  ${k}`);
  }

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
          /* A TEXT ARRAY the server turns into jsonb — never a pre-serialized
             string on a jsonb parameter (docs/jsonb-double-encoding-coe.md). */
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
        for (const c of p.changes) {
          if (now.some((y) => K(y) === K(c.from))) bad.push(`${p.doc}: still carries the old spelling "${c.from}"`);
          for (const code of String(c.to).split(' + ')) {
            if (!now.some((y) => K(y) === K(code))) bad.push(`${p.doc}: does not carry "${code}"`);
          }
        }
        for (const b of p.buckets) {
          const left = Number((await check.unsafe(
            `SELECT count(*)::int AS n FROM scm.inventory_lots WHERE company_id=$1 AND item_code=$2 AND coalesce(variant_key,'')=$3`,
            [CO, b.itemCode, b.oldKey]))[0]?.n ?? 0);
          if (left) bad.push(`${p.doc} ${b.itemCode}: ${left} lot(s) left in the old bucket`);
        }
      }
      if (bad.length) { line(`VERIFY FAILED — ${bad.length}: ${bad.slice(0, 8).join(' · ')}`); process.exitCode = 1; }
      else line(`VERIFY OK — ${todo.length} chain(s) folded, re-read on a fresh connection.`);
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
