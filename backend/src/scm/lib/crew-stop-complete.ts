/* What the second crew member to press Complete is told. The crew share one
   stop (owner, 2026-11-10), so a second Complete is not an error to retry: the
   stop is done, by someone, at a time, and the screen should say so. */

/** HH:MM in Malaysia time, or null for an unreadable timestamp. */
export function mytClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false });
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
