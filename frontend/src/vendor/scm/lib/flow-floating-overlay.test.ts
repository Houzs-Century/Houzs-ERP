// The floating PO↔SO pairing overlay ("soft until DO, hard from DO").
//
// The load-bearing assertion is the ONE-ENGINE SYMMETRY: the floating edge set
// must equal EXACTLY the po-so-coverage assignments whose `source` is 'mrp' —
// nothing added (no guessing at unlabelled assignments), nothing dropped
// (dedup across SKUs only). 'delivered' and 'linked' assignments are anchored
// or provenance and must never float; an assignment with no `source` (older
// backend) must not be floated on a locked:false hunch.

import { describe, expect, it } from 'vitest';
import {
  buildFloatingOverlay,
  floatingSoDocNos,
  type FlowNode,
  type PoSoCoverageResp,
} from './flow-queries';

const soNode = (docNo: string): FlowNode => ({
  key: `so:${docNo}`, type: 'so', id: docNo, label: docNo, status: 'CONFIRMED', isAnchor: false,
});
const poNode = (id: string, label: string): FlowNode => ({
  key: `po:${id}`, type: 'po', id, label, status: 'ORDERED', isAnchor: true,
});

const coverage = (over: Partial<PoSoCoverageResp>): PoSoCoverageResp => ({
  poNumber: 'PO-1', poId: 'po-1', origins: [], ...over,
});

describe('floatingSoDocNos (the mrp-source assignment set)', () => {
  it("equals exactly the assignments with source 'mrp' — deduped across SKUs", () => {
    const resp = coverage({
      origins: [
        { itemCode: 'A', assignments: [
          { soDocNo: 'SO-1', deliveryDate: null, locked: false, source: 'mrp' },
          { soDocNo: 'SO-2', deliveryDate: null, locked: true, source: 'linked' },
        ] },
        { itemCode: 'B', assignments: [
          { soDocNo: 'SO-1', deliveryDate: null, locked: false, source: 'mrp' },
          { soDocNo: 'SO-3', deliveryDate: null, locked: false, source: 'mrp' },
          { soDocNo: 'SO-4', deliveryDate: null, locked: true, source: 'delivered' },
        ] },
      ],
    });
    expect(floatingSoDocNos(resp).sort()).toEqual(['SO-1', 'SO-3']);
  });

  it('never floats an unlabelled assignment (older backend), even when locked:false', () => {
    const resp = coverage({
      origins: [{ itemCode: 'A', assignments: [{ soDocNo: 'SO-9', deliveryDate: null, locked: false }] }],
    });
    expect(floatingSoDocNos(resp)).toEqual([]);
  });

  it('is empty on empty / missing input', () => {
    expect(floatingSoDocNos(undefined)).toEqual([]);
    expect(floatingSoDocNos(coverage({}))).toEqual([]);
  });
});

describe('buildFloatingOverlay (merge for rendering)', () => {
  const resp = coverage({
    origins: [
      { itemCode: 'A', assignments: [
        { soDocNo: 'SO-1', deliveryDate: null, locked: false, source: 'mrp' },
        { soDocNo: 'SO-2', deliveryDate: null, locked: true, source: 'linked' },
      ] },
    ],
  });

  it('produces one SO▶PO edge per floating SO, keyed like the stored graph', () => {
    const overlay = buildFloatingOverlay({ nodes: [poNode('po-1', 'PO-1')] }, resp);
    expect(overlay.edges).toEqual([{ from: 'so:SO-1', to: 'po:po-1' }]);
  });

  it('synthesises only the endpoints the stored graph lacks', () => {
    // Graph already carries the PO and SO-1 → nothing to synthesise.
    const full = buildFloatingOverlay({ nodes: [poNode('po-1', 'PO-1'), soNode('SO-1')] }, resp);
    expect(full.nodes).toEqual([]);
    // Orphan graph (e.g. a GRN anchor of an unlinked PO) → both endpoints appear.
    const empty = buildFloatingOverlay({ nodes: [] }, resp);
    expect(empty.nodes.map((n) => n.key).sort()).toEqual(['po:po-1', 'so:SO-1']);
    const po = empty.nodes.find((n) => n.key === 'po:po-1')!;
    expect(po.label).toBe('PO-1');
    expect(po.isAnchor).toBe(false);
  });

  it('is empty without a resolvable PO id or without floating assignments', () => {
    expect(buildFloatingOverlay({ nodes: [] }, coverage({ poId: null }))).toEqual({ nodes: [], edges: [] });
    expect(buildFloatingOverlay({ nodes: [] }, undefined)).toEqual({ nodes: [], edges: [] });
    expect(buildFloatingOverlay(undefined, coverage({}))).toEqual({ nodes: [], edges: [] });
  });
});
