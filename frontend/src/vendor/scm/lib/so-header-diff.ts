
/** The header patch shape both surfaces build: camelCase API keys -> values. */
export type SoHeaderPayload = Record<string, unknown>;

const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const comparable = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean';

/** Keys that are ONE answer spread over several fields: when any is dirty, all
    are sent. A picked fair event (owner 2026-09-24, components/fairPick.ts) is
    its venue, organizer and period together. Sent by halves, a new organizer
    with an unchanged end date would reach the server without the end, which it
    reads as a one-day fair — a different event, or none. The DAY and BOOTH of
    it ride along too: the server keeps each only against the event in the same
    body, so one sent alone could not be checked. */
const TRAVEL_TOGETHER: readonly (readonly string[])[] = [
  ['fairVenue', 'fairOrganizer', 'fairStart', 'fairEnd', 'fairDate', 'fairProjectId'],
];

/**
 * Return ONLY the entries of `next` that differ from `original`.
 *
 * `original` MUST be the payload the form was SEEDED from (i.e. built from the
 * server's header row through the SAME builder as `next`), never the initial
 * render state and never a live-refetching header. Both sides passing through
 * one builder is what stops normalisation from false-positiving: an untouched
 * field produces byte-identical values on both sides, so only a genuine edit
 * survives the diff (the line path's lineCommitSig relies on exactly this).
 *
 * The three empty-ish values are THREE DIFFERENT FACTS and are treated as such:
 *   - `undefined` in `next` -> SKIP. The caller means "don't touch this column",
 *     which is what the server's `body[from] === undefined` guard already reads,
 *     and what JSON.stringify already did by dropping the key. Unchanged.
 *   - `null` in `next`      -> a real edit when the stored value is non-empty.
 *     SENT, so the clear persists as NULL.
 *   - `''` in `next`        -> likewise SENT when the stored value is non-empty.
 * Only when BOTH sides are empty do they collapse, which drops "clear an
 * already-empty field" (a no-op write) while never dropping "clear a field that
 * had a value".
 *
 * Values are SELECTED, never rewritten: whatever the caller's builder decided a
 * field's on-the-wire value should be is exactly what ships, so a field that IS
 * dirty behaves precisely as it does today.
 */
export function diffHeaderPayload(
  original: SoHeaderPayload,
  next: SoHeaderPayload,
): SoHeaderPayload {
  const out: SoHeaderPayload = {};
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (!(key in original)) {
      out[key] = value;
      continue;
    }
    const prev = original[key];
    if (comparable(prev) && comparable(value) && norm(prev) === norm(value)) continue;
    out[key] = value;
  }
  for (const group of TRAVEL_TOGETHER) {
    if (!group.some((k) => k in out)) continue;
    for (const k of group) if (next[k] !== undefined) out[k] = next[k];
  }
  return out;
}

/** True when the operator changed nothing the header PATCH would persist — the
    caller should skip the request entirely rather than write a row of unchanged
    values (and re-fire the delivery-date cascade) to say so. */
export const hasHeaderChanges = (patch: SoHeaderPayload): boolean =>
  Object.keys(patch).length > 0;
