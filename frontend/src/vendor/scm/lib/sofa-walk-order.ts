import { cellEdges, parseCompartmentStructure } from '@2990s/shared';

/* A sofa keyed in the backend SO editor stores its pieces as separate lines
   with no layout, so the PO reads the line order as the left-to-right walk.
   Staff do not always key them that way: HC-SO-2609-393 stored
   1A(LHF), 1A(RHF), Console, 2S and the PO drew the right arm in the middle
   (owner 2026-10-03: the real sofa is 1A(LHF) + Console + 1A(RHF), and the
   2S is a separate sofa). Two rules, owner-approved the same day:
     - a piece with an arm on BOTH sides (1S/2S/3S) is a sofa of its own;
     - of the rest, the LHF piece walks first and the RHF piece last, the
       pieces between keep their stored order.
   With more than one LHF or RHF piece the line order is the only evidence of
   which belongs where, so it is kept as stored. */

const isStandalone = (moduleId: string): boolean => {
  const e = cellEdges({ moduleId, x: 0, y: 0, rot: 0 });
  return e[0] === 'arm' && e[2] === 'arm';
};

const handOf = (moduleId: string): 'LHF' | 'RHF' | null =>
  parseCompartmentStructure(moduleId)?.orientation ?? null;

/** Split one model's pieces (stored order) into sofas, each in walking order,
 *  sofas in order of first appearance. */
export function splitBackendSofa<T>(pieces: readonly T[], moduleIdOf: (p: T) => string): T[][] {
  const sofas: Array<{ first: number; pieces: T[] }> = [];
  const rest: T[] = [];
  let restFirst = -1;
  pieces.forEach((p, i) => {
    if (isStandalone(moduleIdOf(p))) {
      sofas.push({ first: i, pieces: [p] });
    } else {
      if (restFirst < 0) restFirst = i;
      rest.push(p);
    }
  });
  if (rest.length > 0) {
    const lefts = rest.filter((p) => handOf(moduleIdOf(p)) === 'LHF');
    const rights = rest.filter((p) => handOf(moduleIdOf(p)) === 'RHF');
    const walked = lefts.length <= 1 && rights.length <= 1
      ? [...lefts, ...rest.filter((p) => handOf(moduleIdOf(p)) === null), ...rights]
      : rest;
    sofas.push({ first: restFirst, pieces: walked });
  }
  return sofas.sort((a, b) => a.first - b.first).map((s) => s.pieces);
}
