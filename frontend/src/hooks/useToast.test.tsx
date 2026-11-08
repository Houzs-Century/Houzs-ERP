/* A toast's dismiss timer must not outlive the provider: one firing after a
   test file's environment is torn down crashed the run with "window is not
   defined" (Receipts.test.tsx, Deploy 2026-11-08). */
import { act, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ToastProvider, useToast } from './useToast';

afterEach(() => { vi.useRealTimers(); });

function Shout({ kind }: { kind: 'error' | 'success' }) {
  const toast = useToast();
  return <button onClick={() => toast.show(kind, 'Could not save')}>go</button>;
}

test('unmounting the provider clears every pending dismiss timer', () => {
  vi.useFakeTimers();
  const { getByText, unmount } = render(<ToastProvider><Shout kind="error" /></ToastProvider>);
  act(() => { getByText('go').click(); getByText('go').click(); });
  expect(vi.getTimerCount()).toBe(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('a toast still leaves on its own after its time', () => {
  vi.useFakeTimers();
  const { getByText, queryByText } = render(<ToastProvider><Shout kind="success" /></ToastProvider>);
  act(() => { getByText('go').click(); });
  expect(queryByText('Could not save')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(3000); });
  expect(queryByText('Could not save')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
