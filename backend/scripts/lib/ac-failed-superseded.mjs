// ----------------------------------------------------------------------------
// ac-failed-superseded — which outbox FAILURES the account book has since
// answered, so a report does not send anyone to fix a document that is already
// in AutoCount.
//
// WHY IT IS A MODULE. The decision is three small pieces — normalise a
// timestamp, key an arrival by its document, compare the two — and every one of
// them is somewhere a bug hides silently: a Date compared against a string, a
// document number matched without its type, a missing arrival read as "no". The
// health report used to have none of this and simply counted every failure,
// which is how HC-DO-2609-004 and -009 read IN AUTOCOUNT on the page and FAILED
// in the log on the same morning (docs/bugs/0727 fixed the page only).
//
// THE RULE ITSELF IS NOT HERE. `acRefusalPredatesArrival` lives in
// src/scm/lib/autocount-outbox-status.ts and is imported, because the page
// already uses it and a second copy is exactly the failure being fixed. That
// makes this module TypeScript-importing: it runs under `tsx` (or vitest), not
// bare node. Its one caller — check-autocount-outbox-health.mjs — runs under
// tsx for the same reason.
// ----------------------------------------------------------------------------
import { acRefusalPredatesArrival } from '../../src/scm/lib/autocount-outbox-status.ts';

/** The key an outbox row is identified by. The TYPE is half of it: `DO 004` and
 *  `SO 004` are different documents, and matching on the number alone would
 *  silently forgive a real failure. */
export const acDocKeyOf = (row) => `${row.doc_type}:${row.doc_no}`;

/** One spelling of a moment. postgres.js hands back a `Date`, a JSON payload
 *  hands back a string, and the rule compares what `Date.parse` can read — so
 *  both sides are put into ISO before they ever meet. */
export function isoTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return String(value ?? '');
}

/** Newest arrival per document, from rows of `{ doc_type, doc_no, arrived_at }`.
 *  NEWEST, because a document may have been sent more than once and only the
 *  last one can supersede a refusal. */
export function newestArrivalByDoc(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    const at = isoTimestamp(r.arrived_at);
    if (!at) continue;
    const key = acDocKeyOf(r);
    const held = out.get(key);
    if (!held || at > held) out.set(key, at);
  }
  return out;
}

/**
 * The document keys whose failure the account book has since answered.
 *
 * ORDER, NOT SET MEMBERSHIP. A document that arrived and was THEN edited into a
 * refusal is in the book AND needs attention; only the other order is history.
 * A row with no arrival, or with a timestamp neither side can read, stays a
 * failure — hiding a real one costs a document, showing a stale one costs a
 * glance.
 */
export function supersededFailureKeys(failedRows, arrivalsByDoc) {
  const out = new Set();
  for (const r of failedRows ?? []) {
    const key = acDocKeyOf(r);
    if (acRefusalPredatesArrival(isoTimestamp(r.created_at), arrivalsByDoc.get(key))) out.add(key);
  }
  return out;
}
