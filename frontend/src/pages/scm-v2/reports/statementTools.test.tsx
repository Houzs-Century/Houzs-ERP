/* Owner 2026-11-27 (看了很乱 → 代码可以收起来，但要能有个按钮点开): account codes off until
   the Codes switch turns them on, kept in this browser; a file prints the lines as the screen. */
import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CodesSwitch, linesWithCodes, useShowCodes } from './statementTools';
import { readShowCodes } from './reportPrefs';

function Probe() {
  const [on, setOn] = useShowCodes();
  return (
    <>
      <CodesSwitch on={on} onChange={setOn} />
      <span data-testid="state">{on ? 'codes' : 'names'}</span>
    </>
  );
}

beforeEach(() => window.localStorage.removeItem('fin-statement-codes'));

describe('the Codes switch', () => {
  test('off at first; on is kept for the next visit, off again too', () => {
    const first = render(<Probe />);
    const sw = screen.getByRole('switch', { name: 'Codes' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('state').textContent).toBe('names');
    fireEvent.click(sw);
    expect(screen.getByTestId('state').textContent).toBe('codes');
    expect(readShowCodes()).toBe(true);
    first.unmount();
    render(<Probe />);
    expect(screen.getByRole('switch', { name: 'Codes' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('switch', { name: 'Codes' }));
    expect(readShowCodes()).toBe(false);
  });

  test('a file prints an account by its name alone while the codes are off; other lines as they are', () => {
    const lines = [
      { id: 'cat', label: 'Office & admin' },
      { id: 'a', label: '900-I002 · INSURANCE & ROAD TAX', code: '900-I002' },
      { id: 'b', label: 'Lim Kah Hoe', code: '300-0000' },
    ];
    expect(linesWithCodes(lines, false).map((l) => l.label)).toEqual(['Office & admin', 'INSURANCE & ROAD TAX', 'Lim Kah Hoe']);
    expect(linesWithCodes(lines, true)).toBe(lines);
  });
});
