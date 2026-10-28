// The shared add-line chrome (Option A, owner 2026-09-18): one label, one
// button, one keyboard shortcut. These pin the contract every migrated form
// relies on — the visible name is the canonical ADD_LINE_LABEL, both visual
// variants fire onClick, disabled blocks it, and Insert (only Insert, unmodified)
// adds a line.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { AddLineButton } from './AddLineButton';
import { ADD_LINE_LABEL } from '../lib/add-line-handoff';
import { useAddLineHotkey } from '../lib/useAddLineHotkey';

describe('AddLineButton — the one add-line control', () => {
  test('block variant shows the canonical label and fires onClick', () => {
    const onClick = vi.fn();
    render(<AddLineButton variant="block" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: new RegExp(ADD_LINE_LABEL, 'i') });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('ghost variant shows the same canonical label and fires onClick', () => {
    const onClick = vi.fn();
    render(<AddLineButton variant="ghost" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: new RegExp(ADD_LINE_LABEL, 'i') });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('disabled does not fire onClick', () => {
    const onClick = vi.fn();
    render(<AddLineButton variant="block" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ADD_LINE_LABEL, 'i') }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('useAddLineHotkey — Insert adds a line', () => {
  function Harness({ enabled }: { enabled: boolean }) {
    const [count, setCount] = useState(0);
    useAddLineHotkey(() => setCount((c) => c + 1), enabled);
    return <div data-testid="count">{count}</div>;
  }

  test('a bare Insert press adds a line', () => {
    render(<Harness enabled />);
    fireEvent.keyDown(document, { key: 'Insert' });
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  test('Insert with a modifier is ignored', () => {
    render(<Harness enabled />);
    fireEvent.keyDown(document, { key: 'Insert', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'Insert', shiftKey: true });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  test('disabled ignores Insert', () => {
    render(<Harness enabled={false} />);
    fireEvent.keyDown(document, { key: 'Insert' });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});
