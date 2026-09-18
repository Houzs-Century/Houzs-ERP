// PURE: one verdict per document line — which ONE library colour its free text
// names, or why none is written. Built ON the one fabric-colour matcher
// (fabric-colour-match.mjs); this file adds only what a WRITER needs on top of
// a finder:
//
//   several    the text names two different colours ("x2Col:M2402-9/x2Col:M2402-15",
//              "BO315-27 x2 BO315-28 x2") — a finder returns one of them, a
//              writer must not
//   no-colour  blank, TBC / KIV, random
//   unknown    a colour is named but the library cannot resolve it
//   match      exactly one colour, and not one whose SERIES the matcher had to
//              assume (assumedSeries — docs/bugs/0672 site 16)
//
// Owner 2026-09-14: 「然后看一下之前旧的order 都帮我backfill颜色」.
import { isPendingColour, stripPendingMarker } from "./fabric-colour-match.mjs";

const RANDOM_RE = /\bR[AO]ND[AO]ME?\b|\bRAMDOM\b|\bRDM\b|\bRANDOMLY\b/i;
const CODE_LIKE = /[A-Z]\s*-?\s*\d{3,}|[A-Z]{2,}\s*-?\s*\d{2,}/i;
// "x2Col: ", "SPECIAL: ", "Fabric : " in front of the colour itself
const LEAD = /^(?:x\s*\d+\s*)?(?:(?:SPECIAL|FABRIC|COL(?:OU?R)?)\s*[:.=：-]\s*)+/i;

export function lineColourVerdict(text, explainColour) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { verdict: "no-colour" };
  if (RANDOM_RE.test(t)) return { verdict: "no-colour", why: "random" };
  const segments = t.split(/[\/|;+&]|\bx\s*\d+\b|\b\d+\s*x\b/i).map((s) => s.trim()).filter(Boolean);
  const ids = new Map();
  let namedButUnresolved = false;
  for (const seg of segments) {
    const clean = stripPendingMarker(seg.replace(LEAD, ""));
    if (!clean) continue;
    const e = explainColour(clean);
    if (e && !e.assumedSeries) ids.set(e.row.colour_id, e);
    else if (CODE_LIKE.test(clean)) namedButUnresolved = true;
  }
  if (ids.size > 1) return { verdict: "several", codes: [...ids.keys()] };
  if (ids.size === 1) {
    const [code, e] = [...ids.entries()][0];
    // a second, unresolvable code beside a resolved one is still a second colour
    const others = segments.map((s) => stripPendingMarker(s.replace(LEAD, ""))).filter((s) => s && CODE_LIKE.test(s) && !explainColour(s));
    if (others.length) return { verdict: "several", codes: [code, ...others.map((s) => s.slice(0, 30))] };
    return { verdict: "match", code, via: e.via };
  }
  if (isPendingColour(t) && !namedButUnresolved) return { verdict: "no-colour", why: "pending" };
  return namedButUnresolved ? { verdict: "unknown" } : { verdict: "no-colour" };
}
