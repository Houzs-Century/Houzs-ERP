import { SPECIAL_ORDER_POINTER } from './autocount-desc2-abbrev';
import { liveColour } from '../scm/shared/variant-summary';
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
  unit_price_sen: number;
  location?: string | null;
  delivery_date?: string | null;
  variants?: Record<string, unknown> | null;
  linked_ac_dtlkey?: number | string | null;
  /** The line's place on the ERP document, when its table has one. It states the
   *  order the pieces were typed; the read order does not (docs/bugs/0920). */
  line_no?: number | null;
}

export interface CollapsedLine extends CollapsibleLine {
  sourceIndexes: number[];
  via: 'passthrough' | 'echo' | 'compose';
}

export interface SofaRefusal {
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

function hasMechanism(compartments: string[]): boolean {
  return compartments.some((c) => /\((R|P)\)/i.test(c));
}


function tokenFor(comp: string, i: number, n: number): string | null {
  const c = up(comp);
  const solo = n === 1;
  const left = i === 0;
  const right = i === n - 1;
  switch (c) {
    case '1S': return '1S';
    case '2S': return '2S';
    case '3S': return '3S';
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
    case 'L(LHF)': return left ? 'L' : 'LL';
    case 'L(RHF)': return left ? 'LR' : 'L';
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
    if (!v) continue;
    if (v.includes('+') || v.includes('/')) return null;
    text += ` / ${v}`;
  }
  return text;
}

/** AutoCount's SODTL.Desc2 / PODTL.Desc2 are nvarchar(100). */
export const AC_DESC2_MAX = 100;

const specialKey = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/NILON/g, 'NYLON');

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const count = (xs: string[]) => xs.reduce<Map<string, number>>(
    (m, x) => m.set(up(x), (m.get(up(x)) ?? 0) + 1), new Map());
  const A = count(a);
  const B = count(b);
  for (const [k, n] of A) if (B.get(k) !== n) return false;
  return true;
}

/* AN ARMED END IS AN END (docs/bugs/0906). The book's decoder reads a plain
   armed end — 1EL / 2EL / 1ER / 2ER — as the end of the sofa its hand names
   whatever position the token takes: `CT + 2EL + 1ER` decodes to
   [2A(LHF), Console, 1A(RHF)]. The ERP lists pieces in the order they were
   typed, so HC-SO-012736 holds [Console, 2A(LHF), 1A(RHF)] and the composed text
   was refused for decoding into the only arrangement those pieces can take.

   Returns the decoded arrangement only when it is the ERP's pieces with nothing
   moved except armed ends, each now at the end its hand names: at most one left
   and one right armed end, every other piece in the ERP's relative order, the
   left end first and the right end last. Anything else — two sofas' worth of
   ends, a middle piece moved, a chaise, a recliner arm — returns null and the
   exact comparison stands. Handedness is never changed, so this cannot write
   the mirror. */
const ARMED_END = /^[12]A\((LHF|RHF)\)$/;
function armedEndsPlaced(text: string, model: string, erp: string[]): string[] | null {
  const e = erp.map(up);
  const lefts = e.filter((p) => ARMED_END.test(p) && p.endsWith('(LHF)'));
  const rights = e.filter((p) => ARMED_END.test(p) && p.endsWith('(RHF)'));
  if (lefts.length > 1 || rights.length > 1 || lefts.length + rights.length === 0) return null;
  let decoded: string[];
  try {
    decoded = parseSofa(text, model, hasMechanism(erp)).pieces;
  } catch {
    return null;
  }
  const d = decoded.map(up);
  if (!sameMultiset(d, e) || sameSeq(d, e)) return null;
  const middle = (xs: string[]) => xs.filter((p) => !ARMED_END.test(p));
  if (!sameSeq(middle(d), middle(e))) return null;
  if (lefts.length && d[0] !== lefts[0]) return null;
  if (rights.length && d[d.length - 1] !== rights[0]) return null;
  return decoded;
}

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
  const expected = expect.specials ?? [];
  const pointing = expected.length === 1 && expected[0] === SPECIAL_ORDER_POINTER;
  if (pointing) {
    if (!text.includes(SPECIAL_ORDER_POINTER)) {
      return {
        ok: false,
        why: 'the special order was replaced by a pointer and the pointer is not in the text',
      };
    }
    return { ok: true };
  }
  if (!sameSpecials(re.specials, expected)) {
    return {
      ok: false,
      why: `special orders do not survive: [${re.specials.join('; ') || 'none'}] vs `
        + `[${expected.join('; ') || 'none'}]`,
    };
  }
  return { ok: true };
}

function readSpecials(v: Record<string, unknown> | null | undefined): string[] {
  const s = (v ?? {}).specials;
  if (!Array.isArray(s)) return [];
  return s.map((x) => String(x ?? '').trim()).filter(Boolean);
}

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

function collapseRun(
  run: { line: CollapsibleLine; index: number; compartment: string }[],
  model: string,
  bookGrouped: boolean,
  /* Pieces of ANOTHER model the book holds on this line, as `CNR 8069`
     (docs/bugs/0913). Every one is written into the text and must be present in
     whatever is sent; `[]` for a build of one model. Required, so a caller that
     gathers a mixed build cannot forget to say so. */
  foreign: string[],
): { lines: CollapsedLine[] } | { refusal: string } {
  /* THE DOCUMENT'S LINE ORDER, NOT THE READ ORDER (docs/bugs/0920). The queue
     reads rows by created_at then row id, and an amendment re-derives a build's
     pieces at one instant, so their read order is the ids'. HC-SO-002861 was sent
     `1EL + C + 1B + CT + 1NA` while its lines read 1A(LHF), CNR, 1NA, Console,
     1B(RHF). Where every piece has a line number, the pieces are spelled in that
     order; otherwise they stay as they came. */
  const lineNos = run.map((r) => r.line.line_no);
  if (lineNos.every((n) => typeof n === 'number' && Number.isFinite(n)) && new Set(lineNos).size === run.length) {
    run = [...run].sort((a, b) => Number(a.line.line_no) - Number(b.line.line_no));
  }
  const codes = run.map((r) => r.line.item_code);
  const namesForeign = (text: string) => foreign.every((f) => text.includes(f));
  const desc2 = String(run[0].line.description2 ?? '').trim();
  if (!desc2) {
    return { refusal: 'no Desc2 on the compartment lines — nothing to carry the build into AutoCount' };
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
      unit_price_sen: slice.reduce((s, r) => s + (Number(r.line.unit_price_sen) || 0), 0),
      location: slice[0].line.location ?? null,
      delivery_date: slice[0].line.delivery_date ?? null,
      variants: slice[0].line.variants ?? null,
      linked_ac_dtlkey: keys.size === 1 ? [...keys][0] : null,
      sourceIndexes: slice.map((r) => r.index),
      via,
    };
  };

  const v = (run[0].line.variants ?? {}) as Record<string, unknown>;
  const sizeRaw = v.seatHeight != null ? String(v.seatHeight).trim() : (ps.size ?? null);
  const size = sizeRaw ? sizeRaw.replace(/["']+$/, '') : null;
  const colourRaw = v.colourLabel != null && String(v.colourLabel).trim()
    ? String(v.colourLabel).trim()
    : (ps.color ?? null);
  const colour = colourRaw ? liveColour(colourRaw) : null;
  const specials = readSpecials(v).length ? readSpecials(v) : ps.specials;

  const pieces = bookGrouped && sameMultiset(build, compartments) ? build : compartments;

  if ((reps > 0 || pieces !== compartments)
    && desc2.length <= AC_DESC2_MAX
    && namesForeign(desc2)
    && decodesTo(desc2, model, build, { size, colour, specials }).ok) {
    if (pieces !== compartments) return { lines: [mkLine(run, desc2, 'echo')] };
    const out: CollapsedLine[] = [];
    for (let k = 0; k < reps; k += 1) {
      out.push(mkLine(run.slice(k * build.length, (k + 1) * build.length), desc2, 'echo'));
    }
    return { lines: out };
  }

  /* 2. COMPOSE, and 3. POINT AT THE ERP if the special order is what blocks it.
     One attempt, tried twice: once with the special orders the ERP holds, and —
     only if that fails and there ARE any — once with the owner's pointer.

     THE POINTER IS TRIED FOR EVERY WAY A SPECIAL CAN BLOCK A DOCUMENT, not only
     for length. Measured on production 2026-09-10, the special order was the
     whole obstacle on three more builds and in three different disguises:

       · composeSofaDesc2 REFUSES a special containing `+` or `/`, and the
         refusal reads "cannot spell [2A(LHF), STOOL]" — which names the pieces
         and blames them (HC-SO-001526, HC-SO-001445);
       · the decoder reads specials from a FIXED vocabulary, so `ALL` and
         `DAYBED` never come back and the round trip fails on a build that is
         otherwise perfect (HC-SO-008302, HC-SO-004716);
       · and the text is over the column (the length case, already known).

     The owner's ruling covers all three — 「Special Order 可以不进 ... 最重要是每
     一张单都可以进到就行了」 — because what it says is that the special order need
     not reach AutoCount at all, not that it may be shortened when long.

     THE REFUSAL REPORTED IS THE FIRST ATTEMPT'S. When both fail, the honest
     diagnosis is what went wrong with the document as it stands, not with a
     rewrite of it. */
  const attempt = (sp: string[]): { text: string } | { why: string } => {
    const spelled = composeSofaDesc2(pieces, { size, colour, specials: sp });
    const t = spelled == null ? null : [spelled, ...foreign].join(' / ');
    if (!t) {
      return {
        why: `cannot spell [${pieces.join(', ')}] in the AutoCount Desc2 grammar `
          + `(stored Desc2 "${desc2}" decodes to [${build.join(', ') || 'nothing'}])`,
      };
    }
    if (t.length > AC_DESC2_MAX) {
      return {
        why: `composed Desc2 is ${t.length} characters and AutoCount's field holds `
          + `${AC_DESC2_MAX}; truncating would silently drop part of the build`,
      };
    }
    let g = decodesTo(t, model, pieces, { size, colour, specials: sp });
    const placed = g.ok ? null : armedEndsPlaced(t, model, pieces);
    if (placed) g = decodesTo(t, model, placed, { size, colour, specials: sp });
    if (!g.ok) return { why: `composed Desc2 does not survive a decode: ${g.why}` };
    if (!namesForeign(t)) return { why: `composed Desc2 does not name the piece(s) of another model: ${foreign.join(', ')}` };
    return { text: t };
  };

  const full = attempt(specials);
  if ('text' in full) return { lines: [mkLine(run, full.text, 'compose')] };
  if (specials.length) {
    const pointed = attempt([SPECIAL_ORDER_POINTER]);
    if ('text' in pointed) return { lines: [mkLine(run, pointed.text, 'compose')] };
  }

  if (desc2.length <= AC_DESC2_MAX && sameMultiset(build, compartments)
    && namesForeign(desc2)
    && decodesTo(desc2, model, build, { size, colour, specials }).ok) {
    return { lines: [mkLine(run, desc2, 'echo')] };
  }
  return { refusal: full.why };
}

/**
 * The sofas whose pieces the BOOK says are one line, and this file's own
 * adjacency rule would not put together.
 *
 * A sofa is ONE line in AutoCount and several here, and every piece carries that
 * one line's DtlKey (`docs/autocount-integration-map.md` 4.2). The runs below
 * are formed by adjacency, which is right whenever nothing interrupts a sofa and
 * wrong the moment something does: HC-SO-001526 holds `1EL` and `2ER` of one
 * sofa with ANOTHER sofa's two lines between them, so each end was collapsed
 * alone — and `1EL` by itself decodes to a single seat, not a left arm. Four
 * more documents are the same shape (HC-SO-001255, HC-SO-002315, HC-SO-004716,
 * HC-SO-012016), measured on production 2026-09-10.
 *
 * NON-CONTIGUOUS ONLY, deliberately — or contiguous with DIFFERENT Desc2, which
 * the adjacency rule splits just the same. A run the adjacency rule already
 * forms is left to it, so this can only change the documents that are broken
 * today.
 *
 * A PIECE OF ANOTHER MODEL (docs/bugs/0913). A key is the book's line, so pieces
 * of two models under one key are one sofa the book already holds — HC-SO-002861
 * is DSL-8060 SOFA 184398, whose amendment turned one piece into an 8069 corner.
 * Grouping by model as well as key split that sofa in two, and the lone 8069
 * corner was refused ("cannot spell [CNR]"), so the document could never reach
 * the book. Now the pieces are gathered under the model that holds a STRICT
 * majority of them, and every other piece is NAMED in the text (`CNR 8069`), so
 * the difference is written into the book rather than hidden behind a composed
 * line. With no majority the models are grouped apart as before, and refused.
 */
type Piece = { line: CollapsibleLine; index: number; compartment: string };
type BookGroup = { pieces: Piece[]; model: string; foreign: string[] };

function scatteredByBookLine(lines: CollapsibleLine[]): Map<number, BookGroup> {
  const byKey = new Map<string, (Piece & { model: string })[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const split = splitSofaCode(line.item_code);
    if (!split) continue;
    if (line.item_group != null && up(line.item_group) !== 'SOFA') continue;
    const key = line.linked_ac_dtlkey;
    if (key == null) continue;
    const bucket = byKey.get(String(key)) ?? [];
    bucket.push({ line, index, compartment: split.compartment, model: split.model });
    byKey.set(String(key), bucket);
  }
  const groups: BookGroup[] = [];
  for (const bucket of byKey.values()) {
    const perModel = new Map<string, (Piece & { model: string })[]>();
    for (const p of bucket) perModel.set(up(p.model), [...(perModel.get(up(p.model)) ?? []), p]);
    const ranked = [...perModel.values()].sort((a, b) => b.length - a.length);
    const majority = ranked.length > 1 && ranked[0].length > bucket.length - ranked[0].length;
    if (majority) {
      const model = ranked[0][0].model;
      groups.push({
        pieces: bucket.map(({ line, index, compartment }) => ({ line, index, compartment })),
        model,
        foreign: bucket.filter((p) => up(p.model) !== up(model)).map((p) => `${p.compartment} ${p.model}`),
      });
      continue;
    }
    for (const same of perModel.values()) {
      groups.push({ pieces: same.map(({ line, index, compartment }) => ({ line, index, compartment })), model: same[0].model, foreign: [] });
    }
  }
  const out = new Map<number, BookGroup>();
  for (const g of groups) {
    const group = g.pieces;
    if (group.length < 2) continue;
    if (g.foreign.length) { out.set(group[0].index, g); continue; }
    const contiguous = group.every((x, i) => i === 0 || x.index === group[i - 1].index + 1);
    const oneText = new Set(group.map((x) => String(x.line.description2 ?? '').trim())).size === 1;
    if (contiguous && oneText) continue;
    out.set(group[0].index, g);
  }
  return out;
}

export function collapseSofaLines(lines: CollapsibleLine[]): CollapseResult {
  const out: CollapsedLine[] = [];
  const refusals: SofaRefusal[] = [];
  const scattered = scatteredByBookLine(lines);
  const consumed = new Set<number>();
  for (const g of scattered.values()) for (const x of g.pieces) consumed.add(x.index);
  let run: { line: CollapsibleLine; index: number; compartment: string }[] = [];
  let runModel: string | null = null;
  let runDesc2: string | null = null;

  const flush = () => {
    if (!run.length || !runModel) { run = []; runModel = null; runDesc2 = null; return; }

    /* COLLAPSE ONLY WHAT AUTOCOUNT ALREADY HOLDS AS ONE LINE.
     *
     * Owner 2026-08-13: a NEW order sends one AutoCount line per ERP line —
     * '9028-1A(LHF)' and '9028-2A(RHF)' each go in as themselves. Old orders
     * are untouched, and the book is full of them in the folded shape: 658 real
     * sofa lines, one line per build with the compartments in Desc2.
     *
     * The keys say which is which, and they say it per BUILD, so a document can
     * hold both shapes without either being guessed at:
     *
     *   compartments sharing ONE DtlKey -> one line in the book -> fold, so an
     *     edit rewrites that line's Desc2 instead of appending duplicates.
     *   compartments with DISTINCT keys -> already separate lines -> leave them.
     *   no keys at all                  -> the book has never seen this -> leave
     *     them, which is what makes a create send one line per ERP line.
     *
     * "Has a key" would NOT do: a new order's lines get their keys back from
     * the create, so its first edit would fold two real book lines into one.
     *
     * MIXED keys are neither, and they are the dangerous one: some compartments
     * of a build carrying a key means the book DOES hold it folded, while the
     * ERP's record of that is incomplete. Emitting them separately would append
     * duplicates of a line already in a licensed ledger. Those still fold, so
     * the key resolves to null and the existing keyless-line refusal stops the
     * document and asks for a backfill — unchanged behaviour, deliberately. */
    const keys = run.map((x) => x.line.linked_ac_dtlkey ?? null);
    const neverSent = keys.every((k) => k == null);
    const alreadySeparate = keys.length > 1
      && keys.every((k) => k != null)
      && new Set(keys.map(String)).size === keys.length;
    /* A PIECE LINE, NOT A ONE-PIECE BUILD (docs/bugs/0909). A single keyed
       compartment folds because a folded build of one piece is a real shape.
       It is not a real shape for a piece the book's grammar has no solo word
       for — an armed end, a corner, a chaise — while the SAME document holds
       another piece of that model under a DIFFERENT key: that document stores
       its pieces as separate book lines. HC-PO-2609-063 carries 8030 1A(LHF)
       and 1A(RHF) as book lines 929346 and 929348 with a pillow between them,
       HC-PO-2609-047 carries 9028 L(LHF) and 2A(RHF) as 928220 and 928221 with
       different specials, and each piece was folded alone and refused
       ("cannot spell [2A(RHF)]"). Such a piece goes through as itself. */
    const pieceLine = run.length === 1 && keys[0] != null && !tokenFor(run[0].compartment, 0, 1)
      && lines.some((l, i) => {
        if (i === run[0].index || l.linked_ac_dtlkey == null) return false;
        if (l.item_group != null && up(l.item_group) !== 'SOFA') return false;
        const sp = splitSofaCode(l.item_code);
        return sp != null && up(sp.model) === up(runModel) && String(l.linked_ac_dtlkey) !== String(keys[0]);
      });
    if (neverSent || alreadySeparate || pieceLine) {
      for (const x of run) out.push({ ...x.line, sourceIndexes: [x.index], via: 'passthrough' });
      run = [];
      runModel = null;
      runDesc2 = null;
      return;
    }

    const r = collapseRun(run, runModel, false, []);
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
    if (consumed.has(index)) {
      const g = scattered.get(index);
      if (!g) return;
      flush();
      const group = g.pieces;
      const gModel = g.model;
      const gr = collapseRun(group, gModel, true, g.foreign);
      if ('refusal' in gr) {
        refusals.push({
          sourceIndexes: group.map((x) => x.index),
          itemCodes: group.map((x) => x.line.item_code),
          reason: `sofa ${gModel}: ${gr.refusal}`,
        });
      } else {
        out.push(...gr.lines);
      }
      return;
    }
    const split = splitSofaCode(line.item_code);
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
