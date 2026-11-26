
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentRelationshipMapModal, type ChainNode } from './DocumentRelationshipMapModal';

const sevenNodes: ChainNode[] = [
  { type: 'Customer PO', doc: 'HC10995', meta: "Customer's own doc", state: 'done' },
  { type: 'Sales Order', doc: 'HC-SO-012467', meta: 'Tap to open', state: 'done' },
  { type: 'Delivery Order', doc: 'HC-DO-011555', meta: 'This document', state: 'current' },
  { type: 'Sales Invoice', doc: 'Not created', meta: 'On completion', state: 'pending' },
  { type: 'Purchase Order', doc: 'HC-PO-009326', meta: 'Tap to open', state: 'done' },
  { type: 'GRN', doc: 'GRN-9', meta: 'Tap to open', state: 'done' },
  { type: 'Purchase Invoice', doc: 'Not created', meta: 'On supplier billing', state: 'pending' },
];

describe('DocumentRelationshipMapModal — the seven-node two-chain canvas', () => {
  it('labels both rows as the sales and purchase chains', () => {
    render(<DocumentRelationshipMapModal open nodes={sevenNodes} onClose={() => {}} />);
    expect(screen.getByText('Sales chain')).toBeTruthy();
    expect(screen.getByText('Purchase chain')).toBeTruthy();
  });

  it('draws all seven node cards, the purchase row included', () => {
    render(<DocumentRelationshipMapModal open nodes={sevenNodes} onClose={() => {}} />);
    for (const n of sevenNodes) expect(screen.getByText(n.type)).toBeTruthy();
    expect(screen.getByText('HC-PO-009326')).toBeTruthy();
    expect(screen.getByText('Purchase Invoice')).toBeTruthy();
  });

  it('gives every one of the seven cards a real position — none left undefined', () => {
    render(<DocumentRelationshipMapModal open nodes={sevenNodes} onClose={() => {}} />);
    const positioned = [...document.querySelectorAll<HTMLElement>('button[style]')].filter(
      (el) => el.style.position === 'absolute',
    );
    expect(positioned.length).toBeGreaterThanOrEqual(7);
    for (const el of positioned) {
      expect(el.style.left).not.toContain('undefined');
      expect(el.style.top).not.toContain('undefined');
    }
  });

  it('draws only five cards from a six-node array — six is not a shape the canvas has', () => {
    const six = sevenNodes.slice(0, 6);
    render(<DocumentRelationshipMapModal open nodes={six} onClose={() => {}} />);
    const cards = [...document.querySelectorAll<HTMLElement>('button[style]')].filter(
      (el) => el.style.position === 'absolute',
    );
    expect(cards).toHaveLength(5);
    expect(six[5]!.type).toBe('GRN');
    expect(cards.some((c) => c.textContent.includes('GRN-9'))).toBe(false);
  });

  it('still lays the legacy five-node chain out as one row plus a branch', () => {
    render(
      <DocumentRelationshipMapModal open nodes={sevenNodes.slice(0, 5)} onClose={() => {}} />,
    );
    expect(screen.queryByText('Purchase chain')).toBeNull();
    expect(screen.getByText('Upstream')).toBeTruthy();
  });
});
