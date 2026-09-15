import type { CSSProperties } from 'react';

/* How a FROZEN Sales Order line looks in an editor (owner 2026-09-15:
   「已经送货了的，你就 remain 着，可能要放灰色之类的，设置成不可以被 edit」). One home
   so the desktop editor and the phone editor grey a delivered line the same way.
   The look only signals the lock — the inputs themselves are disabled, and the
   server refuses the write (shared/so-line-freeze.ts). */
export const FROZEN_LINE_STYLE: CSSProperties = {
  opacity: 0.6,
  filter: 'grayscale(1)',
  background: 'rgba(0, 0, 0, 0.035)',
  borderRadius: 8,
};

export const FROZEN_LINE_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: '#6b6f66',
  marginRight: 'auto',
};

/** The sentence beside a frozen line. */
export const FROZEN_LINE_LABEL = 'On a Delivery Order / Invoice — locked';
