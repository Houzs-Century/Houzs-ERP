import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { ReturnCreditNoteCard, type ReturnCreditNote } from './ReturnCreditNoteCard';

const Where = () => <div data-testid="where">{useLocation().pathname + useLocation().search}</div>;
const renderCard = (credit: ReturnCreditNote | null, opts: { canCreate?: boolean; cancelled?: boolean } = {}) => render(
  <MemoryRouter initialEntries={['/scm/delivery-returns/dr-1']}>
    <Routes>
      <Route path="/scm/delivery-returns/:id" element={<ReturnCreditNoteCard returnId="dr-1" credit={credit} cancelled={opts.cancelled ?? false} canCreate={opts.canCreate ?? true} />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

describe('ReturnCreditNoteCard', () => {
  test('awaiting: says so and opens the credit note form filled from the return', () => {
    renderCard({ state: 'AWAITING', notes: [] });
    expect(screen.getByText('Awaiting credit note')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create credit note' }));
    expect(screen.getByTestId('where').textContent).toBe('/scm/credit-notes?form=new&fromReturn=dr-1');
  });

  test('issued: links the note and offers no second one', () => {
    renderCard({ state: 'ISSUED', notes: [{ id: 'n1', number: 'HC-CN-2611-001', status: 'POSTED' }] });
    expect(screen.getByText('Credit note issued')).toBeTruthy();
    expect(screen.getByRole('link', { name: /HC-CN-2611-001/ }).getAttribute('href')).toBe('/scm/credit-notes/n1');
    expect(screen.queryByRole('button', { name: 'Create credit note' })).toBeNull();
  });

  test('without the permission: no button, and it says who raises it', () => {
    renderCard({ state: 'AWAITING', notes: [] }, { canCreate: false });
    expect(screen.queryByRole('button', { name: 'Create credit note' })).toBeNull();
    expect(screen.getByText(/Finance raises it/)).toBeTruthy();
  });

  test('a cancelled return or no data shows nothing', () => {
    const { container } = renderCard({ state: 'AWAITING', notes: [] }, { cancelled: true });
    expect(container.textContent).toBe('');
  });
});
