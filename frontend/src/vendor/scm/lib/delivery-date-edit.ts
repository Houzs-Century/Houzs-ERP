// Inline Delivery Date cell — the one decision worth pinning: when an edit
// should actually write, and what to write (owner 2026-09-25, the board's
// Delivery Date column is editable inline again — type or pick).
//
// The cell commits on BLUR, not on every keystroke (a half-typed year like
// "31/03/20" parses to a real date and must NOT be saved on the way to
// "31/03/2026"). This decides the commit: skip a no-op, and turn a cleared
// field into an explicit null (unschedule) rather than "".

/** Both are ISO `YYYY-MM-DD` (or '' for empty). */
export function deliveryDateChange(
  current: string,
  next: string,
): { changed: boolean; value: string | null } {
  const cur = (current || '').trim();
  const val = (next || '').trim();
  if (val === cur) return { changed: false, value: null };
  return { changed: true, value: val === '' ? null : val };
}
