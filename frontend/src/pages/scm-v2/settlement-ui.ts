// The presentation atoms the two settlement screens share.
//
// Two screens, because the work is two jobs on two different days, and the
// owner named them himself (2026-08-17: 就不能分成 merchant reconciliation,
// bank statement reconciliation 吗？):
//
//   /scm/merchant-recon — the MERCHANT statement vs what the ERP recorded;
//   /scm/bank-recon     — the BANK statement vs what those merchants owe.
//
// They are one feature, so they must not drift into looking like two products.
// Everything that decides how they LOOK lives here; everything that decides
// what they MEAN lives on the server.

import type { CSSProperties } from 'react';
import { fmtSen } from '../../vendor/shared/format';
import type { SettlementBucket } from './settlement-queries';

export const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const fmt = (sen: number | null | undefined): string => fmtSen(sen ?? 0);

export const btn = (primary?: boolean, disabled?: boolean): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 14px',
  border: '1px solid var(--c-ink)',
  borderRadius: 'var(--radius-md)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

export const cell: CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };
export const num: CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap' };
export const table: CSSProperties = { width: '100%', fontSize: 'var(--fs-13)', borderCollapse: 'collapse' };
export const headRow: CSSProperties = { textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.12))' };
export const rowLine: CSSProperties = { borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' };
export const softText: CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' };
export const danger = 'var(--c-festive-b, #B8331F)';
export const good = 'var(--c-secondary-a, #2F5D4F)';

export const panel = (accent?: 'good' | 'danger' | 'plain'): CSSProperties => ({
  padding: 'var(--space-3)',
  borderRadius: 'var(--radius-md)',
  border: `1px solid ${accent === 'good' ? good : accent === 'danger' ? danger : 'var(--c-line, rgba(34,31,32,0.2))'}`,
  background: accent === 'good' ? 'rgba(47,93,79,0.08)' : accent === 'danger' ? 'rgba(184,51,31,0.08)' : undefined,
  fontSize: 'var(--fs-13)',
});

export const BUCKET_LABEL: Record<SettlementBucket, string> = {
  MATCHED: 'Matched',
  NEEDS_CONFIRM: 'Needs confirming',
  UNMATCHED: 'Not matched',
  IGNORED: 'Set aside',
};

/**
 * The server's OWN sentence, not the humanised one.
 *
 * authedFetch runs every failure through the shared `humanApiError`, which
 * drops any message containing "column" / "relation" / "constraint" as a
 * suspected database internal — and this feature's whole contract is that a
 * statement it cannot read says WHY ("no Txn Date heading; the file has: …"),
 * and that a credit bigger than the statement says BY HOW MUCH. Those messages
 * were being replaced with "some details weren't accepted", which is precisely
 * the silence §2.14 forbids. The raw body is preserved on the error object, so
 * read it there and fall back to the humanised text.
 */
export const refusalText = (err: unknown, fallback: string): string => {
  const e = err as { body?: string; message?: string } | null;
  try {
    const parsed = JSON.parse(e?.body ?? '') as { message?: string; reason?: string };
    const own = parsed.message ?? parsed.reason;
    if (typeof own === 'string' && own.trim()) return own;
  } catch { /* not JSON — fall through */ }
  /* An EMPTY message is silence too — fall through to the caller's sentence
     rather than render a blank red line. */
  return e?.message?.trim() ? e.message : fallback;
};

/** What a statement promised to pay: its own stated total, else its lines. */
export const payableOf = (b: { stated_net_sen?: number | null; net_sen?: number | null }): number =>
  Number(b.stated_net_sen ?? b.net_sen ?? 0);
