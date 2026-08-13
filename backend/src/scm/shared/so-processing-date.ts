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
export const SO_PROCESSING_DATE_COLUMN = 'processing_date' as const;

/** The camelCase key the header PATCH and amendment payloads carry it under. */
export const SO_PROCESSING_DATE_PAYLOAD_KEY = 'processingDate' as const;

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
 * The rename landed on 2026-08-13 (migration 0284), so this list is no longer
 * a no-op: 2990 is a SEPARATE repo on its own deploy schedule and keeps sending
 * `internal_expected_dd`. Without the alias the mirror's applyMap drops the key
 * against information_schema, the upsert returns 200, and the date silently
 * never arrives. Remove an entry only once the sending repo is confirmed off
 * that name.
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

// ----------------------------------------------------------------------------
// THE PAIR RULE — "both dates or neither", in ONE predicate.
//
// Owner, restated 2026-08-13 after saying it before: "processing date 和
// delivery date 必须同时有或者同时没有". A Processing Date is the go-to-
// production signal and the Delivery Date is what it is promised against; half
// a pair is a half-stated schedule, and production queues on it.
//
// WHY IT MOVED HERE. The rule was written FIVE times, by hand, in five files —
// the SO create path, the SO header PATCH, the CO create path, the amendment
// submit path, and (one direction only) so-save-problems. Five copies is how it
// came to be enforced in five slightly different ways: the CO header PATCH had
// no copy at all, the amendment APPROVE path had none either, and
// so-save-problems only ever asked the delivery→processing direction because
// the other half lived behind a `completeness` block the CO paths do not pass.
// A rule that is only true on the paths someone remembered is the bug class
// this repo keeps repeating. One predicate, every write path calls it.
//
// GRANDFATHERING IS PART OF THE RULE, not an exception to it. Live orders are
// honestly unpaired — AutoCount has no delivery date for some imported history
// — so a save that leaves BOTH dates exactly as it found them must still
// succeed, or editing a remark on an old order starts failing. Same carve-out
// the past-date rules in so-save-problems use, and for the same reason.
// ----------------------------------------------------------------------------

/** The refusal body for an unpaired date pair. `error` is the stable code four
 *  routes already return by hand, so no client has to learn a new one. */
export const SO_DATE_PAIR_REFUSAL = {
  error: 'processing_delivery_must_pair',
  reason: 'Processing Date and Delivery Date must be set together (or both left empty).',
} as const;

export type SoDatePairFacts = {
  /** The Processing Date this write LEAVES on the row (YYYY-MM-DD) or null. */
  nextProc: string | null;
  /** The Delivery Date this write LEAVES on the row (YYYY-MM-DD) or null. */
  nextDeliv: string | null;
  /** The Processing Date as STORED before this write. Pass null on a create —
   *  every date there is new, so nothing can be grandfathered. */
  origProc: string | null;
  /** The Delivery Date as STORED before this write. Null on a create. */
  origDeliv: string | null;
};

/** 'YYYY-MM-DD' or null, from a date, a timestamp, '' or null. The stored
 *  columns are DATE in Postgres but reach callers as several shapes of string,
 *  so the compare has to be on a normalised day — otherwise an unchanged
 *  '2026-09-01T00:00:00+00:00' would read as a change against '2026-09-01' and
 *  the grandfather carve-out would stop working. */
export const soDateYmd = (v: unknown): string | null => {
  const ymd = String(v ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null;
};

/**
 * The refusal when this write would leave the order holding exactly ONE of the
 * two dates, or `null` when the pair is legal.
 *
 * Fires only when the write CHANGES a date: a stored unpaired pair that this
 * save leaves untouched is a historical record, not a fresh entry.
 *
 * Callers pass EFFECTIVE values — the patch value when the request sets that
 * key, else the stored one — so editing one date is still checked against the
 * other already on the row.
 *
 * PRESENCE IS NOT PARSEABILITY, and the two are measured differently on
 * purpose. A value that is present but not a calendar date ('tomorrow', a
 * half-typed '2026-9') still COUNTS as a date for the pair test, so it is
 * refused as half a pair rather than silently read as "no date" and let
 * through; the shape of the value is somebody else's gate. Only the
 * grandfather compare normalises, because a stored DATE column reaches callers
 * as '2026-09-01' from one client and '2026-09-01T00:00:00+00:00' from another
 * and an unchanged date must not read as a change.
 */
export function soDatePairRefusal(
  facts: SoDatePairFacts,
): typeof SO_DATE_PAIR_REFUSAL | null {
  const present = (v: unknown): boolean => String(v ?? '').trim() !== '';
  if (present(facts.nextProc) === present(facts.nextDeliv)) return null;
  const unchanged =
    soDateYmd(facts.nextProc) === soDateYmd(facts.origProc) &&
    soDateYmd(facts.nextDeliv) === soDateYmd(facts.origDeliv) &&
    present(facts.nextProc) === present(facts.origProc) &&
    present(facts.nextDeliv) === present(facts.origDeliv);
  return unchanged ? null : SO_DATE_PAIR_REFUSAL;
}

/**
 * CLEARING ONE CLEARS BOTH — the other half of the owner's rule, for the one
 * shape where refusing would be wrong.
 *
 * Removing the Processing Date pulls the order back OUT of Proceed, and it is
 * already the most-gated write on the header (`scm.so.remove_processing_date`,
 * super-admin only). Once that clear is authorised, the Delivery Date it was
 * promised against has nothing left to hang on: the owner's rule says the pair
 * goes together, so the pair goes together. Refusing instead would make an
 * authorised removal impossible unless the caller happened to send both keys.
 *
 * ONE DIRECTION ONLY, deliberately. Clearing the DELIVERY date on an order that
 * still holds a Processing Date is NOT cascaded — cascading it would clear the
 * Processing Date, which is exactly the write the super-admin permission
 * guards, so the cascade would become the road around that permission. That
 * direction stays a refusal, and the message names the Processing Date as the
 * thing to remove.
 *
 * Returns the column names to force to null, or [] when nothing cascades.
 * `procCleared` must be true only when THIS request genuinely clears a stored
 * Processing Date.
 */
export function soDatePairCascadeColumns(i: {
  procCleared: boolean;
  /** true when the request itself already names customer_delivery_date — then
   *  the caller's own value wins and there is nothing to cascade. */
  delivInPatch: boolean;
  /** The stored Delivery Date; nothing to clear when it is already null. */
  origDeliv: string | null;
}): readonly string[] {
  if (!i.procCleared || i.delivInPatch) return [];
  return soDateYmd(i.origDeliv) ? ['customer_delivery_date'] : [];
}

/**
 * The Processing Date carried by a REQUEST BODY, under the canonical key or any
 * key still aliased onto it.
 *
 * WHY THIS EXISTS AND NOT A LITERAL. The SO create path read
 * `body.internalExpectedDd` to decide auto-proceed, and NO client sends that
 * key — desktop New SO, both mobile surfaces, from-products and the create's own
 * INSERT all send `processingDate`. So `autoProceed` was always false and an
 * order created WITH a Processing Date was created UN-proceeded, the exact
 * inverse of the owner's pinned rule ("只要有 Processing Date, 就代表他 Proceed
 * 了"). Nothing failed: an absent property is `undefined`, not an error.
 *
 * Reads the CANONICAL key first — a body carrying both spellings was written by
 * newer code and the newer one is the one to believe — then the legacy aliases,
 * so a client that has not been redeployed keeps working.
 */
export function readSoProcessingDateFromBody(
  body: Record<string, unknown> | null | undefined,
  aliases: Readonly<Record<string, string>> = SO_HEADER_LEGACY_PAYLOAD_KEYS,
): string | null {
  if (body == null) return null;
  const pick = (k: string): string | null => {
    const v = body[k];
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  };
  const canonical = pick(SO_PROCESSING_DATE_PAYLOAD_KEY);
  if (canonical) return canonical;
  for (const [legacy, target] of Object.entries(aliases)) {
    if (target !== SO_PROCESSING_DATE_PAYLOAD_KEY) continue;
    const v = pick(legacy);
    if (v) return v;
  }
  return null;
}
