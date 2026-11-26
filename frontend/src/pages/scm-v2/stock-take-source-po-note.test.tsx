
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SourcePoNote, SOURCE_PO_PREVIEW } from './stock-take-source-po-note';

const pos = (n: number) => Array.from({ length: n }, (_, i) => ({ po: `HC-PO-${String(i).padStart(4, '0')}`, qty: 1 }));

describe('Stock Take source PO note', () => {
  test('55 POs show the first few and a "+ N more" toggle', () => {
    render(<SourcePoNote sourcePos={pos(55)} systemQty={60} inGroup={false} />);
    expect(screen.getAllByText(/^HC-PO-/)).toHaveLength(SOURCE_PO_PREVIEW);
    expect(screen.getByText('5 without PO')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+ 52 more' }));
    expect(screen.getAllByText(/^HC-PO-/)).toHaveLength(55);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getAllByText(/^HC-PO-/)).toHaveLength(SOURCE_PO_PREVIEW);
  });

  test('a few POs show in full with no toggle', () => {
    render(<SourcePoNote sourcePos={pos(SOURCE_PO_PREVIEW)} systemQty={3} inGroup={false} />);
    expect(screen.getAllByText(/^HC-PO-/)).toHaveLength(SOURCE_PO_PREVIEW);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
