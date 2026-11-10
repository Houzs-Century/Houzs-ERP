/* What the second crew member to press Complete is told. The crew share one
   stop (owner, 2026-11-10), so a second Complete is not an error to retry: the
   stop is done, by someone, at a time, and the screen should say so. */
import { fmtDateTime } from '../shared/format';

/** The app's one date+time format (Malaysia time), or null for an unreadable timestamp. */
export function mytClock(iso: string | null | undefined): string | null {
  const out = iso ? fmtDateTime(iso) : null;
  return out && out !== '—' ? out : null;
}

/** The DO stores no completer, so a delivery order's refusal names only when. */
export function alreadyDeliveredRefusal(deliveredAt: string | null) {
  const at = mytClock(deliveredAt);
  return {
    error: 'already_completed' as const,
    reason: `This delivery was already marked delivered${at ? ` at ${at}` : ''}. Nothing was changed.`,
    deliveredAt,
  };
}

export function houzsUserIdOf(c: { get(key: 'houzsUser'): { id?: unknown } | undefined | null }): number | null {
  const id = Number(c.get('houzsUser')?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
