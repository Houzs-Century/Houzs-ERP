// ----------------------------------------------------------------------------
// autocount-sofa-collapse — divergence D9.
//
// THE SHAPE MISMATCH. The ERP models a sofa build as ONE LINE PER COMPARTMENT
// ({model}-1A(LHF), {model}-CNR, {model}-2A(RHF) ...). AutoCount holds ONE LINE
// PER SOFA, with the build written into Desc2 as free text. Pushing the ERP's
// lines straight through would put three items on an AutoCount order that has
// one, and the compartment codes do not exist in the account book at all.
//
// THE INVERSE IS NOT A DECODER. Reconstructing the owner's Desc2 grammar from a
// compartment list is lossy — measured on the live book, a naive inverse got
// 86.2% of builds right, and a tuned one still corrupted 0.59% (14 builds in
// 2392) by, for example, turning "1ER + 1EL" into a side-swapped build that
// reads perfectly plausibly and ships the wrong sofa. So the inverse is NOT the
// primary path:
//
//   1. ECHO. The original AutoCount Desc2 is already stored verbatim on every
//      compartment line (both importers write l.Desc2 into description2). If it
//      still decodes to exactly the compartments the ERP holds, the build has
//      not been edited and the ORIGINAL TEXT is by definition the faithful
//      answer. Zero reconstruction, zero risk.
//   2. COMPOSE, only when the echo no longer decodes to what the ERP has — i.e.
//      the operator actually changed the build.
//   3. GATE, always. Whatever text is about to be sent is fed back through the
//      SAME decoder the importers use, and is REFUSED unless it reproduces the
//      compartment sequence, the seat size, the colour and the specials. This
//      is what turns "0.59% corrupting" into "0% corrupting, 1.3% refused".
//
// A REFUSAL IS THE DESIGNED OUTCOME, not an error path. It surfaces as a
// 'skipped' outbox row carrying the reason (the row shape the D13 fix added),
// and the document simply does not sync until a human looks. A wrong line in a
// licensed account book cannot be removed on a PO at all.
//
// PURE. No database, no AutoCount, no clock. Its only dependency is the shared
// decoder the cutover importers use — deliberately the same module, because a
// second copy that drifts would make the gate prove nothing.
// ----------------------------------------------------------------------------
import { parseSofa, type SofaParse } from '../../scripts/lib/parse-sofa.mjs';

/**
 * Every compartment suffix the ERP can mint, as {model}-{suffix}.
 *
 * The list is the union of the 407 minted sofa SKUs (backend/scripts/data/
 * minted-sofa-skus-2026-08.json, 23 distinct suffixes), the base 1S that the
 * cutover map itself points at, and the two shapes parseSofa can emit that were
 * never minted (1ABOX) — recognising a suffix is not the same as being able to
 * round-trip it, and the gate is what decides the latter.
 */
export const SOFA_COMPARTMENTS: readonly string[] = [
  '1S', '2S', '3S',
  '1NA', '2NA',
  'CNR', 'Console', 'STOOL',
  '1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)',
  '1B(LHF)', '1B(RHF)', '2B(LHF)', '2B(RHF)',
  'L(LHF)', 'L(RHF)',
  '1S(R)', '1S(P)',
  '1A(R)(LHF)', '1A(R)(RHF)', '1A(P)(LHF)', '1A(P)(RHF)',
  '1ABOX(LHF)', '1ABOX(RHF)',
];

const COMPARTMENT_SET = new Set(SOFA_COMPARTMENTS.map((c) => c.toUpperCase()));

/** The ERP line fields this module reads. Structurally a subset of ErpLine. */
export interface CollapsibleLine {
  item_code: string;
  item_group?: string | null;
  description?: string | null;
  description2?: string | null;
  qty: number;
  unit_price_centi: number;
  location?: string | null;
  delivery_date?: string | null;
  variants?: Record<string, unknown> | null;
  linked_ac_dtlkey?: number | string | null;
}

export interface CollapsedLine extends CollapsibleLine {
  /** Indexes into the input array that were folded into this one line. */
  sourceIndexes: number[];
  /** 'passthrough' for a line that is not a sofa compartment at all. */
  via: 'passthrough' | 'echo' | 'compose';
}

export interface SofaRefusal {
  /** Indexes into the input array that could not be collapsed. */
  sourceIndexes: number[];
  itemCodes: string[];
  reason: string;
}

export interface CollapseResult {
  lines: CollapsedLine[];
  refusals: SofaRefusal[];
}

/**
 * Split an ERP item code into {model, compartment}, or null when it is not a
 * sofa compartment code. The model never contains a hyphen (every one of the 46
 * minted models is alphanumeric) and no compartment suffix does either, so the
 * FIRST hyphen is the boundary.
 */
export function splitSofaCode(itemCode: string): { model: string; compartment: string } | null {
  const code = String(itemCode ?? '').trim();
  const i = code.indexOf('-');
  if (i <= 0 || i === code.length - 1) return null;
  const model = code.slice(0, i);
  const compartment = code.slice(i + 1);
  if (!COMPARTMENT_SET.has(compartment.toUpperCase())) return null;
  return { model, compartment };
}

const up = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
const sameSeq = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => up(v) === up(b[i]));

/** A sofa build carries recliner/power semantics iff a compartment says so. */
function hasMechanism(compartments: string[]): boolean {
  return compartments.some((c) => /\((R|P)\)/i.test(c));
}

// ── the inverse: compartments -> the owner's structure tokens ───────────────

/**
 * The token that decodes back to `comp` at position `i` of `n` pieces.
 *
 * Two of these are the measured corrections that took a naive inverse from
 * 86.2% to 98.7%, and they are not stylistic:
 *   - an armed END piece must be written nEL / nER, never a bare digit. A bare
 *     digit decodes left-then-right by POSITION, so "1ER + 1EL" round-tripped
 *     as a side-swapped sofa.
 *   - an armless piece must be written nNA verbatim. A bare digit only becomes
 *     NA in a MIDDLE slot, so a lone 1NA had no bare-digit spelling at all.
 * Everything else returning null is a build this module will not spell, and the
 * caller refuses rather than approximating it.
 */
function tokenFor(comp: string, i: number, n: number): string | null {
  const c = up(comp);
  const solo = n === 1;
  const left = i === 0;
  const right = i === n - 1;
  switch (c) {
    /* A BARE DIGIT IS NOT A SOLO SEAT. Measured against the decoder: "1 (28\")"
       and "2 (28\")" both decode to NOTHING at all, so the bare-digit spelling
       was a guaranteed refusal for every single-seat build. "1S" and "2S" decode
       back to exactly themselves. A solo 3S has no spelling at all — "3"
       decodes to nothing and "3S" decodes to the TWO-piece build
       [2A(LHF), 1A(RHF)], which is the one outcome that must never be written. */
    case '1S': return solo ? '1S' : null;
    case '2S': return solo ? '2S' : null;
    case '3S': return null;
    case '1NA': return '1NA';
    case '2NA': return '2NA';
    case 'CNR': return solo ? null : 'C';
    case 'CONSOLE': return 'CT';
    case 'STOOL': return 'STOOL';
    case '1A(LHF)': return solo ? null : '1EL';
    case '1A(RHF)': return solo ? null : '1ER';
    case '2A(LHF)': return solo ? null : '2EL';
    case '2A(RHF)': return solo ? null : '2ER';
    case '1B(LHF)': return left ? '1B' : null;
    case '2B(LHF)': return left ? '2B' : null;
    case '1B(RHF)': return left ? null : '1B';
    case '2B(RHF)': return left ? null : '2B';
    case 'L(LHF)': return left ? 'L' : null;
    case 'L(RHF)': return left ? null : 'L';
    case '1S(R)': return solo ? '1R' : null;
    case '1S(P)': return solo ? '1P' : null;
    case '1A(R)(LHF)': return !solo && left ? 'R' : null;
    case '1A(R)(RHF)': return !solo && right ? 'R' : null;
    case '1A(P)(LHF)': return !solo && left ? 'P' : null;
    case '1A(P)(RHF)': return !solo && right ? 'P' : null;
    case '1ABOX(LHF)': return '1NALT';
    case '1ABOX(RHF)': return '1NART';
    default: return null;
  }
}

/**
 * Spell a build as Desc2 text. Returns null when any compartment has no
 * spelling at this position — the caller then refuses.
 *
 * Layout: structure first, then size in inches, then the colour and any
 * specials as their own slash segments, which is the shape the decoder's own
 * segment splitter reads and the shape the account book already holds.
 */
export function composeSofaDesc2(
  compartments: string[],
  attrs: { size?: string | null; colour?: string | null; specials?: string[] },
): string | null {
  const toks: string[] = [];
  for (let i = 0; i < compartments.length; i += 1) {
    const t = tokenFor(compartments[i], i, compartments.length);
    if (!t) return null;
    toks.push(t);
  }
  let text = toks.join(' + ');
  if (attrs.size) text += ` (${attrs.size}")`;
  if (attrs.colour) text += ` / COL: ${attrs.colour}`;
  for (const s of attrs.specials ?? []) {
    const v = String(s ?? '').trim();
    /* A special that carries a '+' would look like a second structure segment
       and trip the decoder's own split guard, blanking the pieces. Refuse the
       whole compose rather than emit text that decodes to nothing. */
    if (!v) continue;
    if (v.includes('+') || v.includes('/')) return null;
    text += ` / ${v}`;
  }
  return text;
}

/** AutoCount's SODTL.Desc2 / PODTL.Desc2 are nvarchar(100). */
export const AC_DESC2_MAX = 100;

const specialKey = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/NILON/g, 'NYLON');

function sameSpecials(a: string[], b: string[]): boolean {
  const A = new Set(a.map(specialKey).filter(Boolean));
  const B = new Set(b.map(specialKey).filter(Boolean));
  if (A.size !== B.size) return false;
  for (const k of A) if (!B.has(k)) return false;
  return true;
}

/**
 * The gate. Decode `text` with the same decoder the importers use and answer
 * whether it reproduces this build exactly.
 */
export function decodesTo(
  text: string,
  model: string,
  compartments: string[],
  expect: { size?: string | null; colour?: string | null; specials?: string[] } | null,
): { ok: true } | { ok: false; why: string } {
  const recl = hasMechanism(compartments);
  let re: SofaParse;
  try {
    re = parseSofa(text, model, recl);
  } catch (e) {
    return { ok: false, why: `decoder threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!sameSeq(re.pieces, compartments)) {
    return {
      ok: false,
      why: `Desc2 decodes to [${re.pieces.join(', ') || 'nothing'}] but the ERP holds `
        + `[${compartments.join(', ')}]`,
    };
  }
  if (!expect) return { ok: true };
  if (up(re.size) !== up(expect.size)) {
    return { ok: false, why: `seat size decodes as ${re.size ?? 'none'}, expected ${expect.size ?? 'none'}` };
  }
  if (up(re.color) !== up(expect.colour)) {
    return { ok: false, why: `colour decodes as ${re.color ?? 'none'}, expected ${expect.colour ?? 'none'}` };
  }
  if (!sameSpecials(re.specials, expect.specials ?? [])) {
    return {
      ok: false,
      why: `special orders do not survive: [${re.specials.join('; ') || 'none'}] vs `
        + `[${(expect.specials ?? []).join('; ') || 'none'}]`,
    };
  }
  return { ok: true };
}

function readSpecials(v: Record<string, unknown> | null | undefined): string[] {
  const s = (v ?? {}).specials;
  if (!Array.isArray(s)) return [];
  return s.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * The longest whole-word prefix every compartment description shares.
 *
 * The house naming convention is "SOFA {model} {compartment}", so three
 * compartment rows agree on "SOFA 9028" and disagree after it. Nothing is
 * invented: the result is a substring of every input, or null.
 */
function sharedDescription(lines: CollapsibleLine[]): string | null {
  const parts = lines.map((l) => String(l.description ?? '').trim());
  if (parts.some((p) => !p)) return null;
  const words = parts.map((p) => p.split(/\s+/));
  const out: string[] = [];
  for (let i = 0; i < words[0].length; i += 1) {
    const w = words[0][i];
    if (!words.every((ws) => ws[i] === w)) break;
    out.push(w);
  }
  const text = out.join(' ').trim();
  return text || null;
}

/**
 * One run of consecutive compartment lines sharing a model and a Desc2 becomes
 * one AutoCount line — or N identical ones, when the run is an EXACT repeat of
 * the decoded build. The repeat check is arithmetic, not a heuristic: the run
 * must be the decoded piece list repeated a whole number of times, in order.
 * Anything else refuses, because guessing where one sofa ends and the next
 * begins is precisely the mistake that puts a wrong line in the account book.
 */
function collapseRun(
  run: { line: CollapsibleLine; index: number; compartment: string }[],
  model: string,
): { lines: CollapsedLine[] } | { refusal: string } {
  const codes = run.map((r) => r.line.item_code);
  const desc2 = String(run[0].line.description2 ?? '').trim();
  if (!desc2) {
    return { refusal: 'no Desc2 on the compartment lines — nothing to carry the build into AutoCount' };
  }
  if (desc2.length > AC_DESC2_MAX) {
    return {
      refusal: `Desc2 is ${desc2.length} characters and AutoCount's field holds ${AC_DESC2_MAX}; `
        + 'truncating would silently drop part of the build',
    };
  }

  const qtys = new Set(run.map((r) => Number(r.line.qty)));
  if (qtys.size !== 1) {
    return { refusal: `compartments disagree on quantity (${[...qtys].join(', ')})` };
  }
  const qty = Number(run[0].line.qty);

  const compartments = run.map((r) => r.compartment);
  const recl = hasMechanism(compartments);
  const ps = parseSofa(desc2, model, recl);

  const build = ps.pieces;
  let reps = 0;
  if (build.length && run.length % build.length === 0) {
    const n = run.length / build.length;
    let all = true;
    for (let k = 0; k < n && all; k += 1) {
      all = sameSeq(build, compartments.slice(k * build.length, (k + 1) * build.length));
    }
    if (all) reps = n;
  }

  const mkLine = (
    slice: { line: CollapsibleLine; index: number }[],
    text: string,
    via: 'echo' | 'compose',
  ): CollapsedLine => {
    /* EVERY compartment must carry the key, not just some of them. A build where
       one row has a key and the next has none is a persistLineKeys that failed
       half way, or a backfill that matched one compartment — evidence that the
       mapping is broken, not evidence of line identity. Taking the one key that
       is present would edit an AutoCount line on the strength of a row that
       disagrees. */
    const present = slice.map((r) => r.line.linked_ac_dtlkey);
    const keys = present.every((k) => k != null)
      ? new Set(present.map((k) => String(k)))
      : new Set<string>();
    return {
      item_code: `${model}-1S`,
      item_group: slice[0].line.item_group ?? 'sofa',
      description: sharedDescription(slice.map((r) => r.line)),
      description2: text,
      qty,
      /* The importer put the AutoCount line price on the FIRST compartment and
         zero on the rest, so the sum is the original unit price. Summing rather
         than reading the first also stays right if an operator later spread it. */
      unit_price_centi: slice.reduce((s, r) => s + (Number(r.line.unit_price_centi) || 0), 0),
      location: slice[0].line.location ?? null,
      delivery_date: slice[0].line.delivery_date ?? null,
      variants: slice[0].line.variants ?? null,
      /* One AutoCount line has ONE DtlKey. Only a single value shared by the
         whole build is line identity; anything else is NULL, which composeEdit
         refuses loudly. A wrong DtlKey edits somebody else's line. */
      linked_ac_dtlkey: keys.size === 1 ? [...keys][0] : null,
      sourceIndexes: slice.map((r) => r.index),
      via,
    };
  };

  // 1. ECHO — the stored text already decodes to exactly what the ERP holds.
  if (reps > 0) {
    const out: CollapsedLine[] = [];
    for (let k = 0; k < reps; k += 1) {
      out.push(mkLine(run.slice(k * build.length, (k + 1) * build.length), desc2, 'echo'));
    }
    return { lines: out };
  }

  // 2. COMPOSE — the build no longer matches the text it was imported with.
  const v = (run[0].line.variants ?? {}) as Record<string, unknown>;
  const sizeRaw = v.seatHeight != null ? String(v.seatHeight).trim() : (ps.size ?? null);
  const size = sizeRaw ? sizeRaw.replace(/["']+$/, '') : null;
  const colour = v.colourLabel != null && String(v.colourLabel).trim()
    ? String(v.colourLabel).trim()
    : (ps.color ?? null);
  const specials = readSpecials(v).length ? readSpecials(v) : ps.specials;

  const composed = composeSofaDesc2(compartments, { size, colour, specials });
  if (!composed) {
    return {
      refusal: `cannot spell [${compartments.join(', ')}] in the AutoCount Desc2 grammar `
        + `(stored Desc2 "${desc2}" decodes to [${build.join(', ') || 'nothing'}])`,
    };
  }
  if (composed.length > AC_DESC2_MAX) {
    return {
      refusal: `composed Desc2 is ${composed.length} characters and AutoCount's field holds `
        + `${AC_DESC2_MAX}; truncating would silently drop part of the build`,
    };
  }
  const gate = decodesTo(composed, model, compartments, { size, colour, specials });
  if (!gate.ok) {
    return { refusal: `composed Desc2 does not survive a decode: ${gate.why}` };
  }
  return { lines: [mkLine(run, composed, 'compose')] };
}

/**
 * Fold every sofa compartment run in a document's line list into AutoCount's
 * one-line-per-sofa shape. Non-sofa lines pass through untouched and in order.
 *
 * Never throws. A build that cannot be collapsed faithfully appears in
 * `refusals` with a reason a human can act on; it is the CALLER's job to decide
 * that a document with any refusal does not sync (see toDetails).
 */
export function collapseSofaLines(lines: CollapsibleLine[]): CollapseResult {
  const out: CollapsedLine[] = [];
  const refusals: SofaRefusal[] = [];
  let run: { line: CollapsibleLine; index: number; compartment: string }[] = [];
  let runModel: string | null = null;
  let runDesc2: string | null = null;

  const flush = () => {
    if (!run.length || !runModel) { run = []; runModel = null; runDesc2 = null; return; }
    const r = collapseRun(run, runModel);
    if ('refusal' in r) {
      refusals.push({
        sourceIndexes: run.map((x) => x.index),
        itemCodes: run.map((x) => x.line.item_code),
        reason: `sofa ${runModel}: ${r.refusal}`,
      });
    } else {
      out.push(...r.lines);
    }
    run = [];
    runModel = null;
    runDesc2 = null;
  };

  lines.forEach((line, index) => {
    const split = splitSofaCode(line.item_code);
    /* item_group is advisory: the cutover importer sets 'sofa' on every
       compartment, but a hand-built line may leave it null. The compartment
       vocabulary is the real test, and a non-sofa group is a hard NO so a
       mattress that happens to be coded {x}-2S can never be folded. */
    const isSofa = split != null && (line.item_group == null || up(line.item_group) === 'SOFA');
    if (!isSofa) {
      flush();
      out.push({ ...line, sourceIndexes: [index], via: 'passthrough' });
      return;
    }
    const d2 = String(line.description2 ?? '').trim();
    if (runModel != null && (up(runModel) !== up(split.model) || runDesc2 !== d2)) flush();
    runModel = split.model;
    runDesc2 = d2;
    run.push({ line, index, compartment: split.compartment });
  });
  flush();

  return { lines: out, refusals };
}
