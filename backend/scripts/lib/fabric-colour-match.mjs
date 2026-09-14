// PURE: read a fabric colour out of the free text a line carries ("Col:Modenza 03",
// "B0315-5 FOSIL", "GD2502#14- silver") and name the ONE fabric-master code it
// means — or say why it cannot. No database, no I/O; the data run feeds it the
// master and the text.
//
// Owner 2026-09-14: 「然后看一下之前旧的order 都帮我backfill颜色」. The text was typed
// by people and by the AutoCount book, so the same colour arrives as
// `BO315-25`, `B0315-25` (a zero for the letter O), `Col:BO315-25 Fossil`; and
// the master itself holds some colours twice (`CH141-08` and `CH141-8-ARMY`).
//
// THE KEY. A code is reduced to its letters and its number groups, leading
// zeros dropped: `CH141-08` and `CH141-8-ARMY` are both CH|141|8; `MODENZA-04`
// and `Modenza 4` are MODENZA|4; `BO315` and `B0315` are both B|315 (a family's
// trailing O is dropped on both sides, so the O-for-zero typo meets itself). The
// descriptive word after the colour number (`-ARMY`, `(PEARL)`) is not part of
// the key.
//
// VERDICTS — a line is written only on `match`:
//   match       exactly one master fabric for exactly one key found in the text
//   no-colour   blank, TBC, KIV, random, or nothing that looks like a code
//   unknown     looks like a colour code, but no master fabric has that key
//   several     the text names two or more different fabrics (a 2-colour line)
//   duplicate   one key, but the master holds it under several codes and the
//               tie-break (active, then most used on sofa lines) cannot pick

const NO_COLOUR = /^(?:TBC|KIV|RANDOM|RANDOM COLOU?R|RC|COL|COLOU?R|FABRIC|SPECIAL|FREE|LUCKY DRAW|NA|N\/A|-)$/;

/** Letters + number groups of a code, leading zeros dropped. `null` when the
 *  string has no letter prefix followed by a number. */
export function fabricKey(code) {
  let s = String(code ?? "").toUpperCase().trim();
  // cut the descriptive tail: the first run of 3+ letters AFTER a digit
  const tail = s.match(/^(.*?\d)[\s\-()#]*[A-Z]{3,}.*$/);
  if (tail) s = tail[1];
  const m = s.match(/^([A-Z]+)[\s\-]*([0-9][0-9\s\-#]*)$/);
  if (!m) return null;
  const nums = m[2].split(/[^0-9]+/).filter(Boolean).map((n) => String(Number(n)));
  if (!nums.length) return null;
  // A trailing O on the family is dropped, the same way on both sides, so the
  // letter O typed for a zero (`BO315` / `B0315`) meets itself — and a family
  // that really ends in O (`CHINO-01`) still meets its own master row.
  const family = m[1].length > 1 && m[1].endsWith("O") ? m[1].slice(0, -1) : m[1];
  return `${family}|${nums.join("|")}`;
}

/** Index the master: key -> [{ code, active, uses }]. */
export function indexFabricMaster(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = fabricKey(r.fabric_code);
    if (!k) continue;
    const list = idx.get(k) ?? [];
    list.push({ code: r.fabric_code, active: r.is_active !== false, uses: Number(r.uses ?? 0) });
    idx.set(k, list);
  }
  return idx;
}

/** Every code-shaped token in a text, as keys. A token is a letter run
 *  (optionally split by space / dash from its number) followed by number
 *  groups joined by - or #. */
export function keysInText(text) {
  const s = String(text ?? "").toUpperCase();
  const out = new Set();
  const re = /([A-Z]{1,10})[\s\-:]*((?:O?\d+)(?:\s*[-#]\s*\d+|\s+\d+(?=#)){0,2})/g;
  for (const m of s.matchAll(re)) {
    const k = fabricKey(`${m[1]}${m[2]}`);
    if (k) out.add(k);
  }
  return [...out];
}

/** Resolve one line's text against the master index. */
export function matchFabricColour(text, idx) {
  const clean = String(text ?? "").toUpperCase().replace(/[{}\[\]|]/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.replace(/COL(?:OU?R)?\s*:/g, " ").split(/[\s,;\/()]+/).filter(Boolean);
  if (!clean || words.every((w) => NO_COLOUR.test(w) || /^\d+X\d+$/.test(w) || /^X?\d*$/.test(w))) {
    return { verdict: "no-colour" };
  }
  const found = keysInText(clean).filter((k) => idx.has(k));
  const sizeNoise = (k) => /^X\|\d+$/.test(k); // `16 X 16` reads as X|16
  if (found.length === 0) {
    const codeLike = keysInText(clean).filter((k) => !sizeNoise(k));
    return codeLike.length ? { verdict: "unknown", keys: codeLike } : { verdict: "no-colour" };
  }
  const fabrics = new Map();
  for (const k of found) fabrics.set(k, idx.get(k));
  // A second code of the SAME family the master does not hold (`M2402-9` beside
  // `M2402-15`) is still a second colour on the line, not noise.
  const families = new Set(found.map((k) => k.split("|")[0]));
  const strayTwin = keysInText(clean).some((k) => !idx.has(k) && families.has(k.split("|")[0]));
  if (fabrics.size > 1 || strayTwin) {
    return { verdict: "several", keys: [...fabrics.keys()] };
  }
  const [key, list] = [...fabrics.entries()][0];
  if (list.length === 1) return { verdict: "match", key, code: list[0].code };
  const active = list.filter((f) => f.active);
  const pool = active.length ? active : list;
  if (pool.length === 1) return { verdict: "match", key, code: pool[0].code, tieBreak: "active" };
  const top = Math.max(...pool.map((f) => f.uses));
  const best = pool.filter((f) => f.uses === top);
  if (best.length === 1 && top > 0) return { verdict: "match", key, code: best[0].code, tieBreak: "most-used" };
  return { verdict: "duplicate", key, codes: pool.map((f) => f.code) };
}
