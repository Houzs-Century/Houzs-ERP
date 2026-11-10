import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BoardLoadStatus } from './BoardLoadStatus';

describe('BoardLoadStatus', () => {
  it('shows Refresh next to "Updated hh:mm" and calls it', () => {
    const onRefresh = vi.fn();
    render(<BoardLoadStatus updatedAt={Date.UTC(2026, 10, 10, 6, 32)} bands={{ loading: null, failed: null }} onRefresh={onRefresh} />);
    expect(screen.getByText(/^Updated \d\d:\d\d$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
