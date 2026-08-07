// Unit tests for the pure ChainNode builder behind the Purchase Order
// Relationship Map + the "From SOs: …" note fallback parser. They assert the
// map's two load-bearing behaviours: nodes are ANCHORED to this PO (a sibling
// PO's GRN must not paint this PO's GRN done — the hook feeds edge-walked
// nodes, and the builder renders exactly what it is given), and a pre-MRP PO
// (no so_item_id link) still names its source SOs from its own note.

import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../vendor/scm/lib/flow-queries';
import { buildPoChainNodes, parsePoNoteSos } from './po-relationship-map';

const node = (type: FlowNode['type'], id: string, label: string): FlowNode => ({
  key: `${type}:${id}`,
  type,
  id,
  label,
  status: null,
  isAnchor: false,
});

const header = { id: 'po-1', po_number: 'PO-1' };
const openAll = { canOpenSo: true, canOpenGrn: true, canOpenPi: true, canOpenPr: true };

const cell = (nodes: ReturnType<typeof buildPoChainNodes>, type: string) =>
  nodes.find((n) => n.type === type)!;

describe('buildPoChainNodes', () => {
  it('renders the 5-node purchase chain with the PO current', () => {
    const nodes = buildPoChainNodes(
      header,
      ['SO-1'],
      [node('grn', 'g1', 'GRN-1')],
      [node('pi', 'i1', 'PINV-1')],
      [],
      openAll,
    );
    expect(nodes.map((n) => n.type)).toEqual([
      'Sales Order', 'Purchase Order', 'GRN', 'Purchase Invoice', 'Purchase Return',
    ]);
    expect(cell(nodes, 'Purchase Order').state).toBe('current');
    expect(cell(nodes, 'Purchase Order').doc).toBe('PO-1');
    expect(cell(nodes, 'Sales Order').doc).toBe('SO-1');
    expect(cell(nodes, 'Sales Order').meta).toBe('Tap to open');
    expect(cell(nodes, 'GRN').doc).toBe('GRN-1');
    expect(cell(nodes, 'Purchase Invoice').doc).toBe('PINV-1');
    expect(cell(nodes, 'Purchase Return').state).toBe('pending');
    expect(cell(nodes, 'Purchase Return').doc).toBe('None');
  });

  it('reads a stock buy (no source SO) honestly', () => {
    const nodes = buildPoChainNodes(header, [], [], [], [], openAll);
    const so = cell(nodes, 'Sales Order');
    expect(so.state).toBe('pending');
    expect(so.doc).toBe('Not linked');
    expect(so.meta).toBe('Stock buy — no source SO');
    expect(cell(nodes, 'GRN').doc).toBe('Not created');
    expect(cell(nodes, 'GRN').meta).toBe('On supplier delivery');
    expect(cell(nodes, 'Purchase Invoice').meta).toBe('On supplier billing');
  });

  it('collapses several docs to a count and labels access gates', () => {
    const nodes = buildPoChainNodes(
      header,
      ['SO-1', 'SO-2'],
      [node('grn', 'g1', 'GRN-1'), node('grn', 'g2', 'GRN-2')],
      [],
      [],
      { ...openAll, canOpenSo: false, canOpenGrn: false },
    );
    expect(cell(nodes, 'Sales Order').doc).toBe('2 sales orders');
    expect(cell(nodes, 'Sales Order').meta).toBe('Sales document');
    expect(cell(nodes, 'GRN').doc).toBe('2 GRNs');
    expect(cell(nodes, 'GRN').meta).toBe('Procurement document');
  });

  it('paints a Purchase Return from the graph', () => {
    const nodes = buildPoChainNodes(
      header, [], [node('grn', 'g1', 'GRN-1')], [], [node('pr', 'r1', 'PRET-1')], openAll,
    );
    expect(cell(nodes, 'Purchase Return').state).toBe('done');
    expect(cell(nodes, 'Purchase Return').doc).toBe('PRET-1');
    expect(cell(nodes, 'Purchase Return').meta).toBe('Tap to open');
  });

  /* "Soft until DO, hard from DO" — the floating slot. A live MRP pairing is
     shown but never painted as Linked: it floats (dashed, tappable) and a
     stored raise-link always beats it for the slot's solid state. */
  it('floats a live MRP pairing on a stock buy — pending + float, never done', () => {
    const nodes = buildPoChainNodes(header, [], [], [], [], openAll, ['SO-9']);
    const so = cell(nodes, 'Sales Order');
    expect(so.doc).toBe('SO-9');
    expect(so.state).toBe('pending');
    expect(so.float).toBe(true);
    expect(so.actionable).toBe(true);
    expect(so.meta).toBe('Live MRP pairing — tap');
  });

  it('a stored raise-link keeps the slot solid; extra floating SOs join the count', () => {
    const nodes = buildPoChainNodes(header, ['SO-1'], [], [], [], openAll, ['SO-1', 'SO-2']);
    const so = cell(nodes, 'Sales Order');
    expect(so.doc).toBe('2 sales orders'); // SO-1 stored + SO-2 floating, deduped
    expect(so.state).toBe('done');
    expect(so.float).toBe(false);
  });

  it('no floating arg keeps the legacy shape (backwards compatible)', () => {
    const nodes = buildPoChainNodes(header, [], [], [], [], openAll);
    const so = cell(nodes, 'Sales Order');
    expect(so.doc).toBe('Not linked');
    expect(so.float).toBe(false);
    expect(so.actionable).toBe(false);
  });
});

describe('parsePoNoteSos (the pre-MRP "From SOs: …" fallback)', () => {
  it('extracts the doc numbers the note records', () => {
    expect(parsePoNoteSos('From SOs: 2990-SO-2607-016')).toEqual(['2990-SO-2607-016']);
    expect(parsePoNoteSos('From SO: SO-2606-033, SO-2606-034')).toEqual([
      'SO-2606-033', 'SO-2606-034',
    ]);
  });

  it('dedupes and trims tokens', () => {
    expect(parsePoNoteSos('From SOs: SO-1 , SO-1, SO-2')).toEqual(['SO-1', 'SO-2']);
  });

  it('returns [] for a plain free-text note or no note', () => {
    expect(parsePoNoteSos('urgent — call the supplier first')).toEqual([]);
    expect(parsePoNoteSos('')).toEqual([]);
    expect(parsePoNoteSos(null)).toEqual([]);
    expect(parsePoNoteSos(undefined)).toEqual([]);
  });
});
