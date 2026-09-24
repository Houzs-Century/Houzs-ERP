// ----------------------------------------------------------------------------
// so-header-diff — PURE dirty-field diff for the SO HEADER patch.
// NO React, no I/O. Desktop SalesOrderDetail and mobile MobileNewSO both feed
// their own outgoing payload + the payload AS SEEDED into diffHeaderPayload, so
// "what did the operator actually change" is decided ONCE.
//
// WHY THIS EXISTS — the backend PATCH has ALWAYS been sparse:
//   scm/routes/mfg-sales-orders.ts — `if (body[from] === undefined) continue;`
// A key the client omits is a column the server does not touch. Both clients
// defeated that by rebuilding all ~21 header fields on every save, so every
// save wrote every column. Two consequences, and the second needs no second
// user:
//   1. CONCURRENT — the last save clobbered 21 columns, reverting fields the
//      saver never looked at.
//   2. SINGLE-USER — the header PATCH's master-follower cascade is keyed on
//      PRESENCE, not change (`if (body['customerDeliveryDate'] !== undefined)`),
//      and it rewrites EVERY line's line_delivery_date and clears
//      line_delivery_date_overridden. An always-sent customerDeliveryDate fired
//      it on every save, so editing only the note wiped every per-line delivery
//      date override. Sending only the dirty fields restores the guard's intent:
//      the cascade fires when the header date CHANGED, and only then.
//
// The line path already worked this way (originalDraftsRef + lineCommitSig in
// SalesOrderDetail) — its comment states this same argument in the mirror
// direction ("an edit to the header / customer / demographics alone must NOT
// touch the lines"). This is the inverse, which was never applied.
// ----------------------------------------------------------------------------

/** The header patch shape both surfaces build: camelCase API keys -> values. */
export type SoHeaderPayload = Record<string, unknown>;

/** Loose equality, byte-for-byte the server's own `norm()`
    (scm/routes/mfg-sales-orders.ts, and the same shape inline in
    scm/lib/so-audit.ts diffFields): null / undefined / '' all collapse.

    Deliberately does NOT trim. The server does not trim either, so a value this
    drops is a value the server would also have read as unchanged — the diff can
    never change a server-side decision it could not already predict. Trimming
    here would silently discard a whitespace-only edit the server would have
    stored. */
const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Only a primitive can be compared through `norm`. `String({})` is
    "[object Object]" for EVERY object, so two DIFFERENT objects would norm
    equal and a real edit would be dropped — a silent write loss. Anything
    non-primitive is therefore treated as "cannot prove unchanged" and sent.
    Both header payloads are string|null|undefined today; this keeps the helper
    honest if that ever stops being true, rather than confidently wrong
    (`reference_houzs_nullish_hides_ignorance`). */
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
    reads as a one-day fair — a different event, or none. */
const TRAVEL_TOGETHER: readonly (readonly string[])[] = [
  ['fairVenue', 'fairOrganizer', 'fairStart', 'fairEnd'],
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
    /* A key absent from the seeded original is one we cannot prove unchanged.
       Send it — "unknown" must not silently become "not dirty". */
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
