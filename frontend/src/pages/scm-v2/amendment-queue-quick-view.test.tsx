/* Owner 2026-09-14:「SO / PO amendment需要单击打开 弹窗 像SO这样」. On both desktop
 * amendment queues a SINGLE click on a row opens its quick view, and a
 * double-click still opens the job card. On the PO queue an SO-driven row opens
 * the SO amendment's quick view, the same split its double-click has always made. */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };
let soRows: Row[] = [];
let poRows: Row[] = [];
const soDetailIds: Array<string | null> = [];
const poDetailIds: Array<string | null> = [];

vi.mock('../../vendor/scm/lib/so-amendment-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/so-amendment-queries')>()),
  useAmendments: () => ({ data: { amendments: soRows }, isLoading: false, error: null }),
  useAmendmentDetail: (id: string | null) => { soDetailIds.push(id); return { data: undefined, isLoading: true, error: null }; },
}));
vi.mock('../../vendor/scm/lib/po-amendment-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/po-amendment-queries')>()),
  usePoAmendments: () => ({ data: { amendments: poRows }, isLoading: false, error: null }),
  usePoAmendmentDetail: (id: string | null) => { poDetailIds.push(id); return { data: undefined, isLoading: true, error: null }; },
}));
vi.mock('../../hooks/useStaffLookup', () => ({ useStaffLookup: () => ({ actorNameOf: () => '—' }) }));

const { Amendments } = await import('./Amendments');
const { PoAmendments } = await import('./PoAmendments');

const soRow = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, so_doc_no: `SO-${id}`, amendment_no: `SO-${id}/A1`, status: 'REQUESTED', reason: null, requested_by: null,
  created_at: '2026-09-14T08:00:00Z', updated_at: null, lane: 'LINES', ...over,
});
const poRow = (id: string): Row => ({
  id, po_id: `po-${id}`, po_number: `PO-${id}`, amendment_no: `PO-${id}/A1`, status: 'REQUESTED', reason: null,
  requested_by: null, created_at: '2026-09-13T08:00:00Z', updated_at: null,
});

const mount = (page: React.ReactNode) => render(
  <MemoryRouter initialEntries={['/queue']}>
    <Routes>
      <Route path="/queue" element={page} />
      <Route path="/scm/amendments/:id" element={<div>SO job card</div>} />
      <Route path="/scm/po-amendments/:id" element={<div>PO job card</div>} />
    </Routes>
  </MemoryRouter>,
);

const rowOf = (container: HTMLElement, text: string): HTMLElement => {
  const tr = [...container.querySelectorAll('tr[data-vrow]')].find((r) => r.textContent.includes(text));
  if (!tr) throw new Error(`no grid row carries ${text}`);
  return tr as HTMLElement;
};

afterEach(() => {
  localStorage.clear();
  soRows = []; poRows = [];
  soDetailIds.length = 0; poDetailIds.length = 0;
});

describe('Sales Order Amendments queue', () => {
  test('one click opens the quick view for that amendment, and nothing navigates', () => {
    soRows = [soRow('a'), soRow('b')];
    const { container } = mount(<Amendments />);
    expect(screen.queryByRole('button', { name: /Open full page/ })).toBeNull();
    fireEvent.click(rowOf(container, 'SO-b/A1'));
    expect(screen.getByRole('dialog', { name: 'Amendment SO-b/A1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open full page/ })).toBeTruthy();
    expect(soDetailIds).toContain('b');
    expect(screen.queryByText('SO job card')).toBeNull();
  });

  test('a double-click still opens the job card', () => {
    soRows = [soRow('a')];
    const { container } = mount(<Amendments />);
    fireEvent.doubleClick(rowOf(container, 'SO-a/A1'));
    expect(screen.getByText('SO job card')).toBeTruthy();
  });
});

describe('PO Amendments queue', () => {
  test('a direct PO amendment opens the PO quick view', () => {
    poRows = [poRow('x')];
    const { container } = mount(<PoAmendments />);
    fireEvent.click(rowOf(container, 'PO-x/A1'));
    const drawer = screen.getByRole('dialog', { name: 'Amendment PO-x/A1' });
    expect(within(drawer).getByText('PO amendment')).toBeTruthy();
    expect(poDetailIds).toContain('x');
  });

  test('an SO-driven row opens the SO amendment quick view, like its double-click', () => {
    soRows = [soRow('s', { bound_pos: [{ id: 'po-9', po_number: 'PO-9', status: 'SUBMITTED' }] })];
    const { container } = mount(<PoAmendments />);
    fireEvent.click(rowOf(container, 'SO-s/A1'));
    expect(within(screen.getByRole('dialog', { name: 'Amendment SO-s/A1' })).getByText('Sales Order amendment')).toBeTruthy();
    expect(soDetailIds).toContain('s');
    fireEvent.doubleClick(rowOf(container, 'SO-s/A1'));
    expect(screen.getByText('SO job card')).toBeTruthy();
  });
});
