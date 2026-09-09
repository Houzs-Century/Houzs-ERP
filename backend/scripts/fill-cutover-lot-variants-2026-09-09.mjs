#!/usr/bin/env node
/* fill-cutover-lot-variants-2026-09-09 — give the cutover's bedframe and sofa
 * stock lots the specification the account book holds for them.
 *
 * Owner, 2026-09-09: 「从 AutoCount 来的 stock 全部，你都要跟着 AutoCount 那边去
 * 拿到它的 variant、它的 stock、COGS 跟它的那个年龄」 and, on the format,
 * 「确保 Variant 是根据我们的写法，在我们的系统写的」.
 *
 * WHAT IS MISSING. The AutoCount cutover imported a quantity and no
 * specification, so stock lots that arrived through `source_doc_type =
 * 'AC_CUTOVER'` carry an empty `variant_key`. The plan run prints the exact
 * population before anything is written.
 *
 * I TOLD THE OWNER THIS COULD NOT BE FILLED, AND I WAS WRONG. The spec is not
 * in our system, and it IS in the book: `StockDTL` reaches the receipt's source
 * line and `GRDTL.Desc2` carries the text. Proven on `HOK-1007 (K)`:
 *     Col:PC151-01/M'gap:14"Inch/Divan:10"Inch No Leg/Addon Drawer Left side
 * That is a complete bedframe spec.
 *
 * ── WHICH RECEIPT, AND WHY THAT IS THE WHOLE PROBLEM ───────────────────────
 * The first version of this script took the NEWEST spec-bearing receipt for the
 * item code. That is a guess, and measured on the export it is usually a WRONG
 * one: of 276 bedframe item codes, only 85 were ever received under a single
 * spec. 191 have two or more — `NB-KHJ02(Q)` has 42 distinct specs across 130
 * receipts. Stamping the newest onto every lot would have written the wrong
 * colour and the wrong gap onto most of them.
 *
 * So the lot is matched to its OWN receipt, by document number. Our cutover
 * lots were relayered out of AutoCount's receipt history
 * (`import-ac-stock-layers.mjs`), and each one's movement note records the
 * source document verbatim — `AC GR GR-004679 2026-05-28`. That number is an
 * exact link from one lot to one receipt. Measured on the 2,339 relayered
 * cells: 2,316 (99.0%) resolve to their receipt in the export.
 *
 * A lot with no such note falls back ONLY when the item leaves no room for a
 * guess — every spec-bearing receipt for that code decodes to the SAME key.
 * Anything else is left alone and reported. Owner: 「如果没有 variant，那就算了」.
 *
 * ── OUR SHAPE, NOT AUTOCOUNT'S TEXT, AND NOT A THIRD COPY OF THE RULE ──────
 * The key is composed by `src/scm/shared/variant-key.ts` — the SAME function
 * the API and the frontend use, imported, never re-implemented; that is why
 * this script runs under `tsx`. The attribute bag is built by the same two
 * decoders the cutover importers use (`lib/parse-bedframe.mjs`,
 * `lib/parse-sofa.mjs`) and assembled the same way
 * `import-ac-outstanding-so.mjs` assembles it, so a lot and the document line
 * it belongs to produce a byte-identical key and land in one stock bucket.
 * Output looks like the Stock Breakdown screen the owner pointed at:
 *     fabriccode=bf-01|gap=14"|divanheight=8"|legheight=2"|totalheight=24"
 *
 * ── WHAT IS NOT FILLED, AND WHY THAT IS CORRECT ────────────────────────────
 * MATTRESSES AND ACCESSORIES GET NOTHING. `variant-key.ts` gives those groups
 * no attribute axis at all — the size is already in the product code — so their
 * correct key is the empty one. Their `Desc2` on a receipt is not a spec
 * either; it is free-text event notes, e.g. "Perak [AKEMI] MEGAHOME @ STADIUM
 * INDERA MULIA 21 Aug 2026". Writing that as a variant would put a roadshow
 * name in the attributes column.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing every lot and its decoded key.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE carries `coalesce(variant_key,'') = ''`, so a lot somebody has
 *   filled since this was measured is skipped, never overwritten.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: every
 *   lot this run filled now carries a key, that key reads as our key=value
 *   string, the mattress/accessory population is unchanged, and the lot count,
 *   quantities and inventory value are untouched — this writes one column and
 *   must not move stock or money.
 *
 * RE-RUN: idempotent — a second run finds them filled and reports 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseBedframe, bedframeVariants } from './lib/parse-bedframe.mjs';
import { parseSofa, SOFA_MODEL_ALIAS } from './lib/parse-sofa.mjs';
import { buildFabricColourIndex, isPendingColour } from './lib/fabric-colour-match.mjs';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'fill cutover lot variants 2026-09-09';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, 'data', 'ac-stock-receipts-2026-09-09.json.gz');
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing — it is the AutoCount extraction and this `
    + 'runner cannot reach the book. Nothing was written.');
  process.exit(1);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8').replace(/^﻿/, ''));
const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** Receipts indexed by (document number, item code) — the exact link. */
const byDoc = new Map();
/** Every spec-bearing receipt per item code, for the unambiguous fallback. */
const byItem = new Map();
for (const r of snap.receipts) {
  if (!r.desc2 || !r.item) continue;
  if (r.doc_no) byDoc.set(`${norm(r.doc_no)} ${norm(r.item)}`, r);
  const k = norm(r.item);
  if (!byItem.has(k)) byItem.set(k, []);
  byItem.get(k).push(r);
}

/* `AC GR GR-004679 2026-05-28` — written by import-ac-stock-layers.mjs when it
   replaced the flat opening balance with the book's real receipt layers. */
const NOTE_RE = /^AC\s+(\w+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/i;

/** Sofa attribute bag, exactly as import-ac-outstanding-so.mjs builds it
    (seat size + the resolved fabric colour + specials; the importer sets no
    leg height, so neither does this — a lot must key like its document line). */
function sofaAttrs(desc2, model, findColour) {
  const ps = parseSofa(desc2, model, false);
  const colour = isPendingColour(ps.color) ? null : ps.color;
  const fc = colour ? findColour(colour) : null;
  return {
    seatHeight: ps.size,
    fabricId: fc ? fc.fabric_id : null,
    colourId: fc ? fc.colour_id : null,
    fabricCode: fc ? fc.colour_id : null,
    colourLabel: fc ? fc.label : (colour || null),
    fabricLabel: fc ? fc.fabric_id : null,
    specials: ps.specials,
  };
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`MODE=${MODE}  company ${CO}`);
  log(`AutoCount extraction: ${snap.receipts.length} receipt(s), ${byDoc.size} addressable by `
    + `document, ${byItem.size} item(s) carry a spec; exported ${snap.exported_at}`);

  const fcRows = await sql`
    SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  log(`fabric colours: ${fcRows.length}`);

  /** One decoder path per group — the importers' own, never a copy. */
  function keyFor(group, desc2, itemCode) {
    if (!desc2) return '';
    try {
      if (group === 'bedframe') {
        return computeVariantKey('bedframe', bedframeVariants(parseBedframe(desc2), findColour));
      }
      const base = String(itemCode).replace(/-[^-]*$/, '');
      const model = SOFA_MODEL_ALIAS[base] || base;
      return computeVariantKey('sofa', sofaAttrs(desc2, model, findColour));
    } catch {
      return '';
    }
  }

  /* Cache the per-item verdict: ONE distinct key across every spec-bearing
     receipt means the item leaves no room for a guess. Anything else is
     ambiguous and the lot is left alone. */
  const unambiguous = new Map();
  function itemLevelKey(code, group) {
    const ck = `${group} ${code}`;
    if (unambiguous.has(ck)) return unambiguous.get(ck);
    const keys = new Set();
    for (const r of byItem.get(code) ?? []) {
      const k = keyFor(group, r.desc2, code);
      if (k) keys.add(k);
    }
    const v = keys.size === 1 ? [...keys][0] : null;
    unambiguous.set(ck, v);
    return v;
  }

  const lots = await sql`
    SELECT l.id, l.item_code, l.qty_remaining::numeric AS qty,
           l.received_at::date AS at, l.source_doc_type, l.source_doc_no,
           m.notes,
           upper(coalesce(p.category::text, '')) AS category
      FROM scm.inventory_lots l
      LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
      LEFT JOIN scm.mfg_products p
             ON upper(p.code) = upper(l.item_code) AND p.company_id = ${CO}
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0
       AND coalesce(l.variant_key, '') = ''
     ORDER BY l.item_code, l.received_at`;
  log(`lots on hand with no variant: ${lots.length}`);

  const plan = [];
  const skip = new Map();
  const bump = (k, n) => {
    const e = skip.get(k) ?? { lots: 0, units: 0 };
    e.lots += 1; e.units += n; skip.set(k, e);
  };
  /* Lots whose group HAS an axis but which could not be resolved — printed in
     full, so the next pass works from evidence and not from this summary. */
  const unresolved = [];

  for (const l of lots) {
    const units = Number(l.qty);
    const cat = String(l.category || '');
    const group = cat === 'BEDFRAME' ? 'bedframe' : cat === 'SOFA' ? 'sofa' : null;
    if (!group) {
      bump(cat
        ? `${cat.toLowerCase()} — no variant axis in variant-key.ts, correctly blank`
        : 'item not in the product master — category unknown', units);
      continue;
    }
    const code = norm(l.item_code);
    const m = NOTE_RE.exec(String(l.notes ?? '').trim());
    let key = '';
    let via = '';
    let src = '';
    if (m) {
      const r = byDoc.get(`${norm(m[2])} ${code}`);
      if (r) {
        key = keyFor(group, r.desc2, code);
        via = `receipt ${m[2]}`;
        src = r.desc2 ?? '';
      }
    }
    if (!key) {
      const k = itemLevelKey(code, group);
      if (k) { key = k; via = 'the only spec this item was ever received under'; }
    }
    if (!key) {
      bump(`${group}: no receipt of this lot's own, and the item's receipts disagree`, units);
      unresolved.push({ code: l.item_code, group, units, at: l.at, note: l.notes ?? null,
        receipts: (byItem.get(code) ?? []).length });
      continue;
    }
    plan.push({ id: l.id, code: l.item_code, group, qty: units, key, via, src });
  }

  const units = plan.reduce((s, p) => s + p.qty, 0);
  log(`\n=== WOULD FILL: ${plan.length} lot(s) / ${units} unit(s) ===`);
  const seen = new Set();
  for (const p of plan) {
    const k = `${p.code} ${p.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    log(`  ${p.code.padEnd(24)} ${p.key}`);
    log(`      via ${p.via}${p.src ? ` — book text: ${p.src.slice(0, 88)}` : ''}`);
  }
  log(`  (${plan.length} lot(s) collapse to ${seen.size} distinct item+key pair(s))`);

  log('\n  LEFT ALONE:');
  for (const [k, v] of [...skip].sort((a, b) => b[1].units - a[1].units)) {
    log(`    ${String(v.lots).padStart(4)} lot(s) / ${String(v.units).padStart(5)} unit(s) — ${k}`);
  }
  if (unresolved.length) {
    log('\n  UNRESOLVED, in full (these have an axis and no answer):');
    for (const u of unresolved) {
      log(`    ${u.code.padEnd(22)} ${u.group.padEnd(8)} ${String(u.units).padStart(4)}u  `
        + `received ${u.at ?? '-'}  spec-bearing receipts for this code: ${u.receipts}  `
        + `note: ${u.note ?? '(none)'}`);
    }
  }

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const [before] = await sql`
    SELECT count(*)::int AS lots, coalesce(sum(qty_remaining), 0)::numeric AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::bigint AS value_sen,
           count(*) FILTER (WHERE coalesce(variant_key, '') <> '')::int AS keyed
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;
  const [noAxisBefore] = await sql`
    SELECT count(*)::int AS n FROM scm.inventory_lots l
      LEFT JOIN scm.mfg_products p
             ON upper(p.code) = upper(l.item_code) AND p.company_id = ${CO}
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0
       AND coalesce(l.variant_key, '') <> ''
       AND upper(coalesce(p.category::text, '')) NOT IN ('SOFA', 'BEDFRAME')`;

  let wrote = 0;
  for (const p of plan) {
    const done = await sql`
      UPDATE scm.inventory_lots SET variant_key = ${p.key}
       WHERE id = ${p.id} AND coalesce(variant_key, '') = ''
      RETURNING id`;
    wrote += done.length;
  }
  log(`\nAPPLIED: ${wrote} lot(s) filled.`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  const [after] = await check`
    SELECT count(*)::int AS lots, coalesce(sum(qty_remaining), 0)::numeric AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::bigint AS value_sen,
           count(*) FILTER (WHERE coalesce(variant_key, '') <> '')::int AS keyed
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;
  const [blank] = await check`
    SELECT count(*)::int AS n FROM scm.inventory_lots
     WHERE id = ANY(${plan.map((p) => p.id)}) AND coalesce(variant_key, '') = ''`;
  const [noAxisAfter] = await check`
    SELECT count(*)::int AS n FROM scm.inventory_lots l
      LEFT JOIN scm.mfg_products p
             ON upper(p.code) = upper(l.item_code) AND p.company_id = ${CO}
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0
       AND coalesce(l.variant_key, '') <> ''
       AND upper(coalesce(p.category::text, '')) NOT IN ('SOFA', 'BEDFRAME')`;
  /* Read one filled lot back and assert the STRING, not just that it is
     non-empty: a key written as `[object Object]`, or as AutoCount's raw text,
     would satisfy every count above. */
  const sample = plan.length
    ? await check`SELECT item_code, variant_key FROM scm.inventory_lots WHERE id = ${plan[0].id}`
    : [];
  await check.end();

  const shaped = sample.length === 0
    || /^[a-z]+=[^|]+(\|[a-z]+=[^|]+)*$/.test(sample[0].variant_key ?? '');
  const ok = {
    'every lot this run filled now carries a key': blank.n === 0,
    'the key reads as our key=value|key=value shape': shaped,
    'no mattress or accessory lot gained one': noAxisAfter.n === noAxisBefore.n,
    'lot count unchanged': after.lots === before.lots,
    'quantities unchanged': String(after.qty) === String(before.qty),
    'inventory value unchanged': String(after.value_sen) === String(before.value_sen),
    'keyed count rose by exactly what was written': after.keyed === before.keyed + wrote,
  };
  log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  if (sample.length) log(`  sample: ${sample[0].item_code} -> ${sample[0].variant_key}`);
  log(`  lots with a variant ${before.keyed} -> ${after.keyed} of ${after.lots}`);
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — one column written, nothing else moved.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
