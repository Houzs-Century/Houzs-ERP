// Unit tests for the pure ChainNode builder behind the Goods Received (GRN)
// Relationship Map. They assert the map's load-bearing behaviour: the chain is
// ANCHORED to this GRN (the hook feeds edge-walked parent-PO / PI / PR nodes, so
// a sibling GRN's invoice never paints this GRN's PI node done — the builder
// renders exactly what it is given), reading SO -> PO -> GRN (current) -> PI/PR
// with honest done / pending states, and a stock-buy GRN with no source SO says
// so rather than lying that its PO is "Not created".

import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../vendor/scm/lib/flow-queries';
import { buildGrnChainNodes } from './grn-relationship-map';

const node = (type: FlowNode['type'], id: string, label: string): FlowNode => ({
  key: `${type}:${id}`,
  type,
  id,
  label,
  status: null,
  isAnchor: false,
});

const header = { id: 'grn-1', grn_number: 'GRN-1' };
const openAll = { canOpenSo: true, canOpenPo: true, canOpenPi: true, canOpenPr: true };

const cell = (nodes: ReturnType<typeof buildGrnChainNodes>, type: string) =>
  nodes.find((n) => n.type === type)!;

describe('buildGrnChainNodes', () => {
  it('renders the 5-node receipt chain with the GRN current', () => {
    const nodes = buildGrnChainNodes(
      header,
      ['SO-1'],
      [node('po', 'p1', 'PO-1')],
      [node('pi', 'i1', 'PINV-1')],
      [],
      openAll,
    );
    expect(nodes.map((n) => n.type)).toEqual([
      'Sales Order', 'Purchase Order', 'GRN', 'Purchase Invoice', 'Purchase Return',
    ]);
    expect(cell(nodes, 'GRN').state).toBe('current');
    expect(cell(nodes, 'GRN').doc).toBe('GRN-1');
    expect(cell(nodes, 'Sales Order').doc).toBe('SO-1');
    expect(cell(nodes, 'Sales Order').meta).toBe('Tap to open');
    expect(cell(nodes, 'Purchase Order').doc).toBe('PO-1');
    expect(cell(nodes, 'Purchase Order').meta).toBe('Tap to open');
    expect(cell(nodes, 'Purchase Invoice').doc).toBe('PINV-1');
    expect(cell(nodes, 'Purchase Return').state).toBe('pending');
    expect(cell(nodes, 'Purchase Return').doc).toBe('None');
  });

  it('reads a stock buy (no source SO) honestly while still naming its PO', () => {
    const nodes = buildGrnChainNodes(header, [], [node('po', 'p1', 'PO-1')], [], [], openAll);
    const so = cell(nodes, 'Sales Order');
    expect(so.state).toBe('pending');
    expect(so.doc).toBe('Not linked');
    expect(so.meta).toBe('Stock buy — no source SO');
    expect(cell(nodes, 'Purchase Order').doc).toBe('PO-1');
    expect(cell(nodes, 'Purchase Order').state).toBe('done');
    expect(cell(nodes, 'Purchase Invoice').doc).toBe('Not created');
    expect(cell(nodes, 'Purchase Invoice').meta).toBe('On supplier billing');
  });

  it('collapses several docs to a count and labels access gates', () => {
    const nodes = buildGrnChainNodes(
      header,
      ['SO-1', 'SO-2'],
      [node('po', 'p1', 'PO-1'), node('po', 'p2', 'PO-2')],
      [],
      [],
      { ...openAll, canOpenSo: false, canOpenPo: false },
    );
    expect(cell(nodes, 'Sales Order').doc).toBe('2 sales orders');
    expect(cell(nodes, 'Sales Order').meta).toBe('Sales document');
    expect(cell(nodes, 'Purchase Order').doc).toBe('2 purchase orders');
    expect(cell(nodes, 'Purchase Order').meta).toBe('Procurement document');
  });

  it('paints a Purchase Return from the graph', () => {
    const nodes = buildGrnChainNodes(
      header, ['SO-1'], [node('po', 'p1', 'PO-1')], [], [node('pr', 'r1', 'PRET-1')], openAll,
    );
    expect(cell(nodes, 'Purchase Return').state).toBe('done');
    expect(cell(nodes, 'Purchase Return').doc).toBe('PRET-1');
    expect(cell(nodes, 'Purchase Return').meta).toBe('Tap to open');
  });

  it('reads a GRN with no resolvable PO honestly (defensive)', () => {
    const nodes = buildGrnChainNodes(header, [], [], [], [], openAll);
    const po = cell(nodes, 'Purchase Order');
    expect(po.state).toBe('pending');
    expect(po.doc).toBe('Not linked');
    expect(po.meta).toBe('No source PO');
  });
});
