/* The region chips above the Last Mile map (owner option B, 2026-11-18): each chip
   fits the map to that region's stops, "All" fits everything again. The map itself
   needs a Google key (absent in tests); the chips render without it. */
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DeliveryMapPanel } from './DeliveryMapPanel';

const zones = { entries: [{ key: 'KL', label: 'KL/SEL', count: 5 }, { key: 'NORTHERN', label: 'Northern', count: 2 }], zeroCount: 1 };

describe('DeliveryMapPanel region chips', () => {
  test('a chip fits the map to its region; All clears it', () => {
    const onZoneClick = vi.fn();
    render(<DeliveryMapPanel title="Day map" onClose={() => {}} pins={[]} zoneSummary={zones} onZoneClick={onZoneClick} activeZoneKey="KL" />);
    fireEvent.click(screen.getByRole('button', { name: /Northern/ }));
    expect(onZoneClick).toHaveBeenLastCalledWith('NORTHERN');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onZoneClick).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: /KL\/SEL/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('without a handler the chips stay a plain count strip', () => {
    render(<DeliveryMapPanel title="Day map" onClose={() => {}} pins={[]} zoneSummary={zones} />);
    expect(screen.queryByRole('button', { name: /Northern/ })).toBeNull();
    expect(screen.getByText('Northern')).toBeTruthy();
  });
});
