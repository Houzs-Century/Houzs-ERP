// DateRangeButton — the redesign's date-range picker: what the button says,
// the presets, the two-click calendar, the hint, and closing.
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DateRangeButton } from './DateRangeButton';
import { OUTSTANDING_RANGE_PRESETS } from '../lib/dateRangePresets';

const TODAY = '2026-11-03';

/** The picker is controlled; this holds the range like a page would. */
function Harness({ initial, onChange }: { initial: { from: string; to: string }; onChange?: (f: string, t: string) => void }) {
  const [range, setRange] = useState(initial);
  return (
    <DateRangeButton
      from={range.from}
      to={range.to}
      onChange={(f, t) => { setRange({ from: f, to: t }); onChange?.(f, t); }}
      presets={OUTSTANDING_RANGE_PRESETS}
      today={TODAY}
      label="Document dates"
    />
  );
}

const trigger = () => screen.getByRole('button', { name: /^Document dates:/ });

describe('DateRangeButton — the button', () => {
  test('names the range with fmtDate and the preset it matches', () => {
    render(<Harness initial={{ from: '2025-11-03', to: '2026-11-03' }} />);
    expect(trigger().textContent).toContain('2025/11/03 – 2026/11/03');
    expect(trigger().textContent).toContain('Last 12 months');
  });

  test('a range no preset matches says its length in days', () => {
    render(<Harness initial={{ from: '2026-10-02', to: '2026-10-11' }} />);
    expect(trigger().textContent).toContain('10 days');
  });

  test('a single day, and every date', () => {
    const { unmount } = render(<Harness initial={{ from: '2026-10-05', to: '2026-10-05' }} />);
    expect(trigger().textContent).toContain('2026/10/05');
    expect(trigger().textContent).not.toContain('–');
    unmount();
    render(<Harness initial={{ from: '', to: '' }} />);
    expect(trigger().textContent).toContain('All dates');
  });

  test('From after To asks to check the dates', () => {
    render(<Harness initial={{ from: '2026-10-20', to: '2026-10-01' }} />);
    expect(trigger().textContent).toContain('check the dates');
  });
});

describe('DateRangeButton — the popover', () => {
  test('a preset sets its range; All dates clears both ends', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ from: '2025-11-03', to: '2026-11-03' }} onChange={onChange} />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Last 7 days' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-28', '2026-11-03');
    expect(within(dialog).getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'All dates' }));
    expect(onChange).toHaveBeenLastCalledWith('', '');
    expect(within(dialog).getByRole('status').textContent).toBe('Every date');
  });

  test('the first day clicked starts the range, the second ends it', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ from: '2026-11-01', to: '2026-11-03' }} onChange={onChange} />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('November 2026')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous month' }));
    expect(within(dialog).getByText('October 2026')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '2026/10/05' }));
    // From moves to the 5th; To (the 3rd of November) is still after it, so it stays.
    expect(onChange).toHaveBeenLastCalledWith('2026-10-05', '2026-11-03');
    expect(within(dialog).getByRole('status').textContent).toContain('now pick the end date');

    fireEvent.click(within(dialog).getByRole('button', { name: '2026/10/12' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-05', '2026-10-12');
    expect(within(dialog).getByRole('status').textContent).toBe('8 days');
    expect(within(dialog).getByRole('button', { name: '2026/10/05' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('button', { name: '2026/10/12' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a day before From restarts the range on that day', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ from: '2026-11-02', to: '2026-11-03' }} onChange={onChange} />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '2026/11/02' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '2026/11/01' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-01', '2026-11-01');
  });

  test('Done and Escape close it', () => {
    render(<Harness initial={{ from: '2025-11-03', to: '2026-11-03' }} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
