/* The phone PO Amendments queue listed only direct PO amendments. The desktop
   queue has also listed every SO amendment that revises a bound PO since
   2026-07-27, so a purchaser on the phone never saw those revisions
   (docs/bugs/0924-the-phone-po-amendments-queue-left-out-every-so-amendment-th.md).

   Both surfaces are rendered with only the data hooks faked; the assertions read
   what the operator sees and where a tap goes. */

import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = {
  id: string; so_doc_no: string; po_id: string; po_number: string; amendment_no: string; status: string;
  reason: string | null; requested_by: null; created_at: string; updated_at: null;
  lane: 'LINES' | 'DELIVERY' | null; bound_pos?: Array<{ id: string; po_number: string; status: string }>;
};

const row = (id: string, day: number, over: Partial<Row> = {}): Row => ({
  id, so_doc_no: `SO-${id}`, po_id: `po-${id}`, po_number: `PO-${id}`, amendment_no: `A-${id}`,
  status: 'REQUESTED', reason: null, requested_by: null,
  created_at: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z`, updated_at: null, lane: 'LINES', ...over,
});

const bound = (poNumber: string) => [{ id: `id-${poNumber}`, po_number: poNumber, status: 'SUBMITTED' }];

let soRows: Row[] = [];
let poRows: Row[] = [];
let soError: Error | null = null;
vi.mock('../vendor/scm/lib/so-amendment-queries', () => ({
  useAmendments: () => ({ data: soError ? undefined : { amendments: soRows }, isLoading: false, error: soError }),
}));
vi.mock('../vendor/scm/lib/po-amendment-queries', () => ({
  usePoAmendments: () => ({ data: { amendments: poRows }, isLoading: false, error: null }),
}));
vi.mock('../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: () => '—' }),
}));

import { MobilePoAmendments } from './MobilePoAmendments';
import { PoAmendments } from '../pages/scm-v2/PoAmendments';

afterEach(() => {
  localStorage.clear();
  soRows = [];
  poRows = [];
  soError = null;
});

const cards = () => [...document.querySelectorAll<HTMLButtonElement>('.amd')];
const cardFor = (poLabel: string) => {
  const card = cards().find((c) => c.querySelector('.sono')?.textContent === poLabel);
  if (!card) throw new Error(`no card for ${poLabel}`);
  return card;
};

/* One order of each kind the desktop rule has to sort: a direct PO amendment, a
   product-line SO amendment and a legacy one (both revise a bound PO), a
   delivery-lane one (never revises a PO) and one with no purchase leg. */
const seed = () => {
  poRows = [row('p', 14)];
  soRows = [
    row('s', 13, { lane: 'LINES', bound_pos: bound('PO-s'), reason: 'qty 2 to 3' }),
    row('t', 12, { lane: null, status: 'SENT', bound_pos: bound('PO-t') }),
    row('u', 11, { lane: 'DELIVERY', bound_pos: bound('PO-u') }),
    row('v', 10, { lane: 'LINES', bound_pos: [] }),
  ];
};

describe('phone PO Amendments queue', () => {
  test('lists the SO amendments that revise a bound PO beside the direct ones', () => {
    seed();
    render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    expect(cards().map((c) => c.querySelector('.sono')?.textContent)).toEqual(['PO-p', 'PO-s', 'PO-t']);
    expect(document.body.textContent).toContain('2 to action');
  });

  test('an SO-driven card says where it came from and who signs it', () => {
    seed();
    render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    expect(cardFor('PO-s').textContent).toContain('From SO amendment · SO-s');
    expect(cardFor('PO-s').textContent).toContain('Purchaser');
    expect(cardFor('PO-s').textContent).toContain('"qty 2 to 3"');
    expect(cardFor('PO-t').textContent).toContain('Legacy');
    expect(cardFor('PO-p').textContent).not.toContain('From SO amendment');
  });

  test('tapping an SO-driven card opens its Sales Order; a direct card opens the PO amendment', () => {
    seed();
    const onOpen = vi.fn();
    const onOpenSo = vi.fn();
    render(<MobilePoAmendments onBack={() => {}} onOpen={onOpen} onOpenSo={onOpenSo} />);
    fireEvent.click(cardFor('PO-s'));
    expect(onOpenSo).toHaveBeenCalledWith('SO-s');
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(cardFor('PO-p'));
    expect(onOpen).toHaveBeenCalledWith('p');
    expect(onOpenSo).toHaveBeenCalledTimes(1);
  });

  test('the Requested chip keeps SO-driven rows too', () => {
    seed();
    const { getByRole } = render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    fireEvent.click(getByRole('button', { name: 'Requested' }));
    expect(cards().map((c) => c.querySelector('.sono')?.textContent)).toEqual(['PO-p', 'PO-s']);
  });

  test('when the SO amendments fail to load, the direct rows still show under the error', () => {
    poRows = [row('p', 14)];
    soError = new Error('boom');
    render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    expect(document.body.textContent).toContain("Couldn't load amendments.");
    expect(cards().map((c) => c.querySelector('.sono')?.textContent)).toEqual(['PO-p']);
    expect(document.body.textContent).not.toContain('No amendments yet.');
  });

  test('shows the same rows as the desktop queue for the same data', () => {
    seed();
    const desktop = render(<MemoryRouter><PoAmendments /></MemoryRouter>);
    const desktopPos = [...desktop.container.querySelectorAll('tr[data-vrow]')]
      .map((tr) => ['PO-p', 'PO-s', 'PO-t', 'PO-u', 'PO-v'].find((n) => tr.textContent.includes(n)));
    desktop.unmount();
    render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    expect(cards().map((c) => c.querySelector('.sono')?.textContent)).toEqual(desktopPos);
  });
});
