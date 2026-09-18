// ----------------------------------------------------------------------------
// so-processing-date — THE name of the SO's Processing Date, in one place, plus
// the names OTHER SYSTEMS still say for it.
//
// ─── WHAT THE DATE MEANS (owner, 2026-08-18, correcting this repo) ──────────
//
//   "因为我们有时候开单，未必是要直接 Processing 这张单的。所以 Processing Date
//    就代表这张单可以安排订货了，然后过了一天我们才会落下来，然后采购才会去订货"
//
// THE PROCESSING DATE IS THE DATE THIS ORDER IS RELEASED FOR PURCHASING TO
// ORDER GOODS. Raising an order is not the same as acting on it: an order can
// sit with no Processing Date indefinitely. Setting one is the RELEASE signal;
// roughly a day later the order drops through and purchasing places the order.
//
// AND THERE IS NO PRODUCTION SCHEDULING IN THIS BUSINESS. Owner, same message:
// "我们都没有排产的，我们都不是 Production，我们应该只是送货的日期而已". Houzs
// does not schedule a factory. Comments across this repo used to call this a
// "go-to-production" date and reason about a "factory queue"; every one of them
// was describing a business that does not exist, and they are being rewritten
// as they are found. If you meet another, it is stale — fix it, do not copy it.
//
// NOTE WHAT IS *NOT* IMPLEMENTED: the ~1 day lag the owner describes exists in
// the business, not in this code. Nothing here defers anything by a day, and
// MRP does not read this date to decide when to order at all — it derives
// `orderByDate = delivery date − category lead days` (routes/mrp.ts) and only
// DISPLAYS the Processing Date. Do not write a comment claiming otherwise; the
// comment at routes/mrp.ts:193 claimed exactly that for months while the code
// ignored the field.
//
// ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// Owner, 2026-08-13, after saying it more than three times: "internal expected
// date、processing date 和 process date ... 这三个 date 其实都是指向同一个东西."
// One concept, many names, so every discussion about it produced a new bug. The
// DATA was unified on 2026-08-13 (#2077 / #2079 moved 519 company-1 orders out
// of proceeded_at); what is left is the naming, and the naming is what this
// file is for. Owner again 2026-08-18: "全部你都是要统一掉的，不要那么多个".
//
// ─── THE NAMES, AND WHAT HAPPENS TO EACH ────────────────────────────────────
//
//   processing_date       THE column.       KEEP — SO_PROCESSING_DATE_COLUMN
//   processingDate        THE payload key.  KEEP — SO_PROCESSING_DATE_PAYLOAD_KEY
//   proceeded_at          a second live column for the same fact. DYING — its
//                         last reachable decision stopped reading it in #2396;
//                         the column drop is on `feat/processing-date-has-one-
//                         storage`, which measures the split before flipping.
//                         Nothing here re-reads it.
//   internal_expected_dd  INBOUND alias only, for the 2990 mirror. Cannot be
//                         removed yet — precondition on
//                         SO_PROCESSING_DATE_LEGACY_COLUMNS below.
//   internalExpectedDd    STORED-jsonb alias only, for amendments queued before
//                         the rename. Precondition on
//                         SO_HEADER_LEGACY_PAYLOAD_KEYS below.
//   target_date           LIVE, and the surprise of this sweep. A POS-era
//                         "Target Date" stamp that #140 replaced — dead by every
//                         signal INSIDE this repo, and still written by the POS
//                         today (46 SOs, all born in 90 days, measured on prod).
//                         The sweep removed it and put it back. See
//                         SO_TARGET_DATE_RETIREMENT_BLOCKED.
//   PDate                 EXTERNAL — AutoCount's OWN UDF name, not ours. It can
//                         never be "unified"; see SO_PROCESSING_DATE_AC_UDF.
//
// THIS IS NOT A NEW NAME. Nothing here invents a word. The constants below are
// the ONE column and the ONE payload key, exported so that a future rename is a
// single edit rather than a hunt through 344 string occurrences — and so that
// the places which read the name from a STRING (a PostgREST select list, a
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
// — `job_date`). The legacy native Sales module's `sales_entries.processing_date`
// (frontend/src/pages/Sales.tsx, backend/src/routes/sales.ts) is the SAME
// CONCEPT by the owner's 2026-08-18 ruling — "全部我们只有一个 Processing Date"
// — but a DIFFERENT ROW on a different table with none of the machinery below;
// read the SO_FORM_TEXT_FIELDS comment in backend/src/routes/sales.ts for what
// unifying it costs and how far that has got.
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

/* ─── RETIRING THE SECOND STORAGE ────────────────────────────────────────────
 *
 * THE RULING. Owner 2026-07-31, 2026-08-13 and again 2026-08-18, the last time
 * naming the scope himself: one Processing Date across FRONTEND, BACKEND and
 * DATABASE. `scm.mfg_sales_orders.proceeded_at` was the second storage.
 *
 * DONE, 2026-08-18. NO CODE anywhere reads or writes it:
 *   · the STOCK ALLOCATOR gate moved to `processing_date` (#2396) — the one
 *     reachable decision that had been answering a Processing-Date question out
 *     of the other column.
 *   · every LOCK decides on `processing_date` + `status` alone —
 *     soProcessingLocked / soEditLocked, the amendment door, delivery-planning's
 *     board guard, and the frontend's procLockActive. `status` became a REQUIRED
 *     key on both predicates, and THAT is what replaced the status-blind
 *     `proceeded_at` fallback: a caller without one fails to compile instead of
 *     silently deciding out of a second fact.
 *   · every PAYLOAD stopped carrying it: SO list, detail, POS board, dashboard
 *     summary, /status response. Nothing consumed any of them — the desktop
 *     Proceed Date field was deleted 2026-06-05 and useMfgSalesOrdersSummary has
 *     zero callers in frontend/src, native/ or e2e/.
 *   · every WRITE went with the reader, and had to go WITH it and not before:
 *     the create INSERT's stamp (and `autoProceed`, which existed only to decide
 *     it), the /status IN_PRODUCTION stamp, the ['proceededAt','proceeded_at']
 *     PATCH-map entry and the stamp-once filter hanging off it. Stopping the
 *     writes while the allocator still read the column would have landed every
 *     NEW order with a NULL stamp and gated it out of allocation forever.
 *   · the FRONTEND carries no `proceeded_at` at all: no type, no query select
 *     list, no component field.
 *
 * WHAT THAT DELETED BESIDES THE COLUMN'S USES. `soProceedGateBlocked` lost both
 * call sites and went with them. The RULE it enforced did not move: every path
 * that sets a Processing Date — after unification, every path that proceeds an
 * order — runs collectProcessingGateProblems (shared/so-save-problems.ts), which
 * checks the same four completeness facts INLINE and the money through
 * meetsDepositGate. The /status branch it guarded fired only when the order
 * ALREADY had a date, i.e. re-gated a state that had passed — and
 * inconsistently, since an order that also carried a stamp was not re-gated.
 *
 * TWO LOOSE ENDS THIS CREATES, named rather than tidied away. #2383 landed hours
 * earlier and lifted the proceed gate into lib/so-proceed-gate.ts with a
 * per-condition refusal; removing the last two call sites leaves BOTH
 * `soProceedGateBlocked` (that module's export) and `meetsProceedGate`
 * (order-rules) with no caller in routes, lib or the frontend. Neither is
 * deleted here — deleting a freshly-shipped export to tidy a merge is how work
 * gets silently undone, and if a future proceed path needs to refuse, that is
 * what it should call. docs/modules/sales-order.md has warned since 2026-08-13
 * that this rule had TWO enforcement sites held in step "by agreement, not by
 * construction": there is one live site now (collectProcessingGateProblems) and
 * two orphans. The full note is at soProceedGateBlocked in that module.
 *
 * THE ONE STEP LEFT: DROP THE COLUMN, and NOT in this release.
 * deploy.yml runs `node scripts/pg-migrate.mjs` BEFORE `wrangler deploy`, so for
 * about a minute the OLD Worker is live against the NEW schema. The currently
 * deployed code still SELECTs `proceeded_at` in LIST_COLS, the detail read, the
 * POS board and the dashboard summary — a drop shipped alongside the code that
 * stops selecting it is therefore a 42703 on every SO read for the length of the
 * deploy. That is exactly what blocked prod for hours in #1191/0189. Once THIS
 * commit is live, nothing reads it and the follow-up is 0284's shape:
 *
 *   -- Pre-flight, as 0284 does: name any object that still projects the column
 *   -- rather than failing with a bare catalog error.
 *   -- scm.mfg_sales_orders_with_payment_totals DOES project it (`SELECT so.*`),
 *   -- so this WILL fire. DO NOT drop and recreate that view: a recreated view is
 *   -- a NEW object whose ACL and owner do not survive, and prod died twice with
 *   -- "permission denied for view" before 0191 copied the grant set back off a
 *   -- never-dropped sibling. Prefer CREATE OR REPLACE VIEW with the column
 *   -- omitted (same object, ACL intact); if REPLACE is refused because the
 *   -- column list changes, copy the grants the way 0191 did and say so.
 *   ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS proceeded_at;
 *   NOTIFY pgrst, 'reload schema';
 *
 * THE 2990 MIRROR needs no change and earlier audits missed it entirely:
 * routes/so-mirror.ts upserts `applyMap(body.header, …)`, which keeps every
 * inbound key that exists on the Houzs table, so a `proceeded_at` arriving from
 * 2990 (a separate repo on its own deploy schedule) was written straight
 * through. applyMap filters against information_schema, so the drop above ends
 * that silently and correctly.
 *
 * WHAT THE DATA LOOKED LIKE WHEN THE READ MOVED (probe-proceed-split, prod,
 * 2026-08-18, run 32093080121 — #2396 shipped saying this was UNKNOWN):
 *   company 1, 2724 live: 519 both set, 2205 neither, ZERO disagreeing. No-op.
 *   company 2, 77 live: 5 CONFIRMED gained allocation (the bug #2396 fixed);
 *     16 lost it — 12 CONFIRMED and 4 READY_TO_SHIP carrying a stamp with no
 *     date. Those 4 visibly drop back to CONFIRMED on the next recompute. By the
 *     owner's rule they are not proceeded, so that is the rule applied
 *     correctly; the repair is a human supplying the date, never a script
 *     inventing one (PROCEED_NEEDS_DATE in order-rules.ts).
 *
 * THE AUDIT FACT. "When did someone press Proceed" has no consumer and needs no
 * column: nothing ever read the value AS a timestamp, and a change to the field
 * already lands in scm.mfg_so_audit_log.field_changes, which nothing gates on.
 * ─────────────────────────────────────────────────────────────────────────── */

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
 *
 * ─── STATUS 2026-08-18: STAYS. The unification sweep that retired `target_date`
 * looked at this one and left it, deliberately. The owner's "全部你都是要统一掉
 * 的" is about OUR names; this is the name ANOTHER repository still says, and
 * removing it here does not stop 2990 saying it — it only makes the value
 * vanish, for one company, with a 200 and no log.
 *
 * THE PRECONDITION, EXACTLY, so the next person does not have to re-derive it.
 * BOTH must hold, and both are questions about PRODUCTION, not about source:
 *
 *   1. a company-2 SO mirrored AFTER 2990's own deploy shows a Processing Date
 *      that arrived under `processing_date` — i.e. 2990 stopped sending the old
 *      key. Read the mirrored row; do not read 2990's repository.
 *   2. one FULL mirror re-delivery has drained since that deploy. 2990's outbox
 *      drains on pg_cron, so a row queued before the deploy still carries the
 *      old key however new the deploy is.
 *
 * Section F of `backend/scripts/probe-rename-preconditions.mjs` measures (1) —
 * it counts company-2 SOs whose Processing Date arrived recently, which is zero
 * only if nothing is mirroring at all. It cannot measure (2); that is a fact
 * about 2990's queue and has to be confirmed on 2990's side.
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
 *
 * ─── STATUS 2026-08-18: STAYS, for the same reason as the column alias above.
 * That count is the whole precondition and it is a question about production
 * rows, not about source; section F of
 * `backend/scripts/probe-rename-preconditions.mjs` runs exactly that statement.
 * Retire the entry when the probe reports 0 — and note that 0 today does not
 * stay 0, because a client still holding the old spelling can queue a new one
 * at any time. Confirm no client sends it BEFORE reading the count, not after.
 */
export const SO_HEADER_LEGACY_PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  internalExpectedDd: SO_PROCESSING_DATE_PAYLOAD_KEY,
};

/**
 * AutoCount's OWN name for this date. **EXTERNAL. NEVER UNIFY IT.**
 *
 * `PDate` is a user-defined field on AutoCount's sales-order document
 * (`SO.UDF_PDate`). It is not a name this repo chose and not a name this repo
 * may change: renaming it does not rename anything in AutoCount, it just stops
 * the value arriving there. The write sites are
 * `services/autocount-writeback.ts` (create) and `lib/so-edit-header.ts`
 * (edit), and both carry a pointer back to this constant.
 *
 * The owner asked, on 2026-08-18, whether one of the seven names for this date
 * was the AutoCount write. It is this one, and it is the single name in the set
 * that is allowed to survive the unification — because it belongs to the other
 * system.
 *
 * The failure a "unifying" sweep would cause is the usual silent one. AutoCount
 * matches UDFs by NAME; an unknown key is dropped by the connector and the
 * document posts fine without it, so the ERP would keep reporting success while
 * every Processing Date stopped reaching the account book.
 */
export const SO_PROCESSING_DATE_AC_UDF = 'PDate' as const;

/**
 * `target_date` — THE NAME THAT WAS NOT RETIRED, and the measurement that
 * stopped it. **It is live. Do not sweep it.**
 *
 * WHAT THE SOURCE LOOKS LIKE, and why it reads as dead. PR #140 dropped the
 * field from the SO form ("targetDate → replaced by Processing + Delivery Date",
 * SalesOrderDetail.tsx). `grep -rn targetDate frontend/src native e2e` returns
 * ZERO — no client in THIS repository sends the key. It is nevertheless accepted
 * at SO create, SO header PATCH, CO create and CO header PATCH, selected into
 * three read shapes and typed on two frontend rows. Every signal inside the repo
 * says dead field, delete it.
 *
 * WHAT PRODUCTION SAYS (probe-rename-preconditions.mjs section F, prod,
 * 2026-08-18): **46 of 2826 SO rows carry a `target_date`, and ALL 46 were
 * CREATED inside the last 90 days** — newest 6.75 days old, oldest 67.88. A row
 * BORN with the value was given it at create; the ERP has not written it at
 * create since #140; therefore **the POS handover is still sending it, today**.
 * And it is still READ: `routes/reports.ts` selects it into the sales-report
 * export.
 *
 * WHAT HAPPENED. The 2026-08-18 unification sweep removed the name from all
 * eight sites and put every one of them back the same day, once the probe
 * answered. Shipping the removal would have been the exact defect this whole
 * file exists to prevent: the POS keeps POSTing `targetDate`, the create returns
 * **201**, and the value is dropped in silence.
 *
 * THE LESSON, which is why this comment is long. "No writer in this repo" is not
 * "no writer" — the census that called this field dead read the source, and the
 * source was complete and honest and did not contain the producer. A name that
 * crosses a system boundary can only be retired against a measurement.
 *
 * TO RETIRE IT LATER, in this order: (1) re-run section F and see ZERO rows
 * BORN with one; (2) confirm with the POS that it has stopped sending
 * `targetDate`; (3) then the accept paths, then the reads, then the column.
 */
export const SO_TARGET_DATE_RETIREMENT_BLOCKED = true as const;

/**
 * Framings of this date that have been RETIRED from the source tree and must not
 * come back — the "go-to-production" / "factory queue" vocabulary.
 *
 * NOT COSMETIC, which is why it is a guarded list and not a style note. The
 * owner does not schedule a factory ("我们都没有排产的"), so a comment reasoning
 * about a factory queue is not merely old wording: it is a false model, and it
 * is what a reader reaches for when deciding what this date should gate. The
 * MRP comment claiming this field "drives when to order" survived for months
 * beside code that ignored the field, and it survived because it agreed with
 * the story everything around it told.
 *
 * The patterns live in `so-processing-date-names.test.ts` beside the file list
 * they are checked against. This constant is the statement of intent the test
 * refers back to.
 */
export const SO_PROCESSING_DATE_MEANING =
  'the date this order is RELEASED FOR PURCHASING TO ORDER GOODS' as const;

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
// delivery date 必须同时有或者同时没有". A Processing Date RELEASES the order to
// purchasing and the Delivery Date is what it is promised against; half a pair
// is purchasing told to buy with no date to buy against, or a promise nobody
// has been released to fulfil.
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

/** The first ten characters of a stored date, whatever shape it arrived in.
 *  PostgREST hands a DATE column back as '2026-08-28' and a timestamp as
 *  '2026-08-28T00:00:00+00:00'; the PostgreSQL command transaction
 *  (pg-supabase-transaction.ts, postgres.js) hands BOTH back as a JS Date. A
 *  Date stringifies as 'Fri Aug 28 2026 …', so `String(v).slice(0, 10)` on it
 *  is 'Fri Aug 28' — which sorts AFTER every '2026-…' string and made the
 *  approve-so gate refuse a legal Delivery Date amendment (2026-09-04,
 *  docs/bugs/0636). Every day-comparison on an SO date must come through here,
 *  not through a local `String(v).slice(0, 10)`. Empty / null / invalid Date →
 *  '', and an unparseable string is passed through as-is so the pair test
 *  still counts it as present. */
export const soDateDay = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).trim().slice(0, 10);
};

/** 'YYYY-MM-DD' or null, from a date, a timestamp, a Date object, '' or null.
 *  The stored columns are DATE in Postgres but reach callers as several shapes,
 *  so the compare has to be on a normalised day — otherwise an unchanged
 *  '2026-09-01T00:00:00+00:00' would read as a change against '2026-09-01' and
 *  the grandfather carve-out would stop working. */
export const soDateYmd = (v: unknown): string | null => {
  const ymd = soDateDay(v);
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


/* ─── the prose that used to live at the call sites ──────────────────────────
 *
 * WHY A CONSTANT, not a typed string. Migration 0286 renamed
 * internal_expected_dd -> processing_date, and the /status proceed block in
 * routes/mfg-sales-orders.ts was the one reader the rename commit missed. A
 * PostgREST select of a column that does not exist answers 42703 and fails the
 * WHOLE query; the route discarded that error (`const { data: cur }`), so the
 * row read null, `stored` read null, and every proceed either refused for want
 * of a date the order already had, or 500'd on the write. It shipped, and
 * nothing failed to build: a column name inside a string is invisible to the
 * compiler. SO_PROCESSING_DATE_COLUMN exists so the next rename moves its
 * readers with it.
 *
 * THE CO HEADER PATCH had no copy of the pair rule at all. The CO create path
 * short-circuited on it and the SO header PATCH did too, but the only pair
 * check the CO header PATCH reached was the delivery->processing half inside
 * collectProcessingGateProblems — and that half is gated on
 * `facts.completeness`, which that call does not pass. So a Consignment Order
 * could take a Processing Date with no Delivery Date through a plain PATCH:
 * purchasing released to order goods with no date the goods are promised for.
 * The owner's rule is 同时有或者同时没有 — both or neither.
 *
 * CLEARING ONE CLEARS BOTH, in the one direction that is safe: clearing the
 * Processing Date takes the Delivery Date with it, never the reverse. The CO
 * header has no remove-processing-date permission of its own, so the one-way
 * cascade cannot become a back door if one is ever added.
 *
 * These paragraphs sat at the call sites until 2026-08-14, when the file-size
 * ratchet asked for the two routes to shrink. Prose about a shared rule belongs
 * beside the rule: five callers cannot each hold a copy without drifting. */

/* verbatim, moved from mfg-sales-orders.ts for the file-size ratchet:
 * POS auto-Proceed (Loo 2026-06-09) — when a handover arrives already complete
 *    (customer + address + delivery date + the company's deposit) AND carries a
 *    Processing Date, the order lands in Proceed without a manual click. Same gate
 *    the POS "Move to Proceed" button uses, so the two never drift; and the same
 *    date, because having one is what being proceeded MEANS (owner 2026-08-13).
 *
 * ── SO processing-date lock (Owner 2026-06-12) ─────────────────────────────
 *    Once the SO's processing day has PASSED (from midnight Malaysia time, UTC+8,
 *    the day AFTER the processing date) the SO is LOCKED: locked orders are what
 *    we PO to the supplier, so header edits, line add/edit/delete and price
 *    overrides are all rejected with 409 so_locked_processing. Status transitions
 *    (deliver / cancel flow), payments, PO/DO conversions and reads stay open.
 *    The UI's "Processing Date" lives in processing_date — the ONE column, and
 *    now the ONE name (mig 0286 renamed it from internal_expected_dd — 0284 is the
 *    consignment proceeded_at retirement, and this comment named it for a day; the dead
 *    legacy column that used to squat on this name went in 0189).
 *
 * ── SO purchase-order lock (Owner 2026-08-12, 2990 only) ───────────────────
 *    The SAME soft lock, reached by the other road: a live PO already claims one
 *    of this SO's lines, so the order is with a supplier regardless of what the
 *    processing date says. Rationale, scope and the fail-closed contract live in
 *    lib/so-po-lock.ts — read that before widening this to Houzs.
 * 
 *    A SEPARATE response from the processing-date one on purpose: the two are
 *    fixed by different actions ("wait / talk to production" vs "the PO is out,
 *    raise an amendment so purchasing can re-send"), and an operator told the
 *    wrong reason goes looking in the wrong place. Both are 409 + amendment-
 *    eligible, so the FE routing is unchanged.
 *
 * Owner 2026-07-16 — the lock fires once the processing day has passed on a
 *      CONFIRMED-or-later order. A Processing Date can only be SET on a ≥30%-paid
 *      order and IS the signal that RELEASES it to purchasing (owner 2026-08-18:
 *      "Processing Date 就代表这张单可以安排订货了"), so once it elapses the
 *      order is committed regardless of whether the explicit Proceed (IN_PRODUCTION)
 *      toggle was ever pressed. The prior rule ALSO required `proceeded_at` — but
 *      that is stamped only at the IN_PRODUCTION transition, so a CONFIRMED SO whose
 *      processing date had passed stayed directly editable (a salesperson could
 *      change a line's colour after we had already PO'd it). DRAFT (not yet
 *      confirmed) and CANCELLED stay editable.
 *
 *      THE STATUS-BLIND FALLBACK IS GONE (2026-08-18). soProcessingLocked used to
 *      end `return Boolean(header.proceeded_at)`, reached only when the caller's
 *      select omitted `status`, "so a status-blind read can never OVER-lock a
 *      row". The protection is kept and the second column is not: `status` is now
 *      a REQUIRED key on the predicate's parameter type, so a caller without one
 *      fails to compile instead of quietly deciding out of a different fact, and
 *      an empty status at runtime answers "not locked" — the same side the marker
 *      was chosen to protect. It was never a live second opinion: every caller's
 *      select already named status, and the 2026-08-18 prod census
 *      (probe-proceed-split, run 32093080121) found no NULL-status row in either
 *      company across 2826 orders.
 *
 * Shared route guard — fetches the two date columns and returns the 409 body
 *    when locked, null when free. Callers that already hold the header row use
 *    soEditLocked / soProcessingLocked directly instead of re-querying.
 * 
 *    Owner 2026-08-12: now also answers the PO lock, so the ~6 writers that reach
 *    the lock through THIS helper (line add/edit/delete, price override, …) picked
 *    up the new rule without 6 separate edits — the shape that let previous guards
 *    land on some writers and not others. The date lock is evaluated FIRST and its
 *    response wins when both apply: it is the older, better-understood reason, and
 *    an SO past its processing date with a PO on it is locked either way.
 *
 * ── SO Proceed gate (FIX 2, 2026-07-16) ────────────────────────────────────
 *    meetsProceedGate (shared order-rules) was only consulted at CREATE
 *    auto-proceed. The two MANUAL proceed paths — PATCH /:docNo/status →
 *    IN_PRODUCTION and PATCH /:docNo proceededAt — proceeded
 *    with NO ≥50%-paid / full-address check, so mobile / API could
 *    proceed an under-paid or address-less SO (desktop blocked it). Reuse the SAME
 *    shared gate on both manual paths so create + manual + client can't drift.
 *    `paid` mirrors the sibling processing-date gate in this file: Σ payment rows vs
 *    the SO's local_total_sen — no new threshold invented (the per-company
 *    fraction is processingDateThresholdFor, inside meetsProceedGate).
 *
 * Σ collected vs the header total, both centi — the deposit facts every
 *    Processing-Date gate weighs. One reader because there is one rule: the Proceed
 *    gate and the aggregated save report must not be able to disagree about how
 *    much has been paid, only about how to report it.
 *
 * Every reason a Processing Date may NOT be set on THIS order, read live off the
 *    row instead of off a patch body — the same aggregated list the header PATCH
 *    builds (collectProcessingGateProblems), from the same facts.
 * 
 *    It exists because proceeding now WRITES the date (owner: a Processing Date is
 *    what "proceeded" means). That write has to clear exactly what a date set on the
 *    header clears — variants, colour-KIV, deposit, completeness, the date rules —
 *    or the proceed route becomes the way around the gate that guards what
 *    purchasing is allowed to go and buy.
 *
 * Owner 2026-06-12 + Loo 2026-06-13 — after the processing date passes the SO is
 *    what we PO to the supplier, so the columns that feed the supplier PO freeze on
 *    the header PATCH. The rest of the customer / delivery-address / payment fields
 *    stay editable in the Proceed lane (POS "edit in Proceed"); items have their
 *    own per-route processing lock. Keyed by DB column name.
 * 
 *    Owner 2026-06-16 — customer_state + sales_location ALSO freeze here. State
 *    drives each SO line's warehouse_id (deriveWarehouseIdFromState), and that
 *    warehouse is what the PO ships from. Once the SO is locked the line warehouse
 *    is frozen + PO'd, so letting State change afterwards would silently desync the
 *    warehouse / PO from the customer's address. The REST of the address (address
 *    lines / city) + payment stay editable — the State (and the Location it
 *    derives) plus the Postcode lock.
 * 
 *    Owner 2026-07-05 — postcode ALSO freezes here. Like State, the postcode is
 *    part of the PO delivery location the supplier ships to, so it must not drift
 *    after the SO is locked + PO'd.
 * 
 *    Owner 2026-07-17 — this Set is no longer written by hand. It is DERIVED from
 *    the shared SO_HEADER_FIELD_POLICY table (scm/shared/so-field-policy.ts),
 *    which is the single source of truth for the FREE / CONTROLLED split and is
 *    drift-tested against the frontend's vendored copy. `city` joined the set
 *    there: the mobile UI already disabled City and named it in its lock copy, but
 *    no backend set contained it, so a posted City change wrote straight through
 *    on a locked, PO'd SO — and no amendment could carry it either.
 * 
 *    One correction the policy table records and this comment used to get wrong:
 *    State freezes because it RESOLVES the warehouse. Postcode and City freeze
 *    because they are printed on the supplier PO as the delivery destination.
 *    Postcode resolves nothing — state_warehouse_mappings has no postcode column.
 *
 * ── Amendable header fields (Owner 2026-07-16) ─────────────────────────────
 *    Every column SO_PROCESSING_LOCK_COLS freezes above is rejected by the header
 *    PATCH once the SO is locked. The amendment workflow is the sanctioned channel
 *    for changing a locked SO — so this is EXACTLY the set an amendment must be
 *    able to carry, or a field would be frozen with no way to request it at all
 *    (owner: "應該是全部可以 request 啊 然後看有沒有 approval"; the Delivery Date was
 *    the concrete casualty).
 * 
 *    Keyed by the camelCase payload name the header PATCH already accepts, mapped
 *    to its column. `sales_location` is in the lock Set but NOT amendable directly:
 *    it is DERIVED from customer_state, and applySoAmendment re-derives it exactly
 *    as the header PATCH does. Mirrors the frontend AMENDABLE_HEADER_KEYS
 *    (vendor/scm/lib/so-amendment-header.ts) — keep the two in step.
 * 
 *    This allow-list is the trust boundary: an amendment's header_changes jsonb is
 *    client-authored, so any key not listed here is REJECTED at create rather than
 *    written through to the SO on approve.
 * 
 *    Owner 2026-07-17 — also DERIVED from SO_HEADER_FIELD_POLICY now, so the lock
 *    Set and this allow-list cannot fall out of step: every CONTROLLED row is in
 *    both, every DERIVED row is in the lock only. That invariant used to be prose
 *    in three files; it is a test now (soFieldPolicy.test.ts).
 */

/* verbatim, moved from consignment-orders.ts for the file-size ratchet:
 * NOTE — there is no `processing_date` here, on purpose, and it must not come
 *    back. The CO's Processing Date is `internal_expected_dd` (below), the SAME one
 *    name the rest of the system uses; the CO create/PATCH paths already read and
 *    write only that, and ConsignmentOrderDetail/New bind their "Processing date"
 *    input to it. scm.consignment_sales_orders.processing_date (mig 0153) exists
 *    only because this module was cloned from mfg_sales_orders wholesale — it has
 *    NEVER had a writer (the create INSERT omits it; the header PATCH builds its
 *    update from the closed `map` below, which does not contain it; the status
 *    PATCH writes only status+updated_at; recomputeTotals writes only money), so
 *    every row's value is NULL and selecting it only tempted the next reader to
 *    bind a UI field to a permanently-blank column. That already happened once on
 *    the mfg twin — see BUG-HISTORY "SO read views showed a blank Processing date".
 * 
 *    THE COLUMN IS STILL IN THE DATABASE. Dropping it is a SEPARATE, LATER deploy,
 *    not this one: deploy.yml runs pg-migrate BEFORE `wrangler deploy`, so a column
 *    dropped in the same release that stops selecting it leaves the still-live old
 *    Worker doing a PostgREST select on a missing column — which 500s the whole
 *    Consignment Orders list AND detail for the length of the deploy. (That class
 *    of mistake is what blocked prod for hours in #1191/0189.) Once THIS commit is
 *    live, nothing reads the column and the follow-up migration is a one-liner:
 * 
 *      ALTER TABLE scm.consignment_sales_orders DROP COLUMN IF EXISTS processing_date;
 * 
 *    Its sibling scm.consignment_sales_orders.proceeded_at needed no such wait —
 *    nothing read it even before this commit — and was dropped in mig 0284.
 *
 * No `processing_date` in this line any more, and it is NOT an omission: the
 *      consignment header carried TWO columns, a dead legacy `processing_date`
 *      that nothing has ever written and the live date under the old name
 *      `internal_expected_dd`. Mig 0284 dropped the dead one and renamed the live
 *      one onto the freed name — it is selected two lines down, next to
 *      customer_delivery_date, where the date it partners with lives. Selecting a
 *      dropped column is a hard PostgREST error (the 0189 lesson), so this had to
 *      go in the same commit as the migration.
 *
 * CO composition rules (mirror the SO create path):
 *        1. Processing Date + Delivery Date are all-or-nothing.
 *        2. SOFA is exclusive among MAIN products (sofa / bedframe / mattress).
 *        3. All MATTRESS lines must share ONE brand.
 *
 * Processing & Delivery Date may only be today or a future date, BUT an
 *      already-past value the edit does NOT change is grandfathered through. The
 *      helper re-derives past-date + processing-≤-delivery from the effective +
 *      original dates and folds in the variant offenders collected above.
 */
