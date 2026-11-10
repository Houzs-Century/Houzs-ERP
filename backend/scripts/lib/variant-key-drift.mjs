// variant-key-drift — the judgement behind check-variant-key-drift.mjs.
//
// Stock is bucketed by (item, warehouse, variant_key). When the DO that ships a
// product computes a different key from the GRN that received the same product,
// the OUT lands in a bucket with no stock (it goes negative) while the GRN's
// bucket keeps stock nobody consumes. This module compares two keys and says
// WHY they differ, so the fix can target the path that builds the wrong one.
//
// Key format (backend/src/scm/shared/variant-key.ts computeVariantKey):
//   "fabriccode=bf-16|gap=4|divanheight=10|legheight=2|totalheight=16\"|special=a,b"
// Pure functions only; no database, no money.

export const DEFAULT_CUTOVER = "2026-08-29";
export const DEFAULT_LIMIT = 20;

export const CLASSES = [
  ["same-key", "DO key equals the GRN key (drift is elsewhere: another OUT, or the GRN stock sits in another warehouse)"],
  ["field-one-side", "a field present on one side only"],
  ["format", "same values written differently (quotes, spaces, case, units)"],
  ["different-value", "a different fabric or value (a real different product)"],
  ["grn-no-spec", "the GRN line has no spec at all; the DO has one"],
  ["do-no-spec", "the DO line has no spec at all; the GRN has one"],
  ["po-no-grn", "SO line has a PO line but no posted GRN line"],
  ["no-po-link", "SO line has no PO line (sold from stock, or the DO line has no SO line)"],
];

export function intEnv(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** "a=1|b=2" -> [["a","1"],["b","2"]]. A part with no "=" keeps an empty field name. */
export function parseVariantKey(key) {
  const s = String(key ?? "").trim();
  if (!s) return [];
  return s.split("|").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    return eq < 0 ? ["", part] : [part.slice(0, eq), part.slice(eq + 1)];
  });
}

/* Inch marks the forms have written: straight and typographic double quotes,
   two single quotes, primes, and the words. */
const INCH_RE = /(''|"|“|”|″|′′|\binch(es)?\b|\bin\b)/g;

/** The value with everything that is formatting stripped: case, spaces, hyphens,
 *  underscores, inch marks and inch words. Two values that canonicalise equal
 *  name the same physical thing. Specials are order-independent. */
export function canonValue(field, value) {
  const base = (v) => String(v ?? "").toLowerCase().replace(INCH_RE, "").replace(/[\s\-_.]+/g, "");
  if (field === "special") {
    return String(value ?? "").split(",").map(base).filter(Boolean).sort().join(",");
  }
  return base(value);
}

/**
 * Compare a DO key with a reference (GRN) key.
 * Returns { cls, diffs: [{ field, kind: "do-only"|"ref-only"|"format"|"value", doValue, refValue }] }.
 * cls is one of: same-key, grn-no-spec, do-no-spec, different-value, field-one-side, format.
 * Priority when several kinds occur: different-value > field-one-side > format, because
 * a different fabric is a different product whatever else differs.
 */
export function classifyPair(doKey, refKey) {
  const a = String(doKey ?? "");
  const b = String(refKey ?? "");
  if (a === b) return { cls: "same-key", diffs: [] };
  const dm = new Map(parseVariantKey(a));
  const rm = new Map(parseVariantKey(b));
  const diffs = [];
  for (const [field, doValue] of dm) {
    if (!rm.has(field)) { diffs.push({ field, kind: "do-only", doValue, refValue: null }); continue; }
    const refValue = rm.get(field);
    if (doValue === refValue) continue;
    const kind = canonValue(field, doValue) === canonValue(field, refValue) ? "format" : "value";
    diffs.push({ field, kind, doValue, refValue });
  }
  for (const [field, refValue] of rm) {
    if (!dm.has(field)) diffs.push({ field, kind: "ref-only", doValue: null, refValue });
  }
  if (rm.size === 0) return { cls: "grn-no-spec", diffs };
  if (dm.size === 0) return { cls: "do-no-spec", diffs };
  if (diffs.some((d) => d.kind === "value")) return { cls: "different-value", diffs };
  if (diffs.some((d) => d.kind === "do-only" || d.kind === "ref-only")) return { cls: "field-one-side", diffs };
  if (diffs.length === 0) return { cls: "same-key", diffs }; // same fields in another order
  return { cls: "format", diffs };
}

/** Per-field tally labels: "totalheight (DO only)", "fabriccode (value)", ... */
export function diffLabels(diffs) {
  const side = { "do-only": "DO only", "ref-only": "GRN only", format: "format", value: "value" };
  return diffs.map((d) => `${d.field || "(no field name)"} (${side[d.kind]})`);
}

const RANK = { "same-key": 0, format: 1, "field-one-side": 2, "do-no-spec": 3, "grn-no-spec": 3, "different-value": 4 };

/** Of several candidate keys, the one closest to doKey (fewest, mildest differences).
 *  Returns { key, cls, diffs } or null when there are no candidates. */
export function closestKey(doKey, candidates) {
  let best = null;
  for (const key of candidates) {
    const r = classifyPair(doKey, key);
    const score = RANK[r.cls] * 100 + r.diffs.length;
    if (!best || score < best.score) best = { key, ...r, score };
  }
  if (!best) return null;
  const { score: _score, ...rest } = best;
  return rest;
}

/**
 * Which side moved away from the SO line's key.
 *   "DO" — SO = GRN, DO differs;  "GRN" — SO = DO, GRN differs;
 *   "both" — all three differ;    "none" — DO = GRN;  "unknown" — a key is missing.
 */
export function driftSide(soKey, doKey, grnKey) {
  if (soKey == null || doKey == null || grnKey == null) return "unknown";
  if (doKey === grnKey) return "none";
  if (soKey === grnKey) return "DO";
  if (soKey === doKey) return "GRN";
  return "both";
}

/** A bucket the brief calls drifted: net movements below zero, no open lot, and an
 *  OUT on or after the cutover. */
export function isNegativeAfterCutover(bucket, cutover) {
  const lastOut = bucket.lastOutAt ? new Date(bucket.lastOutAt).getTime() : NaN;
  return Number(bucket.movementNet) < 0
    && Number(bucket.lotOpen ?? 0) === 0
    && Number.isFinite(lastOut) && lastOut >= new Date(cutover).getTime();
}

/**
 * Resolve one DO line's chain to a reference key.
 *   poLines: PO lines for the line's SO line, each { id, key, poNo }
 *   grnLines: posted GRN lines for those PO lines, each { poItemId, key, grnNo }
 * Returns { cls, ref } where ref is the GRN line (or PO line for po-no-grn) used.
 */
export function classifyChain(doKey, soItemId, poLines, grnLines) {
  if (!soItemId || poLines.length === 0) return { cls: "no-po-link", ref: null, diffs: [] };
  const poIds = new Set(poLines.map((p) => p.id));
  const grns = grnLines.filter((g) => poIds.has(g.poItemId));
  if (grns.length === 0) {
    const near = closestKey(doKey, poLines.map((p) => p.key));
    return { cls: "po-no-grn", ref: poLines.find((p) => p.key === near.key) ?? null, diffs: near.diffs };
  }
  const near = closestKey(doKey, grns.map((g) => g.key));
  return { cls: near.cls, ref: grns.find((g) => g.key === near.key) ?? null, diffs: near.diffs };
}

/** Counter helpers. */
export function tally(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const keys = [].concat(keyFn(it));
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])));
}

/** Product family for the summary: the item code up to the first "-(" , "(" or digit run. */
export function itemFamily(itemCode) {
  const s = String(itemCode ?? "").trim().toUpperCase();
  const m = s.match(/^([A-Z][A-Z &]*?)(?:\s*[-(]|\s+\d|$)/);
  return m ? m[1].trim() : s;
}
