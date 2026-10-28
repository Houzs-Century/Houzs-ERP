/* LinePoRefLink — the PO doc no beside a goods-receipt / purchase-invoice line,
   clickable through to the order (#26). */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { LinePoRefLink } from './LinePoRefLink';

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('LinePoRefLink', () => {
  test('links the PO number to its detail page', () => {
    wrap(<LinePoRefLink line={{ source_po_id: 'po-uuid', source_po_number: 'HC-PO-010007' }} />);
    const a = screen.getByRole('link', { name: 'HC-PO-010007' });
    expect(a.getAttribute('href')).toBe('/scm/purchase-orders/po-uuid');
  });

  test('a line with no PO behind it shows a dash and no link', () => {
    wrap(<LinePoRefLink line={{ source_po_id: null, source_po_number: null }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  test('the empty word is the caller\'s — the editor says it is a manual line', () => {
    wrap(<LinePoRefLink line={{}} empty="— (manual)" />);
    expect(screen.getByText('— (manual)')).toBeTruthy();
  });
});
