import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SaveBlockedIndicator } from './SaveBlockedIndicator';
import type { SaveProblem } from '../lib/authed-fetch';

const p = (message: string): SaveProblem => ({ code: 'x', message });

describe('SaveBlockedIndicator', () => {
  it('renders nothing when there is nothing to fix (no false alarm)', () => {
    const { container } = render(<SaveBlockedIndicator problems={[]} onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the live count and opens the list on tap', () => {
    const onOpen = vi.fn();
    render(<SaveBlockedIndicator problems={[p('a'), p('b'), p('c')]} onOpen={onOpen} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('3 to fix');
    expect(btn.getAttribute('aria-label')).toContain('3 things to fix');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reads in the singular for one problem', () => {
    render(<SaveBlockedIndicator problems={[p('only one')]} onOpen={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('1 thing to fix');
  });
});
