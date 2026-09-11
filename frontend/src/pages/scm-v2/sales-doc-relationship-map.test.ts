// Unit tests for the pure ChainNode builders behind the DO / SI / DR
// Relationship Maps (audit R8). They assert the exact display gaps the live
// `/document-flow` read closes: the DO's false "GRN Not created", the SI's
// dropped payment nodes, and the DR's hard-coded "Upstream …" placeholders.

import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../vendor/scm/lib/flow-queries';
import {
  buildDoChainNodes,
  buildSiChainNodes,
  buildDrChainNodes,
} from './sales-doc-relationship-map';

const node = (type: FlowNode['type'], id: string, label: string): FlowNode => ({
  key: `${type}:${id}`,
  type,
  id,
  label,
  status: null,
  isAnchor: false,
});

const cell = (nodes: ReturnType<typeof buildDoChainNodes>, type: string) =>
  nodes.find((n) => n.type === type)!;

/* Every procurement route open, unless a test says otherwise. */
const OPEN = { canOpenPo: true, canOpenGrn: true, canOpenPi: true };
const SHUT = { canOpenPo: false, canOpenGrn: false, canOpenPi: false };

describe('buildDoChainNodes — the owner two-chain shape (2026-07-23) on the DO page', () => {
  const header = { id: 'do-1', do_number: 'DO-1', so_doc_no: 'SO-1' };

  it('paints the GRN node done with the real GRN when the graph has one', () => {
    const nodes = buildDoChainNodes(
      header, [node('so', 'SO-1', 'SO-1')], [], [], [node('grn', 'grn-9', 'GRN-9')], [], OPEN,
    );
    const grn = cell(nodes, 'GRN');
    expect(grn.state).toBe('done');
    expect(grn.doc).toBe('GRN-9'); // NOT "Not created"
    expect(grn.meta).toBe('Tap to open');
  });

  it('still reads "Not created" when the family has no GRN', () => {
    const nodes = buildDoChainNodes(header, [node('so', 'SO-1', 'SO-1')], [], [], [], [], OPEN);
    const grn = cell(nodes, 'GRN');
    expect(grn.state).toBe('pending');
    expect(grn.doc).toBe('Not created');
  });

  it('collapses several GRNs to a count and labels the procurement gate', () => {
    const nodes = buildDoChainNodes(
      header, [], [], [], [node('grn', 'g1', 'GRN-1'), node('grn', 'g2', 'GRN-2')], [], SHUT,
    );
    const grn = cell(nodes, 'GRN');
    expect(grn.doc).toBe('2 GRNs');
    expect(grn.meta).toBe('Procurement document');
  });

  it('paints the Sales Invoice node from the graph and keeps the DO current', () => {
    const nodes = buildDoChainNodes(header, [], [node('si', 'si-3', 'INV-3')], [], [], [], OPEN);
    expect(cell(nodes, 'Sales Invoice').state).toBe('done');
    expect(cell(nodes, 'Sales Invoice').doc).toBe('INV-3');
    expect(cell(nodes, 'Delivery Order').state).toBe('current');
  });

  /* THE CHANGE. The five-node chain put the GRN in the sales row with no room
     for the purchase order that produced it, so the DO page could say goods were
     received and never say what they were bought on. The graph has carried `po`
     and `pi` all along — only this builder never read them. */
  it('renders SEVEN nodes, in the order the canvas positions them', () => {
    const nodes = buildDoChainNodes(header, [], [], [], [], [], OPEN);
    expect(nodes.map((n) => n.type)).toEqual([
      'Customer PO', 'Sales Order', 'Delivery Order', 'Sales Invoice',
      'Purchase Order', 'GRN', 'Purchase Invoice',
    ]);
  });

  it('names the purchase order the goods were bought on', () => {
    const nodes = buildDoChainNodes(
      header, [], [], [node('po', 'po-7', 'HC-PO-009326')], [], [], OPEN,
    );
    const po = cell(nodes, 'Purchase Order');
    expect(po.state).toBe('done');
    expect(po.doc).toBe('HC-PO-009326');
    expect(po.meta).toBe('Tap to open');
  });

  it('collapses several purchase orders to a count', () => {
    const nodes = buildDoChainNodes(
      header, [], [], [node('po', 'p1', 'PO-1'), node('po', 'p2', 'PO-2')], [], [], OPEN,
    );
    expect(cell(nodes, 'Purchase Order').doc).toBe('2 purchase orders');
    expect(cell(nodes, 'Purchase Order').meta).toBe('Tap to list');
  });

  it('reads "On supplier order" while nothing has been bought yet', () => {
    const nodes = buildDoChainNodes(header, [], [], [], [], [], OPEN);
    const po = cell(nodes, 'Purchase Order');
    expect(po.state).toBe('pending');
    expect(po.doc).toBe('Not created');
    expect(po.meta).toBe('On supplier order');
  });

  it('names the supplier invoice, and gates PO and PI the same way as the GRN', () => {
    const nodes = buildDoChainNodes(
      header, [], [], [node('po', 'p1', 'PO-1')], [], [node('pi', 'pi-1', 'PI-1')], SHUT,
    );
    expect(cell(nodes, 'Purchase Invoice').doc).toBe('PI-1');
    /* A salesperson must never be handed a node that navigates into <Forbidden>
       — the tile says what it is and answers in a notice instead. */
    expect(cell(nodes, 'Purchase Order').meta).toBe('Procurement document');
    expect(cell(nodes, 'Purchase Invoice').meta).toBe('Procurement document');
  });
});

describe('buildSiChainNodes (audit R8 — SI restores payment nodes)', () => {
  const header = { id: 'si-1', invoice_number: 'INV-1', so_doc_no: 'SO-1' };

  it('paints the Payments node done and actionable when payments exist', () => {
    const nodes = buildSiChainNodes(
      header,
      [node('so', 'SO-1', 'SO-1')],
      [node('do', 'do-1', 'DO-1')],
      [node('payment', 'p1', 'CASH 500'), node('payment', 'p2', 'CARD 250')],
    );
    const pay = cell(nodes, 'Payments');
    expect(pay.state).toBe('done');
    expect(pay.doc).toBe('2 payments');
    expect(pay.actionable).toBe(true);
    // The dead "no GRN" tile is gone — no GRN node on the SI chain any more.
    expect(nodes.find((n) => n.type === 'GRN')).toBeUndefined();
  });

  it('reads "Not paid" and is not actionable with no payments', () => {
    const nodes = buildSiChainNodes(header, [], [], []);
    const pay = cell(nodes, 'Payments');
    expect(pay.state).toBe('pending');
    expect(pay.doc).toBe('Not paid');
    expect(pay.actionable).toBe(false);
  });

  it('shows a single payment by its own label and keeps the SI current', () => {
    const nodes = buildSiChainNodes(header, [], [], [node('payment', 'p1', 'CASH 500')]);
    expect(cell(nodes, 'Payments').doc).toBe('CASH 500');
    expect(cell(nodes, 'Sales Invoice').state).toBe('current');
    expect(nodes).toHaveLength(5);
  });
});

describe('buildDrChainNodes (audit R8 — DR shows real SO + SI, not "Upstream …")', () => {
  const header = { id: 'dr-1', return_number: 'DR-1', do_doc_no: 'DO-1' };

  it('resolves the Sales Order + Sales Invoice off the return DO', () => {
    const nodes = buildDrChainNodes(
      header,
      [node('so', 'SO-1', 'SO-1')],
      [node('do', 'do-1', 'DO-1')],
      [node('si', 'si-1', 'INV-1')],
    );
    const so = cell(nodes, 'Sales Order');
    const si = cell(nodes, 'Sales Invoice');
    expect(so.state).toBe('done');
    expect(so.doc).toBe('SO-1'); // NOT "Upstream of DO"
    expect(si.state).toBe('done');
    expect(si.doc).toBe('INV-1'); // NOT "Upstream doc"
    expect(cell(nodes, 'Delivery Return').state).toBe('current');
  });

  it('falls back to the header DO number and honest empties when the graph is bare', () => {
    const nodes = buildDrChainNodes(header, [], [], []);
    expect(cell(nodes, 'Delivery Order').doc).toBe('DO-1');
    expect(cell(nodes, 'Delivery Order').state).toBe('done'); // do_doc_no on header
    expect(cell(nodes, 'Sales Order').doc).toBe('Not linked');
    expect(cell(nodes, 'Sales Invoice').doc).toBe('Not created');
    expect(nodes).toHaveLength(5);
  });
});

/* THE REGRESSION (docs/bugs/0909). customerRefOf reads `ref` FIRST, but the
   three header types omitted the column, so the pages never passed it and the
   Customer PO node fell through to "Not linked". On live data `ref` is the ONLY
   filled reference on 174 of 246 delivery orders (po_doc_no is 0%-filled and
   customer_so_no carries a value on just 13), so the node read "Not linked" for
   the overwhelming majority of orders that DO carry a customer reference —
   e.g. HC-DO-011555, whose ref is HC10995. */
describe('Customer PO node resolves off `ref` — the only filled column on live data', () => {
  it('DO: renders the customer reference when ONLY ref is set', () => {
    const nodes = buildDoChainNodes(
      { id: 'do-1', do_number: 'HC-DO-011555', ref: 'HC10995' },
      [], [], [], [], [], OPEN,
    );
    const po = cell(nodes, 'Customer PO');
    expect(po.doc).toBe('HC10995'); // NOT "Not linked"
    expect(po.meta).toBe("Customer's own doc");
  });

  it('SI: renders the customer reference when ONLY ref is set', () => {
    const nodes = buildSiChainNodes(
      { id: 'si-1', invoice_number: 'INV-1', ref: 'HC10995' },
      [],
      [],
      [],
    );
    expect(cell(nodes, 'Customer PO').doc).toBe('HC10995');
  });

  it('DR: renders the customer reference when ONLY ref is set', () => {
    const nodes = buildDrChainNodes(
      { id: 'dr-1', return_number: 'DR-1', ref: 'HC10995' },
      [],
      [],
      [],
    );
    expect(cell(nodes, 'Customer PO').doc).toBe('HC10995');
  });

  it('still reads "Not linked" when the order carries no reference at all', () => {
    const nodes = buildDoChainNodes({ id: 'do-2', do_number: 'DO-2' }, [], [], [], [], [], OPEN);
    expect(cell(nodes, 'Customer PO').doc).toBe('Not linked');
  });

  it('ref outranks the legacy columns, matching every other surface', () => {
    const nodes = buildDoChainNodes(
      { id: 'do-3', do_number: 'DO-3', ref: 'HC10995', customer_so_no: 'SRC-SO', po_doc_no: 'LEGACY' },
      [], [], [], [], [], OPEN,
    );
    expect(cell(nodes, 'Customer PO').doc).toBe('HC10995');
  });
});
