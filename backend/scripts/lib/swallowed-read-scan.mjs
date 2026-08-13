// ---------------------------------------------------------------------------
// swallowed-read-scan.mjs — the pure scanner behind `npm run audit:swallowed-reads`.
//
// THE SHAPE. supabase-js / PostgREST does not throw. A failed select resolves
// `{ data: null, error }`. So these three states arrive at the same line:
//
//     the query failed        the caller is not allowed      there is nothing here
//
// and `const { data } = await sb...` followed by `data ?? []` collapses all
// three into the third. After that line the code cannot tell them apart, and it
// writes the result.
//
// WHAT IT COST (BUG-HISTORY, all 2026-07):
//   - "A blip on the payments read told the driver an already-paid order still
//     owed the full total — and POD collected it again." Real money, twice,
//     from a customer who had already paid.
//   - "A blip on the read that asks 'did we already apply this credit?' ...
//     DEFEATED the guard and spent the customer's credit twice."
//   - "A transient DB blip did not leave an SO's totals stale — it ZEROED the
//     order's money and told nobody."
//   - "A missing permission payload meant FULL ACCESS at five sites — including
//     `pms.canPayment ?? true` on a money surface."
// The owner named the cost himself: 「它們不會報錯。它們悄悄發生，你兩個月後對帳才發現」.
//
// WHY A RATCHET AND NOT A BAN. 956 sites exist in backend/src today, across 105
// files. Most are certainly fine; nothing separates the safe ones from the
// dangerous ones, and no honest change deletes 956 destructures in one PR. What
// IS provable is the direction: the 2026-07-17 census counted 785 of 1,277, the
// class was declared fixed in 15 money documents, and four weeks later it had
// grown to 956 of 1,794. The class did not recur despite the fix; it grew
// during it, because nothing counted.
//
// So the gate is per-file ceilings that may only fall. Site 957 fails the
// build. Fixing sites requires lowering the ceiling in the same PR, which is
// what makes the ratchet actually descend instead of just holding.
// ---------------------------------------------------------------------------

/** Blank comments position-for-position so a comment about the shape is not
 *  counted as an instance of it, and line numbers stay true. */
export function blankComments(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every `const { ...data... } = await ...` whose destructure does NOT bind
 * `error`. Brace-matched, so a destructure spread over several lines counts the
 * same as a one-liner — the 2026-07 census grepped single lines only and
 * therefore undercounted itself on both sides.
 */
export function scanErrorlessReads(text) {
  const src = blankComments(text);
  const hits = [];
  const re = /\bconst\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    let depth = 0;
    let close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1) continue;
    const keys = src.slice(open + 1, close);
    // Only destructures that are AWAITED reads. A `const { data } = props` is
    // not this shape.
    if (!/^\s*=\s*await\b/.test(src.slice(close + 1, close + 40))) continue;
    if (!/\bdata\b/.test(keys)) continue;
    if (/\berror\b/.test(keys)) continue;
    hits.push({ line: lineOf(src, m.index), snippet: keys.replace(/\s+/g, ' ').trim().slice(0, 70) });
    re.lastIndex = close;
  }
  return hits;
}

/**
 * Every `.catch(() => {})` and its silent siblings — the third recorded variant
 * of the same class ("Six `.catch(() => {})` on reads — a 403 rendered as an
 * empty crew list", 2026-07-19).
 */
export function scanBareCatches(text) {
  const src = blankComments(text);
  const hits = [];
  // `.catch(() => {})`, `.catch(() => undefined)`, `.catch(() => null)`,
  // `.catch(() => [])`, and the async variants. Anything that discards the
  // rejection value without binding it.
  const re = /\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(\{\s*\}|undefined|null|\[\s*\]|void 0)\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    hits.push({ line: lineOf(src, m.index), snippet: m[0].replace(/\s+/g, ' ') });
  }
  return hits;
}
