// ----------------------------------------------------------------------------
// so-reconcile-verdict — DOES THIS MIGRATED SALES ORDER STILL DIFFER FROM THE
// ACCOUNT BOOK?
//
// The migrated-order lock used to answer a question about ORIGIN: came from
// AutoCount -> read-only. That locked 2,882 documents to protect the handful
// that are actually wrong, and it blocked the three things the cutover exists
// to let the floor do — sales proceed an order, purchasing raise a PO against
// it, logistics convert it to a DO. Owner, 2026-09-08:
//
//   「他们是要开 SO 和 edit SO 来 proceed 单;purchasing 要开 PO;
//     logistic 要 convert SO to DO」
//
// So the lock is re-grained onto CORRECTNESS: a migrated order is open when it
// MATCHES the book, and shut while it still differs.
//
// ── THE VERDICT IS DERIVED, NEVER TYPED ────────────────────────────────────
// The rows this module reads are written ONLY by
// backend/scripts/publish-so-reconcile-verdict.mjs, from the output of
// check-ac-erp-reconcile.mjs — the same run, the same definition of
// "different", that prints the summary the owner reads. Nobody hand-maintains
// the list.
//
// That is not a style preference. `sofa-compartment-corrections-2026-08.json`
// was a hand-written file stating what a sofa was, with nothing grading it
// against the book, and three sofas were built wrong. A hand-kept "these ones
// are fine" list is the same defect with the stakes moved onto every migrated
// order at once.
//
// ── ABSENT MUST MEAN LOCKED ─────────────────────────────────────────────────
// Four ways this module can fail to produce a clean answer, and every one of
// them LOCKS:
//
//   no-verdict-published    nothing has ever been published for this document
//   verdict-stale           the newest measurement is older than MAX_AGE_MS
//   verdict-read-failed     the read itself did not run
//   (a differing document)  it differs, on the named axes
//
// Only `clean` opens. "I could not tell" is not "it is fine" — the permissive
// answer must be unreachable by a read that did not work. so-is-migrated.ts
// takes the identical position for the identical reason, and it is the module
// that produces the OTHER half of this decision.
//
// ── NOTHING IS STAMPED ON THE MIGRATED ROW ──────────────────────────────────
// Owner: 「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」 — writing a
// marker onto a migrated row IS a change to the migrated data. The verdict
// therefore lives BESIDE the data, in its own table keyed by doc number, and
// scm.mfg_sales_orders is not touched by any of this.
// ----------------------------------------------------------------------------

/** Why we could not say a document is clean. Each one LOCKS. */
export type SoVerdictUnknownReason =
  | 'no-verdict-published'
  | 'verdict-stale'
  | 'verdict-read-failed';

/**
 * The published answer for ONE document.
 *
 * `axes` are the reconcile's own axis names ('document total', 'line count',
 * 'sofa compartments', ...) so the sentence a salesperson reads is the same
 * word the reconcile printed, not a second vocabulary.
 */
export type SoReconcileVerdict =
  | { kind: 'clean'; measuredAt: string }
  | { kind: 'differs'; axes: string[]; measuredAt: string }
  | { kind: 'unknown'; why: SoVerdictUnknownReason };

/**
 * How old a published verdict may be before it stops being evidence.
 *
 * TWO DAYS, matching the AutoCount snapshot's own limit in
 * check-ac-erp-reconcile.mjs (MAX_SNAPSHOT_AGE_DAYS=2) — a verdict cannot be
 * fresher than the book it was measured against, so a third number here would
 * only ever be the wrong one.
 *
 * The risk being bounded is one-directional and worth naming. A document
 * REPAIRED since the run reads stale-dirty and stays shut: annoying, safe, and
 * fixed by re-running the check. A document that has BROKEN since the run
 * would read clean and open — which is the direction that costs something, and
 * is why an old verdict expires into 'unknown' instead of standing.
 */
export const VERDICT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** The stored row, as the publisher writes it. */
export interface SoVerdictRow {
  clean: boolean;
  axes: string[] | null;
  measured_at: string;
}

/**
 * Turn a stored row (or its absence) into the verdict, PURE, so every branch is
 * pinned by a test rather than reasoned about at a call site.
 *
 * `now` is injected for the same reason: a staleness rule whose clock cannot be
 * moved is a rule nobody tests, and this one has to fail closed at the boundary.
 */
export function soVerdictFromRow(
  row: SoVerdictRow | null,
  now: number,
  maxAgeMs: number = VERDICT_MAX_AGE_MS,
): SoReconcileVerdict {
  if (row == null) return { kind: 'unknown', why: 'no-verdict-published' };

  const measured = Date.parse(row.measured_at ?? '');
  /* An unparseable timestamp is not a fresh one. Number comparisons against
     NaN are all false, so testing `age < max` would have answered "stale" here
     anyway — but by accident, and the next refactor gets to break it. */
  if (!Number.isFinite(measured)) return { kind: 'unknown', why: 'verdict-stale' };
  if (now - measured > maxAgeMs) return { kind: 'unknown', why: 'verdict-stale' };

  if (row.clean === true) return { kind: 'clean', measuredAt: row.measured_at };

  /* A row that says "not clean" and names no axis is still LOCKED. The axis
     list drives the SENTENCE, never the decision — a publisher bug that lost
     the axes must not be able to open a document. */
  const axes = (row.axes ?? []).filter((a): a is string => typeof a === 'string' && a.length > 0);
  return { kind: 'differs', axes, measuredAt: row.measured_at };
}

/* ── The read ──────────────────────────────────────────────────────────────
   A FUNCTION, not a database client, for the reason so-is-migrated.ts records:
   typing the supabase client structurally here makes the compiler unroll its
   generics (TS2589) at the guard's call site. This module needs one row. */
export type SoVerdictReader = (docNo: string) => PromiseLike<{ data: unknown; error: unknown }>;

/**
 * Read ONE document's published verdict.
 *
 * NEVER THROWS AND NEVER ANSWERS 'clean' ON A FAILURE. A read that errored
 * returns `verdict-read-failed`, which locks — the caller cannot accidentally
 * inherit the permissive answer by forgetting a try/catch, because there is no
 * shape of failure that produces one.
 */
export async function readSoVerdict(
  read: SoVerdictReader,
  docNo: string,
  now: number = Date.now(),
  maxAgeMs: number = VERDICT_MAX_AGE_MS,
): Promise<SoReconcileVerdict> {
  let data: unknown;
  try {
    const res = await read(docNo);
    if (res.error) return { kind: 'unknown', why: 'verdict-read-failed' };
    data = res.data;
  } catch {
    return { kind: 'unknown', why: 'verdict-read-failed' };
  }
  if (data == null) return { kind: 'unknown', why: 'no-verdict-published' };

  /* Both spellings, because PostgREST has already been caught here returning
     camelCase where this repo expected snake_case — and in THIS module that
     mistake would read as "no measurement", which locks. Harmless, but it would
     lock every document and look like an outage. */
  const r = data as { clean?: unknown; axes?: unknown; measured_at?: unknown; measuredAt?: unknown };
  const measuredAt = r.measured_at ?? r.measuredAt;
  if (typeof measuredAt !== 'string') return { kind: 'unknown', why: 'verdict-read-failed' };

  return soVerdictFromRow(
    {
      clean: r.clean === true,
      axes: Array.isArray(r.axes) ? (r.axes as string[]) : null,
      measured_at: measuredAt,
    },
    now,
    maxAgeMs,
  );
}
