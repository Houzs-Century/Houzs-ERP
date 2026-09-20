// ----------------------------------------------------------------------------
// useAddLineHotkey — the ONE keyboard shortcut for adding a line-item row.
//
// Option A of the add-line unification (owner 2026-09-18): the add-line
// affordance should also BEHAVE the same everywhere from the keyboard. The
// finance table editors (AP invoice, payment voucher, debtor bill) already used
// the Insert key to add a row; this lifts that into one hook every editor can
// opt into so the shortcut is identical system-wide.
//
// Insert is chosen because it types nothing in a text field, so intercepting it
// never eats a keystroke the operator meant for an input. Any modifier
// (Ctrl/Cmd/Alt/Shift) or a contentEditable target is left alone, and the
// handler only ADDS a row — it never submits — so it is safe to wire into
// money/stock forms without touching their write path (R37).
// ----------------------------------------------------------------------------

import { useEffect } from 'react';

/**
 * Call `onAddLine` when the operator presses Insert. `enabled` guards the
 * listener (pass false once a form is saved/locked so a shortcut can't mutate a
 * form that has no add button left).
 */
export function useAddLineHotkey(onAddLine: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Insert') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && el.isContentEditable) return;
      e.preventDefault();
      onAddLine();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onAddLine, enabled]);
}
