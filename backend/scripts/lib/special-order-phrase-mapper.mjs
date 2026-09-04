// ----------------------------------------------------------------------------
// The migrated slip-phrase -> Special Orders picker-code mapper, in ONE place.
//
// IT IS ONE PLACE BECAUSE IT WAS ABOUT TO BE TWO. Every rule below was written
// for `backfill-specials-into-variants.mjs`, whose SKIP_PRICED run deliberately
// HELD BACK the lines that would gain a PRICED code (prod run 33517835461: 338
// lines held back, 442 stamped). The follow-up that records those held-back
// options needs the SAME population by construction, not by a second author
// re-deriving it — a phrase family that drifted between two copies would move
// lines silently between "stamped" and "held back", and neither script would
// notice.
//
// Nothing here reads or writes a database. It turns a line's `description2`
// (AutoCount's Desc2, which is where the migrated slip text lives) into the set
// of LIVE picker codes it asks for. `live` is always a LIVE `scm.special_addons`
// index supplied by the caller, so a code the owner has not created cannot be
// invented — the phrase falls through to UNMAPPED and is reported.
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSofa, SOFA_MODEL_ALIAS } from './parse-sofa.mjs';
import { parseBedframe } from './parse-bedframe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Master-data identity: trimmed, upper-cased, runs of whitespace collapsed. */
export const K = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
/** The parsers' own dedupe identity: letters and digits only, nilon = nylon. */
export const skey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/NILON/g, 'NYLON');
/** Match on WORDS, so "BACK REST", "BACKREST" and "back-rest" are one thing. */
export const flat = (s) => ' ' + String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
export const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

const rx = (src) => (src ? new RegExp(src) : null);

/** Load + compile `data/special-order-phrase-map.json`. The owner ruling behind
 *  each family lives in that file's `why`, never here. */
export function loadPhraseMap() {
  const raw = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'special-order-phrase-map.json'), 'utf8'));
  return {
    families: raw.families.map((f) => ({ ...f, _yes: rx(f.yes), _no: rx(f.no) })),
    excluded: raw.excluded.map((e) => ({ ...e, _m: rx(e.match) })),
    swaps: raw.cushionSwapModels,
  };
}

/** Index a LIVE `scm.special_addons` read: per-category code lookup + prices.
 *  `isPriced` comes from THIS read every run — never a list in the source, so a
 *  code the owner prices tomorrow starts being treated as priced tomorrow. */
export function buildLiveIndex(addons) {
  const liveByCat = new Map();
  for (const cat of ['SOFA', 'BEDFRAME']) {
    const m = new Map();
    for (const r of addons) {
      if (!(r.categories || []).some((c) => String(c).toUpperCase() === cat)) continue;
      m.set(K(r.code), r.code);
      if (r.label) m.set(K(r.label), r.code);
    }
    liveByCat.set(cat, m);
  }
  const priceOf = new Map(addons.map((r) => [r.code, {
    sell: Number(r.selling_price_sen ?? 0), cost: Number(r.cost_price_sen ?? 0),
  }]));
  const isPriced = (c) => { const p = priceOf.get(c) || { sell: 0, cost: 0 }; return p.sell !== 0 || p.cost !== 0; };
  return { liveByCat, priceOf, isPriced };
}

/** One phrase -> the picker codes it means. A family whose code is not in the
 *  live index contributes nothing. */
export function mapPhrase(raw, live, cat, map) {
  const s = flat(raw);
  const out = new Set();
  for (const f of map.families) {
    if (!f.categories.includes(cat)) continue;
    if (f._no && f._no.test(s)) continue;
    if (!f._yes.test(s)) continue;
    const code = live.get(K(f.code));
    if (code) out.add(code);
  }
  if (cat === 'SOFA' && /\bback ?rest\b|\bback ?cushion\b/.test(s) && !/\b(5537|5540)\b/.test(s)) {
    for (const [model, want] of map.swaps) {
      if (!new RegExp(`\\b${model}\\b`).test(s)) continue;
      // "9058 sofa backrest change 9028" names the sofa first: the model being
      // changed TO is the last number mentioned
      const nums = s.match(/\b\d{4}\b/g) || [];
      if (nums.length > 1 && nums[nums.length - 1] !== model) continue;
      const code = live.get(K(want));
      if (code) out.add(code);
    }
  }
  return [...out];
}

/** The owner's deliberate NON-mappings (compartment / free text / leg pool). */
export function excludedBy(raw, map) {
  const s = flat(raw);
  for (const e of map.excluded) if (e._m.test(s)) return e;
  return null;
}

/** Union the phrases a line asks for, using the SAME containment dedupe the
 *  parsers use so "BACKRESTCHANGE8030" and "BACK REST CHANGE 8030" are one. */
export function phrasesOf(list) {
  const phrases = [];
  for (const t of list) {
    const v = String(t ?? '').replace(/\s+/g, ' ').trim();
    const k = skey(v);
    if (!k) continue;
    let merged = false;
    for (let i = 0; i < phrases.length; i++) {
      const e = skey(phrases[i]);
      if (e.includes(k)) { merged = true; break; }
      if (k.includes(e)) { phrases[i] = v; merged = true; break; }
    }
    if (!merged) phrases.push(v);
  }
  return phrases;
}

/** The raw slip phrases a line asks for, from its own `description2`.
 *  `grp` is the stored item_group ('sofa' | 'bedframe'). */
export function slipPhrasesFor(grp, itemCode, description2) {
  if (!description2) return [];
  if (grp === 'sofa') {
    let model = String(itemCode || '').split('-')[0].toUpperCase();
    model = SOFA_MODEL_ALIAS[model] || model;
    // both recliner states decode the same specials — one pass is enough
    return parseSofa(description2, model, false).specials || [];
  }
  return parseBedframe(description2).specials || [];
}

/**
 * Classify ONE migrated line.
 *
 * Returns `{ cat, phrases, gained, unmapped, excludedHits, had, next, addedNow }`
 * where `gained` is the live code set the slip asks for, `had` is what the line
 * already carries in `variants.specials` / `variants.special`, and `addedNow` is
 * the strict addition. MERGE ONLY: `next` is always a superset of `had` (owner
 * 2026-08-11 「不可以删只可以 cancel」).
 */
export function classifyLine(row, map, liveByCat) {
  const cat = row.grp === 'sofa' ? 'SOFA' : 'BEDFRAME';
  const live = liveByCat.get(cat);
  const phrases = phrasesOf(slipPhrasesFor(row.grp, row.code, row.d2));
  const gained = new Set();
  const unmapped = [];
  const excludedHits = [];
  for (const p of phrases) {
    // already a real picker code (the parser emits several verbatim)
    if (live.has(K(p))) { gained.add(live.get(K(p))); continue; }
    const hit = mapPhrase(p, live, cat, map);
    if (hit.length) { for (const c of hit) gained.add(c); continue; }
    const ex = excludedBy(p, map);
    if (ex) { excludedHits.push(ex.why); continue; }
    unmapped.push(K(p));
  }
  const v = (row.variants && typeof row.variants === 'object' && !Array.isArray(row.variants)) ? row.variants : {};
  const had = [...new Set([...asArray(v.specials), ...asArray(v.special)].map((x) => String(x).trim()).filter(Boolean))];
  const next = [...had];
  const addedNow = [];
  for (const c of gained) if (!next.some((x) => K(x) === K(c))) { next.push(c); addedNow.push(c); }
  return { cat, phrases, gained: [...gained], unmapped, excludedHits, had, next, addedNow };
}

/** `variants` is not always a JSON OBJECT in production. jsonb_set's path
 *  addresses object keys, so on a row holding a jsonb ARRAY it fails the whole
 *  statement, which rolled back run 31417530815 entirely. Coercing such a row to
 *  '{}' would DELETE what it holds, which the owner's 不可以删只可以 cancel rule
 *  forbids — so the caller skips and reports it. */
export const variantsShape = (v) =>
  v == null ? 'null'
    : Array.isArray(v) ? 'array'
      : typeof v === 'object' ? 'object' : typeof v;
