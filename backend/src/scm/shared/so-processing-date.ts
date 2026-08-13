// ----------------------------------------------------------------------------
// so-processing-date — THE name of the SO's Processing Date, in one place, plus
// the names OTHER SYSTEMS still say for it.
//
// WHY THIS FILE EXISTS (owner, 2026-08-13, after saying it more than three
// times): "internal expected date、processing date 和 process date ... 这三个
// date 其实都是指向同一个东西." One concept, three names, so every discussion
// about it produced a new bug. The DATA was unified on 2026-08-13 (#2077 /
// #2079 moved 519 company-1 orders out of proceeded_at); what is left is the
// naming, and the naming is what this file is for.
//
// THIS IS NOT A FOURTH NAME. Nothing here invents a word. The constants below
// are the ONE column and the ONE payload key, exported so that a future rename
// is a single edit rather than a hunt through 344 string occurrences — and so
// that the places which read the name from a STRING (a PostgREST select list, a
// `Record<string, unknown>` lookup, an inbound mirror payload, a stored jsonb)
// move WITH the rename instead of quietly returning undefined.
//
// THE FAILURE MODE THIS GUARDS. Every surface that reads this date by NAME
// rather than by binding fails the same way when the name moves: no error, no
// type failure, no 500 — the value simply stops arriving. A PostgREST select of
// a column that does not exist is loud (42703); a JS property read of a key
// that does not exist is `undefined`, and `if (pdate)` then sends nothing at
// all. Binding the reads to these constants is what makes the compiler care.
//
// SCOPE. Only the SO header's Processing Date. The delivery-planning board's
// synthetic ASSR / DP / project rows do NOT have one (they carry a job leg date
// — `job_date`), and neither does the accounting `sales.processing_date` column
// in frontend/src/pages/Sales.tsx, which is a different table and a different
// fact. Do not widen this file to cover either.
// ----------------------------------------------------------------------------

/**
 * The DB column on `scm.mfg_sales_orders` behind the UI's "Processing Date".
 *
 * The legacy `scm.mfg_sales_orders.processing_date` snapshot column was dropped
 * in migration 0189; `scm.mfg_sales_orders.proceeded_at` is the same fact in the
 * wrong shape and is stop-writing / stop-reading before it can be dropped. This
 * is the one storage.
 */
export const SO_PROCESSING_DATE_COLUMN = 'internal_expected_dd' as const;

/** The camelCase key the header PATCH and amendment payloads carry it under. */
export const SO_PROCESSING_DATE_PAYLOAD_KEY = 'internalExpectedDd' as const;

/**
 * Column names an INBOUND payload may still use for this date.
 *
 * WHO SENDS THESE. The 2990 → Houzs one-way mirror (routes/so-mirror.ts). 2990
 * is a SEPARATE REPOSITORY on its own deploy schedule, so on the day Houzs
 * renames the column 2990 keeps POSTing the old key. mirror-map's applyMap
 * filters an inbound row against the destination table's information_schema
 * columns and DROPS anything it does not recognise — no error, upsert returns
 * 200, and the Processing Date simply stops arriving for company 2. Listing the
 * old name here is what turns that silent drop into a rename.
 *
 * REMOVE AN ENTRY WHEN: the 2990 repository has been deployed with the new
 * column name AND one full mirror re-delivery has landed (2990's outbox drains
 * on pg_cron, so a stale queued row can still carry the old key for as long as
 * the drainer is behind). Confirm by reading a mirrored company-2 SO's
 * Processing Date, not by reading 2990's source.
 *
 * Today every entry equals SO_PROCESSING_DATE_COLUMN, so the alias is a proven
 * no-op — see mirror-map.test.ts. That is the correct state BEFORE a rename;
 * the list is not empty because an empty list is indistinguishable from a list
 * somebody forgot to fill in.
 */
export const SO_PROCESSING_DATE_LEGACY_COLUMNS: readonly string[] = [
  'internal_expected_dd',
];

/**
 * Payload keys that are ALREADY FROZEN inside stored `so_amendments.header_changes`
 * jsonb, mapped onto the key the code reads today.
 *
 * WHY A STORED KEY IS DIFFERENT FROM A SOURCE STRING. A pending amendment is a
 * client-authored jsonb written at REQUEST time and read at APPROVE time, which
 * can be days later and across a deploy. `applySoAmendment` walks the stored
 * object and `continue`s on any key absent from the amendable allow-list
 * (lib/so-revision.ts) — so after a payload-key rename, an amendment requested
 * before the deploy is approved successfully, marked SO_APPROVED, audited, and
 * its date is never written. Silent, and it also skips the approve-time deposit
 * gate in routes/so-amendments.ts, which keys on the same string.
 *
 * REMOVE AN ENTRY WHEN: no `scm.so_amendments` row in a non-terminal status
 * (REQUESTED / SUPPLIER_PENDING / SO_APPROVED-pending-PO) still carries the old
 * key. Measure it, do not assume it:
 *
 *   SELECT count(*) FROM scm.so_amendments
 *    WHERE header_changes ? '<old key>' AND status NOT IN ('SENT','REJECTED');
 */
export const SO_HEADER_LEGACY_PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  internalExpectedDd: SO_PROCESSING_DATE_PAYLOAD_KEY,
};

/**
 * Rewrite a STORED header_changes object's legacy payload keys onto the keys the
 * code reads today. Returns a NEW object; key order is preserved, values are
 * untouched, and a key with no alias passes through unchanged.
 *
 * Call this ONCE, as early as possible on every read of a stored
 * `header_changes`, so that the `'someKey' in headerChanges` tests downstream
 * (the date-pair re-check, the deposit gate, the apply loop, the state cascade)
 * all see the same canonical shape. Applying it twice is harmless — an
 * already-canonical key is not in the alias map.
 *
 * An alias whose target is already present in the object does NOT overwrite it:
 * a payload carrying both spellings means the newer one was written by newer
 * code and is the one to believe.
 *
 * `aliases` is a parameter, not a closed-over constant, so the seam can be
 * tested against a real rename instead of only against today's identity map.
 */
export function canonicaliseSoHeaderChanges<T>(
  changes: Record<string, T> | null | undefined,
  aliases: Readonly<Record<string, string>> = SO_HEADER_LEGACY_PAYLOAD_KEYS,
): Record<string, T> | null {
  if (changes == null) return null;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(changes)) {
    const target = Object.prototype.hasOwnProperty.call(aliases, k) ? aliases[k] : k;
    /* Same key twice (legacy + current both present): the current spelling
       wins. `k === target` is the no-alias case and must always assign. */
    if (target !== k && Object.prototype.hasOwnProperty.call(changes, target)) continue;
    out[target] = v;
  }
  return out;
}
