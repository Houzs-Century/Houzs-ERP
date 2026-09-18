/* F3 saves — the AutoCount habit (owner 2026-09-08: 当打好资料有没有办法可以
   set 任何可以快速 save, 像 autocount 按 f3) — and Ctrl+S / ⌘S with it, for
   hands that reach for that instead. Listens on the WINDOW so it works from
   whichever field the operator is in; the browser's own F3 (find) and Ctrl+S
   (save page) are swallowed while the form is open. `enabled` is the form's
   own "a save makes sense now" (open, not already saving): off, the keys do
   nothing here. The handler itself keeps the form's validation — F3 on a
   half-filled voucher gets the same sentence the button would give. */

import { useEffect, useRef } from 'react';

export const SAVE_HOTKEY_HINT = 'F3 saves';

export const isSaveHotkey = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean =>
  (e.key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey)
  || ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's');

export function useSaveHotkey(onSave: () => void, enabled: boolean): void {
  /* The latest handler, so the listener never calls a stale closure. */
  const latest = useRef(onSave);
  latest.current = onSave;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSaveHotkey(e)) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
