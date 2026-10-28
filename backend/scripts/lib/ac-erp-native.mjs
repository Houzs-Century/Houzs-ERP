// ---------------------------------------------------------------------------
// ac-erp-native — did the CUTOVER carry this document, or did the ERP MAKE it?
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The owner defined 「差异 0」on 2026-09-08, in his own words:
//
//     「差异 0」= 搬进来的资料全部对上账本 ← 这才是你要的那个 0
//
// The reconcile did not measure that. Delivery orders were opened to staff at
// 17:41 MYT and within the hour it reported `HC-DO-2609-003` and
// `HC-DO-2609-011` under "ERP claims a document the book does not have". They
// are not phantoms. They are delivery orders staff raised that afternoon, in the
// ERP's own `2609` series, and the AutoCount snapshot they are compared against
// was cut at 00:03Z the same morning — before either existed. Counting them made
// the headline number RISE every time somebody did their job, and put zero out of
// reach for as long as the shop trades.
//
// A document the ERP ORIGINATED is not a difference against an August snapshot
// of the account book. It is simply newer than the snapshot. It gets its own
// named column — never folded into `phantom`, and never dropped: a suppression
// the reader cannot see is a suppression nobody re-checks (`docs/bugs/0668-*` is
// this repo paying for exactly that, with the sign flipped).
//
// THIS NARROWS THE POPULATION, NOT THE STANDARD. A migrated document that
// differs is still a difference, on every axis, unchanged.
//
// ── HOW THE TWO ARE TOLD APART — ONE RULE, NOT A SECOND OPINION ─────────────
// `backend/src/scm/lib/so-is-migrated.ts` already decides this, for the migrated
// sales-order lock (#3251), from the SHAPE OF THE NUMBER PAIR: the cutover
// import writes `"HC-" + acDoc` and the write-back sends our OWN number, which
// AutoCount answers with, so the two strings are EQUAL. Measured across the
// whole corpus on production — Actions -> *SO migrated shape*, run
// `34214516108`, and the reconcile's own `34215427617` cross-tab against
// `scm.autocount_outbox` — 2,882 prefixed, 1 equal, **0 neither**, and a second
// independent signal agrees on every row.
//
// THAT RULE IS IMPORTED, NOT RESTATED. Two copies of one rule gave opposite
// answers about `HC-PO-010040` twenty minutes apart on 2026-09-08
// (`docs/bugs/0708-*`), which is why the sofa pairing rule was consolidated;
// this module does not get to repeat the mistake in the same week.
//
// The third case the sales-order probe never needed: a document carrying NO
// `linked_ac_docno` at all. It has never been to the book, so it is ERP-native
// too — and `soIsMigratedShape` already answers `false` for a blank book number,
// so it needs no branch of its own here.
//
// ── FAILS CLOSED, IN BOTH DIRECTIONS ────────────────────────────────────────
//   • A number pair fitting NEITHER shape answers MIGRATED, because that is what
//     `soIsMigratedShape` answers, and the conservative answer here is the same
//     as the conservative answer there: it stays in the difference column, where
//     somebody looks at it. Moving an unclassifiable document into a benign
//     column is exactly the failure `docs/bugs/0668-*` records.
//   • ERP-NATIVE BY SHAPE IS NOT ENOUGH ON ITS OWN. The claim being made is
//     "newer than the snapshot", so the run has to be able to PROVE it: the
//     document's `created_at` must be at or after the snapshot's `exported_at`.
//     A document created BEFORE the cut whose number the book does not state is
//     a different case entirely — the write-back says the book has it and the
//     book, read afterwards, does not — and that is a real finding, not an age
//     artefact. Without a usable date the verdict is `UNPROVEN` and the document
//     stays counted. Measured on run `34217807499`: zero documents land there.
//
// PURE: numbers and dates in, a verdict out. No filesystem, no database, no
// printing, no clock — the caller passes the snapshot's own cut time, so the
// answer cannot drift with when the check happens to run.
//
// NO SHEBANG: tests/acErpNative.test.mjs imports this module (see
// lib/ac-mapping-csv.mjs for the Windows vitest reason).
// ---------------------------------------------------------------------------
import { soIsMigratedShape } from "../../src/scm/lib/so-is-migrated.ts";

/** The cutover carried it. Compare it against the book — this is the work. */
export const MIGRATED = "migrated";
/** The ERP made it, and it is provably newer than the snapshot being compared. */
export const NATIVE = "native";
/** ERP-native by number shape, but NOT provably newer. Stays counted. */
export const UNPROVEN = "unproven";

/** Milliseconds, or NaN — a Date, an ISO string and a postgres timestamp all arrive here. */
function ms(v) {
  if (v == null) return NaN;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

/**
 * The whole rule, for ONE document.
 *
 * @param {object} a
 * @param {string|null|undefined} a.erpNo       the ERP document number
 * @param {string|null|undefined} a.acNo        `linked_ac_docno` on the same row
 * @param {Date|string|null|undefined} a.createdAt   when the ERP row was written
 * @param {Date|string|null|undefined} a.snapshotCut the snapshot's `exported_at`
 * @returns {"migrated"|"native"|"unproven"}
 */
export function classifyClaimedDoc({ erpNo, acNo, createdAt, snapshotCut }) {
  if (soIsMigratedShape(erpNo, acNo)) return MIGRATED;
  const born = ms(createdAt);
  const cut = ms(snapshotCut);
  if (!Number.isFinite(born) || !Number.isFinite(cut)) return UNPROVEN;
  return born >= cut ? NATIVE : UNPROVEN;
}

/**
 * The split the reconcile prints, over the documents the ERP claims that the
 * book does not state.
 *
 * `bornAt` is a Map from ERP document number to its `created_at`, or null when
 * the run could not read one — in which case NOTHING is reclassified, which is
 * the fail-closed half of the header.
 *
 * @param {object} a
 * @param {Array<{ac: string, erpNo: string}>} a.candidates
 * @param {Map<string, any>|null} a.bornAt
 * @param {Date|string|null} a.snapshotCut
 * @returns {{phantom: Array, native: Array, unproven: Array}} each entry the
 *   candidate plus the `createdAt` the verdict was taken on, so the printed line
 *   can show the evidence rather than assert it.
 */
export function splitErpNative({ candidates, bornAt, snapshotCut }) {
  const phantom = [];
  const native = [];
  const unproven = [];
  for (const c of candidates) {
    const createdAt = bornAt ? bornAt.get(c.erpNo) ?? null : null;
    const verdict = classifyClaimedDoc({ erpNo: c.erpNo, acNo: c.ac, createdAt, snapshotCut });
    const row = { ...c, createdAt, verdict };
    if (verdict === NATIVE) native.push(row);
    else if (verdict === UNPROVEN) unproven.push(row);
    else phantom.push(row);
  }
  return { phantom, native, unproven };
}

/**
 * The shape half alone, for the other direction: an ERP document whose number
 * the book DOES state. Those are compared exactly as before — this is here so
 * the run can SAY how many of them the ERP originated instead of leaving the
 * reader to wonder whether the narrowing reached them too.
 */
export function isErpNativeShape(erpNo, acNo) {
  return !soIsMigratedShape(erpNo, acNo);
}
