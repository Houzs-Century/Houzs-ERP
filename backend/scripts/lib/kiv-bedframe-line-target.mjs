// HC-0182: which sized code a sales line on the old placeholder "BEDFRAME KIV LV2"
// belongs to, read from the level and size the salesperson typed in the line text
// ("LV1 KING", "Level 2 (Queen)", "lvl1queen/Divan:8''").
//
// The level is the costing model (Sim 2026-10-30): LV1 Jager, LV2 Cody, LV3
// Regal, LV4 Trion. A line moves when it resolves to exactly ONE level and ONE
// size. The size comes from the text, else from the same order's mattress when
// the order has one mattress size only. The level comes from the text; a line
// that names none takes DEFAULT_LEVEL only when the caller passes one (Sim:
// "if cant identify then all put as LV2", pending the boss). Two of either
// ("K x1 Q x1", "level 2 or level 3") or no size at all stays on the old code:
// guessing would put a real order on the wrong bed and the wrong cost.

export const OLD_CODE = 'BEDFRAME KIV LV2';

/* The LV2 model's size codes were generated while the model was still coded
   "BEDFRAME KIV", so they carry no level. They are renamed before any line moves. */
export const SIZE_CODES = ['K', 'Q', 'S', 'SS', 'SK', 'SP'];
export const RENAMES = SIZE_CODES.map((sz) => ({
  from: `BEDFRAME KIV-(${sz})`,
  to: `BEDFRAME KIV LV2-(${sz})`,
}));

export const targetCode = (level, size) => `BEDFRAME KIV LV${level}-(${size})`;

const MODEL_LEVEL = { JAGER: '1', CODY: '2', REGAL: '3', TRION: '4' };

export function levelsOf(text) {
  const s = String(text ?? '');
  const found = [...s.matchAll(/\b(?:LVL|LV|LEVEL|L)\s*\.?\s*([1-4])(?![0-9.])/gi)].map((m) => m[1]);
  for (const m of s.toUpperCase().matchAll(/\b(JAGER|CODY|REGAL|TRION)\b/g)) found.push(MODEL_LEVEL[m[1]]);
  return [...new Set(found)].sort();
}

export function sizesOf(text) {
  let t = ` ${String(text ?? '').toUpperCase()} `;
  const out = new Set();
  for (const m of t.matchAll(/(\d{3})\s*(?:CM)?\s*X\s*(\d{3})/g)) out.add(m[1] === '200' && m[2] === '200' ? 'SK' : 'SP');
  t = t.replace(/(\d{3})\s*(?:CM)?\s*X\s*(\d{3})\s*(?:CM)?/g, ' ');
  if (/SUPER\s*SINGLE/.test(t)) out.add('SS');
  t = t.replace(/SUPER\s*SINGLE/g, ' ');
  const tokens = t.replace(/(\d)([A-Z])/g, '$1 $2').replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/(LVL|LV|LEVEL)(KING|QUEEN|SINGLE)/g, '$1 $2')
    .split(/[^A-Z0-9]+/).filter(Boolean);
  for (const w of tokens) {
    if (w === 'KING' || w === 'K') out.add('K');
    else if (w === 'QUEEN' || w === 'Q') out.add('Q');
    else if (w === 'SINGLE' || w === 'S') out.add('S');
    else if (w === 'SS') out.add('SS');
    else if (w === 'SK') out.add('SK');
  }
  return [...out].sort();
}

/**
 * { target, levelFrom, sizeFrom } for a line that moves, or { stay } with the
 * reason it does not. mattressSizes: the distinct mattress size codes on the
 * line's own order. defaultLevel: '2' to give unnamed levels LV2, else null.
 */
export function lineTarget(text, { mattressSizes = [], defaultLevel = null } = {}) {
  const levels = levelsOf(text);
  let sizes = sizesOf(text);
  if (levels.length > 1 || sizes.length > 1) return { stay: 'TWO_BEDS_OR_CHOICES', levels, sizes };
  let sizeFrom = 'text';
  if (sizes.length === 0) {
    const ms = [...new Set(mattressSizes)].filter((s) => SIZE_CODES.includes(s));
    if (ms.length > 1) return { stay: 'NO_SIZE_MATTRESSES_DIFFER', levels, sizes: ms };
    if (ms.length === 0) return { stay: levels.length ? 'NO_SIZE' : 'NO_LEVEL_NO_SIZE', levels, sizes };
    sizes = ms;
    sizeFrom = 'mattress';
  }
  let levelFrom = 'text';
  let level = levels[0];
  if (!level) {
    if (!defaultLevel) return { stay: 'NO_LEVEL', levels, sizes, sizeFrom };
    level = defaultLevel;
    levelFrom = 'default';
  }
  return { target: targetCode(level, sizes[0]), levels, sizes, levelFrom, sizeFrom };
}

/** The text a line is read from: its Desc2 and its remark, as typed. */
export const lineText = (row) => [row.description2, row.remark, row.variants?.remark]
  .map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join(' / ');

/**
 * Plan the rehome. Pure: the world comes in, the plan goes out.
 *   products: [{ code, model_id, status }] for every code involved
 *   refsOnRename: [{ code, table, rows }] cascade rows on a rename source
 *   lines: [{ id, text, mattressSizes, openAmendment }] sales lines on OLD_CODE
 *   defaultLevel: '2' or null
 */
export function planKivRehome({ products, refsOnRename, lines, defaultLevel = null }) {
  const by = new Map(products.map((p) => [p.code, p]));
  const refusals = [];
  const old = by.get(OLD_CODE);
  if (!old) refusals.push(`${OLD_CODE} is not in the catalogue`);

  const renames = [];
  for (const r of RENAMES) {
    const from = by.get(r.from);
    const to = by.get(r.to);
    if (!from && to) continue;
    if (!from) { refusals.push(`${r.from} is missing and ${r.to} does not exist either`); continue; }
    if (to) { refusals.push(`${r.to} already exists, so ${r.from} cannot take its name`); continue; }
    if (old && from.model_id !== old.model_id) refusals.push(`${r.from} is not on the ${OLD_CODE} model`);
    const used = refsOnRename.filter((x) => x.code === r.from && x.rows > 0);
    if (used.length) refusals.push(`${r.from} is already used (${used.map((u) => `${u.table} ${u.rows}`).join(', ')}): rename it with the cascade, not here`);
    renames.push(r);
  }
  const afterRename = new Set([...by.keys(), ...renames.map((r) => r.to)]);

  const moves = [];
  const stays = [];
  for (const l of lines) {
    const t = lineTarget(l.text, { mattressSizes: l.mattressSizes ?? [], defaultLevel });
    if (t.stay) { stays.push({ ...l, reason: t.stay }); continue; }
    if (!afterRename.has(t.target)) { stays.push({ ...l, reason: 'TARGET_MISSING', target: t.target }); continue; }
    if (by.get(t.target) && by.get(t.target).status !== 'ACTIVE') { stays.push({ ...l, reason: 'TARGET_INACTIVE', target: t.target }); continue; }
    if (l.openAmendment) { stays.push({ ...l, reason: 'OPEN_AMENDMENT', target: t.target }); continue; }
    moves.push({ ...l, target: t.target, levelFrom: t.levelFrom, sizeFrom: t.sizeFrom });
  }
  return { refusals, renames, moves, stays };
}

export const confirmPhrase = (plan) => {
  const byDefault = plan.moves.filter((m) => m.levelFrom === 'default').length;
  return `REHOME KIV: RENAME ${plan.renames.length}, MOVE ${plan.moves.length} LINES`
    + (byDefault ? ` (${byDefault} AS LV2 BY DEFAULT)` : '') + `, LEAVE ${plan.stays.length}`;
};
