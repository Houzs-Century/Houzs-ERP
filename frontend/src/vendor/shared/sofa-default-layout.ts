// The PO PDF's plan view for a sofa booked as a bare module list (no stored
// geometry), plus the Console "Attached to" helpers the SO line editors use.
// Split out of sofa-build.ts, which it builds on.
import {
  cellEdges,
  cellsBbox,
  EDGE_E,
  EDGE_W,
  findModule,
  moduleFootprint,
  SOFA_MODULES,
  type Bbox,
  type Cell,
  type Depth,
  type Rot,
  type SofaModuleSpec,
} from './sofa-build';

/* ─── Default layout from a bare module list (PO PDF fallback, 2026-06-24) ───
 *
 * A sofa created in the BACKEND (SO New / Maintenance, NOT the POS
 * CustomBuilder) stores each module only as a per-line SKU — fabric/seat/leg
 * variants but NO x/y/rot geometry. There was never a real arrangement to
 * lose: the operator just picked modules as a LIST. This synthesizes a
 * sensible default plan-view from that list so the PO PDF's `drawSofaLayout`
 * has cells to render (geometry-less sofas previously drew nothing).
 *
 * Convention (matches apps/pos CustomBuilder / cellsFromComboModules EXACTLY):
 *   - x increases RIGHTWARD, y increases DOWNWARD, the FRONT faces +y (the TV).
 *   - modules tile LEFT→RIGHT in the GIVEN order, each at its `moduleFootprint`
 *     width, all rot=0, sharing the BACK edge (y=0 baseline). A taller chaise
 *     (L, d=165) therefore extends forward (+y) of the seating line — correct.
 *   - the L/chaise module's own LHF/RHF identity (and the order it appears in
 *     the list) carries handedness: a left-listed L(LHF) ends up the left
 *     chaise, a right-listed L(RHF) the right chaise — the configurator's
 *     decomposition convention (2+L → "2A(LHF) + L(RHF)", 3+L →
 *     "2A(LHF) + 1NA + L(RHF)"). `drawSofaLayout` then derives the arm sides
 *     from the laid-out positions, so LHF/RHF reads correctly with no extra
 *     rotation math.
 *
 * CORNERS TURN THE RUN (owner 2026-09-28, HC-SO-2609-221). A CNR is where the
 * sofa turns 90 degrees, so a list with one or two CNRs is an L or a U, never a
 * straight row: the back row runs left→right with each CNR at an end of it,
 * and the pieces beyond a CNR come FORWARD (toward the TV) as a side leg, their
 * backs to the outside. The list is read walking the seats from the left leg's
 * front, round the back, to the right leg's front — so "1A(LHF), CNR, 2NA, 1NA,
 * CNR, 1A(RHF)" is a U. An order whose two CNRs are adjacent (a "CNR x2" line
 * expanded, which kept no position) falls back to: each end piece is a leg,
 * everything between is the back row. One CNR with pieces on both sides puts
 * the longer side along the back. Three or more CNRs keep the straight row.
 *
 * SEPARATE SOFAS (owner 2026-10-02, HC-PO-2610-007). SO line order is
 * whatever the operator picked, and one base model on an order can be more
 * than one sofa: "1A(LHF), 1A(RHF), Console, 2S" drew one row with the right
 * arm mid-sofa. So the list is split first:
 *   - a module with arms on BOTH sides (1S / 2S / 3S) is a sofa on its own;
 *   - with no CNR, a left-end module (W arm, or an armless LHF piece such as
 *     L(LHF)) opens a run, a right-end module (E arm, or L(RHF)) closes it, and
 *     armless middles (1NA / 2NA / Console) sit between the ends of the run
 *     they were listed under;
 *   - with a CNR the remaining list stays ONE run in its given (walking) order,
 *     exactly as before — the corner rules above need that order;
 *   - a Console line that names the module it is joined to (`attachTo`,
 *     CONSOLE_ATTACH_KEY, picked on the SO line) sits on that module's open
 *     side, which wins over line order.
 * Several sofas stack as rows facing the TV, widest at the back, each centred
 * on the widest — the owner's sketch for 1A(LHF) + Console + 1A(RHF) behind a
 * 2S. There is no stored arrangement, so this is a readable default, not the
 * room plan. A single sofa is placed exactly as before (origin 0,0).
 *
 * Fail-soft: an unknown / unmeasurable module is SKIPPED (never throws); an
 * empty or all-unknown list returns []. The result is exactly the `Cell[]`
 * shape `drawSofaLayout` consumes (it reads cell.x/y/rot + moduleFootprint),
 * with `cellIndex` set to the placement order (back row first). */
export const buildDefaultSofaCells = (
  modules: ReadonlyArray<{ moduleId: string; attachTo: string | null }>,
  depth: Depth,
): Array<Cell & { cellIndex: number }> => {
  if (!Array.isArray(modules) || modules.length === 0) return [];
  type Known = RunPiece & { attachTo: string; armW: boolean; armE: boolean };
  const known: Known[] = [];
  for (const mod of modules) {
    const moduleId = (mod?.moduleId ?? '').trim();
    if (!moduleId) continue;
    const m = findModule(moduleId);
    if (!m) continue; // unknown module → skip (fail-soft, never throws)
    const fp = moduleFootprint(m, 0, depth);
    if (!(fp.w > 0) || !(fp.h > 0)) continue;
    const edges = cellEdges({ moduleId, x: 0, y: 0, rot: 0 });
    known.push({
      moduleId, m,
      attachTo: (mod?.attachTo ?? '').trim(),
      armW: edges[EDGE_W] === 'arm',
      armE: edges[EDGE_E] === 'arm',
    });
  }
  // An explicit join only counts when its target is on this order.
  const targets = new Set(known.filter((k) => !k.attachTo).map((k) => k.moduleId));
  const isAttached = (k: Known) => k.attachTo !== '' && targets.has(k.attachTo);
  const isLeftEnd = (k: Known) =>
    k.m.group !== 'Corner' && (k.armW || (!k.armE && /\(LHF\)/i.test(k.moduleId)));
  const isRightEnd = (k: Known) =>
    k.m.group !== 'Corner' && !k.armW && (k.armE || /\(RHF\)/i.test(k.moduleId));

  const pieces: Known[][] = [];
  const rest = known.filter((k) => {
    if (isAttached(k)) return false;
    if (k.armW && k.armE) { pieces.push([k]); return false; }
    return true;
  });
  if (rest.some((k) => k.m.group === 'Corner')) {
    pieces.push(rest);
  } else {
    type Run = { left: Known[]; mid: Known[]; right: Known[] };
    const runs: Run[] = [];
    let cur: Run | null = null;
    const open = (): Run => {
      const r: Run = { left: [], mid: [], right: [] };
      runs.push(r);
      return r;
    };
    for (const k of rest) {
      if (isLeftEnd(k)) {
        if (!cur || cur.left.length > 0) cur = open();
        cur.left.push(k);
      } else if (isRightEnd(k)) {
        if (!cur || cur.right.length > 0) cur = open();
        cur.right.push(k);
      } else {
        if (!cur) cur = open();
        cur.mid.push(k);
      }
    }
    for (const r of runs) pieces.push([...r.left, ...r.mid, ...r.right]);
  }
  // Joined modules sit on the open side of their target: before a right end,
  // after anything else (a left end, a middle, a stand-alone 1S/2S/3S).
  for (const k of known.filter(isAttached)) {
    for (const ps of pieces) {
      const i = ps.findIndex((x) => x.moduleId === k.attachTo);
      if (i < 0) continue;
      ps.splice(isRightEnd(ps[i]!) ? i : i + 1, 0, k);
      break;
    }
  }

  const laid: Array<{ cells: Cell[]; bb: Bbox }> = [];
  for (const ps of pieces) {
    const cells = layoutRun(ps, depth);
    const bb = cellsBbox(cells, depth);
    if (cells.length > 0 && bb) laid.push({ cells, bb });
  }
  laid.sort((a, b) => b.bb.w - a.bb.w);
  if (laid.length === 0) return [];
  const widest = laid[0]!.bb.w;
  const out: Array<Cell & { cellIndex: number }> = [];
  let y = 0;
  for (const { cells, bb } of laid) {
    const dx = laid.length === 1 ? 0 : (widest - bb.w) / 2 - bb.x;
    const dy = laid.length === 1 ? 0 : y - bb.y;
    for (const c of cells) out.push({ ...c, x: c.x + dx, y: c.y + dy, cellIndex: out.length });
    y += bb.h + DEFAULT_ROW_GAP_CM;
  }
  return out;
};

const DEFAULT_ROW_GAP_CM = 30;

/** One sofa's cells from the origin, corners turning the run (see above). */
const layoutRun = (known: RunPiece[], depth: Depth): Cell[] => {
  const run = arrangeCornerRun(known);
  const out: Cell[] = [];
  const place = (moduleId: string, x: number, y: number, rot: Rot) =>
    out.push({ moduleId, x, y, rot });
  const cornerFp = (k: { m: SofaModuleSpec } | null) => (k ? moduleFootprint(k.m, 0, depth) : { w: 0, h: 0 });
  const left = cornerFp(run.leftCorner);
  const right = cornerFp(run.rightCorner);
  // Left leg: listed front→corner, so it stacks upward to meet the corner.
  let y = left.h;
  const leftCells: Array<{ moduleId: string; y: number }> = [];
  for (const k of [...run.left].reverse()) {
    leftCells.unshift({ moduleId: k.moduleId, y });
    y += moduleFootprint(k.m, 270, depth).h;
  }
  for (const c of leftCells) place(c.moduleId, 0, c.y, 270);
  if (run.leftCorner) place(run.leftCorner.moduleId, 0, 0, 0);
  let x = left.w;
  for (const k of run.back) {
    place(k.moduleId, x, 0, 0);
    x += moduleFootprint(k.m, 0, depth).w;
  }
  if (run.rightCorner) {
    place(run.rightCorner.moduleId, x, 0, 90);
    // Right leg: corner→front, backs flush with the corner's outer edge.
    y = right.h;
    for (const k of run.right) {
      const fp = moduleFootprint(k.m, 90, depth);
      place(k.moduleId, x + right.w - fp.w, y, 90);
      y += fp.h;
    }
  }
  return out;
};

/** Variant key on a geometry-less Console line naming the module it is joined
 *  to ("1A(LHF)"), picked on the SO line. Copied onto the PO line with the rest
 *  of `variants`, so the PO layout places the Console instead of guessing it
 *  from line order. Per-line: never inherited or cascaded to sibling lines. */
export const CONSOLE_ATTACH_KEY = 'attachTo';

const SOFA_MODULE_IDS_LONGEST_FIRST = SOFA_MODULES.map((m) => m.id).sort((a, b) => b.length - a.length);

/** The SOFA_MODULES id a sofa SKU code ends with ("SOFFIO-1A(LHF)" → "1A(LHF)"),
 *  longest match first. Null when the code carries no known module suffix. */
export const sofaModuleIdOfCode = (code: string): string | null => {
  const c = code.trim();
  if (!c) return null;
  return SOFA_MODULE_IDS_LONGEST_FIRST.find((id) => c.endsWith(id)) ?? null;
};

export const isConsoleModuleId = (id: string | null | undefined): boolean =>
  /^console/i.test((id ?? '').trim());

/** Modules a Console line can be joined to: the OTHER sofa lines of the same
 *  base model on this order (SKU minus its module suffix), accessories excluded,
 *  de-duplicated in line order. Null when the line at `selfIndex` is not a
 *  Console or there is nothing to join it to. */
export const consoleAttachOptions = (
  lines: ReadonlyArray<{ itemCode: string; itemGroup: string }>,
  selfIndex: number,
): string[] | null => {
  if (selfIndex < 0 || selfIndex >= lines.length) return null;
  const self = lines[selfIndex];
  if (self.itemGroup.toLowerCase() !== 'sofa') return null;
  const selfId = sofaModuleIdOfCode(self.itemCode);
  if (!selfId || !isConsoleModuleId(selfId)) return null;
  const baseOf = (code: string, id: string) => code.trim().slice(0, code.trim().length - id.length);
  const selfBase = baseOf(self.itemCode, selfId);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === selfIndex || l.itemGroup.toLowerCase() !== 'sofa') return;
    const id = sofaModuleIdOfCode(l.itemCode);
    if (!id || findModule(id)?.accessory) return;
    if (baseOf(l.itemCode, id) !== selfBase || out.includes(id)) return;
    out.push(id);
  });
  return out.length > 0 ? out : null;
};

type RunPiece = { moduleId: string; m: SofaModuleSpec };

/** Split a walked module list into left leg / back row / right leg around its
 *  corners (see buildDefaultSofaCells). No legs and no corners = straight row. */
const arrangeCornerRun = (pieces: RunPiece[]): {
  left: RunPiece[]; leftCorner: RunPiece | null; back: RunPiece[]; rightCorner: RunPiece | null; right: RunPiece[];
} => {
  const straight = { left: [], leftCorner: null, back: pieces, rightCorner: null, right: [] };
  const corners = pieces.flatMap((p, i) => (p.m.group === 'Corner' ? [i] : []));
  const runW = (ps: RunPiece[]) => ps.reduce((n, p) => n + p.m.w, 0);
  if (corners.length === 1) {
    const i = corners[0]!;
    const before = pieces.slice(0, i);
    const after = pieces.slice(i + 1);
    const corner = pieces[i]!;
    if (after.length === 0) return { left: [], leftCorner: null, back: before, rightCorner: corner, right: [] };
    if (before.length === 0 || runW(after) >= runW(before)) {
      return { left: before, leftCorner: corner, back: after, rightCorner: null, right: [] };
    }
    return { left: [], leftCorner: null, back: before, rightCorner: corner, right: after };
  }
  if (corners.length === 2) {
    const [i, j] = corners as [number, number];
    if (j > i + 1) {
      return { left: pieces.slice(0, i), leftCorner: pieces[i]!, back: pieces.slice(i + 1, j), rightCorner: pieces[j]!, right: pieces.slice(j + 1) };
    }
    const rest = pieces.filter((_, k) => k !== i && k !== j);
    const legs = rest.length >= 3;
    return {
      left: legs ? rest.slice(0, 1) : [],
      leftCorner: pieces[i]!,
      back: legs ? rest.slice(1, -1) : rest,
      rightCorner: pieces[j]!,
      right: legs ? rest.slice(-1) : [],
    };
  }
  return straight;
};
