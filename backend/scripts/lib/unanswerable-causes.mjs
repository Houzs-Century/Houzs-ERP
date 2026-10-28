// ---------------------------------------------------------------------------
// unanswerable-causes — the WHOLE `CANNOT BE COMPARED` column, by cause, and
// WHOSE each cause is.
//
// ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
// `lib/sofa-unread-split.mjs` split ONE arm of that column — the sofa
// compartments — and it was the right split. The report then printed its
// cross-tab under the heading "WHAT 'CANNOT BE COMPARED' MEANS, BY CAUSE", and
// that heading was a bigger promise than the table could keep. Run
// 34257873206, on `main`, 2026-09-08:
//
//     GR   cause table 4 + 2 = 6 document(s)   ·   CANNOT BE COMPARED = 3
//     DO   cause table 3 + 2 + 2 = 7           ·   CANNOT BE COMPARED = 5
//     PI   cause table 2 + 3 = 5               ·   CANNOT BE COMPARED = 2
//     PO   cause table 13                      ·   CANNOT BE COMPARED = 13
//
// The PO row is the one that shows both defects at once, because the two counts
// happen to match while the MEMBERSHIP does not:
//
//   · HC-PO-000254 is in the cause table and is NOT in the column. It differs
//     on `transfer to`, so precedence puts it in WORK; its unreadable sofa
//     contributed a cause to a table explaining a column it is not in. The
//     line "=> N of these can be made comparable WITHOUT you" was therefore a
//     promise about documents nobody was waiting on.
//   · HC-PO-009828 is in the column and is in NO cause row. Its only finding is
//     `transfer chain not verifiable`, and nothing upstream emitted a cause for
//     it, so the one document that most needed a name had none.
//
// This is the repo's own named defect class — ONE COLUMN CARRYING SEVERAL
// POPULATIONS — wearing the costume of the fix for it.
//
// ── WHAT THIS MODULE ADDS, AND WHAT IT DOES NOT ────────────────────────────
// It adds the REGISTRY: every cause the column can carry, the sentence for it,
// and WHOSE it is. It does NOT restate the sofa rule — `UNREAD_LABEL` is
// imported from the module that owns it, never copied, so a change there is a
// change here. `classifyUnread` stays where it is and is not re-implemented.
//
// ── WHOSE IT IS: THE THREE ANSWERS, AND WHY THEY ARE THE RIGHT THREE ───────
// The owner has objected four times to being handed work that was already
// answerable. So the column has to say, per document, which of these it is:
//
//   MECHANICAL     a line key we simply never stamped. The build, the source,
//                  the money are not in doubt; we have not recorded WHICH book
//                  line our rows belong to. Stamping it is a recording job and
//                  needs nobody's judgement — 「一律跟账本。除了sofa compartment
//                  而已啊」 reserves his ruling for what the compartments ARE,
//                  not for which line they sit on.
//   ABSENT SOURCE  the book states nothing to compare against and no drawing
//                  exists either. Nobody can answer it, including him. It is
//                  not a backlog and must never be printed as one.
//   OWNER          the book's own text does not say what the build is, and a
//                  drawing does. Only he can read it.
//
// A cause may be MECHANICAL *and then* OWNER — keyless AND undecodable — which
// is exactly why the sofa arm is a cross-tab and not a list, and why this file
// keeps that case as its own row instead of rounding it into either.
//
// PURE: labels and lookups. No filesystem, no database, no printing.
//
// NO SHEBANG: tests/soTallyVerdict.test.mjs reaches this module through
// lib/so-tally-verdict.mjs (see lib/ac-mapping-csv.mjs for the Windows vitest
// reason).
// ---------------------------------------------------------------------------
import { MECHANICAL, UNREAD_LABEL } from "./sofa-unread-split.mjs";

/* ── THE TRANSFER-CHAIN ARM ─────────────────────────────────────────────────
 * `transfer chain not verifiable` is itself two populations, and they are owed
 * opposite things. lib/transfer-chain-verdict.mjs already names them —
 * `line_not_stamped` and `erp_parent_unstamped` — and its own comments say what
 * each one is. The cause keys below are emitted BY lib/ac-transfer-chain-run.mjs
 * at the point it already holds the verdict, the same way lib/variant-report.mjs
 * emits the sofa cause beside its refusal. Neither verdict is recomputed here
 * and neither may be: a second opinion about "different" is docs/bugs/0708. */
export const CHAIN_LINE_NOT_STAMPED = "chainLineNotStamped";
export const CHAIN_PARENT_UNSTAMPED = "chainParentUnstamped";

/* The fallback, and the reason it is not padding. A document sitting in the
   column with NO cause recorded upstream is the exact failure this file was
   written for; naming it `chainUnverifiable` or `unnamedRefusal` makes it
   VISIBLE and countable rather than absent from a table that claims to cover
   the column. `sofa-unread-split.mjs` makes the same argument for its `other`
   bucket, and for the same reason both are printed WHOLE, never sampled. */
export const CHAIN_UNSPECIFIED = "chainUnverifiable";
export const UNNAMED = "unnamedRefusal";

/** Every cause the column can carry -> the sentence the report prints. */
export const CAUSE_LABEL = Object.freeze({
  /* the sofa arm, imported rather than restated */
  ...UNREAD_LABEL,
  [CHAIN_LINE_NOT_STAMPED]:
    "the book names a source LINE and our row carries no AutoCount line key to answer with — MECHANICAL, " +
    "backfill-ac-downstream-line-keys.mjs is what fills it",
  [CHAIN_PARENT_UNSTAMPED]:
    "our parent document carries no AutoCount number at all — an ERP-native parent, so the book has nothing " +
    "to compare it against and nobody can answer it",
  [CHAIN_UNSPECIFIED]:
    "the transfer chain could not be answered and the run recorded no finer cause — named here rather than " +
    "left out of a table that claims to cover the column",
  [UNNAMED]:
    "in the column with NO cause recorded at all — listed WHOLE below, because an unnamed refusal is the " +
    "defect this table exists to make impossible",
});

/** Whose each cause is. The three answers, and nothing outside them. */
export const CAUSE_OWNER = Object.freeze({
  keylessBookReadable: "MECHANICAL",
  keylessBookUnreadable: "MECHANICAL, THEN YOURS",
  keyedBookUnreadable: "YOURS",
  other: "UNNAMED",
  [CHAIN_LINE_NOT_STAMPED]: "MECHANICAL",
  [CHAIN_PARENT_UNSTAMPED]: "ABSENT SOURCE",
  [CHAIN_UNSPECIFIED]: "UNNAMED",
  [UNNAMED]: "UNNAMED",
});

/* Asserted at import, not left to a reviewer: a cause with a sentence and no
   owner would print as work nobody owns, and a cause with an owner and no
   sentence prints its own key at the owner. Either is how a column starts
   carrying a population again. */
for (const k of Object.keys(CAUSE_LABEL)) {
  if (!CAUSE_OWNER[k]) throw new Error(`unanswerable cause ${k} has a label and no owner`);
}
for (const k of Object.keys(CAUSE_OWNER)) {
  if (!CAUSE_LABEL[k]) throw new Error(`unanswerable cause ${k} has an owner and no label`);
}

/** Every cause that is about the transfer chain. Used to answer "did the run
 *  already name WHY this chain refusal happened", so a document unanswerable
 *  for TWO reasons cannot have one of them named and the other invisible. */
export const CHAIN_CAUSES = Object.freeze(
  new Set([CHAIN_LINE_NOT_STAMPED, CHAIN_PARENT_UNSTAMPED, CHAIN_UNSPECIFIED]),
);

/** The causes a line KEY alone closes — no ruling from anybody. */
export const MECHANICAL_CAUSES = Object.freeze(new Set([MECHANICAL, CHAIN_LINE_NOT_STAMPED]));

/** The causes nobody can answer, the owner included. Never a backlog. */
export const ABSENT_SOURCE_CAUSES = Object.freeze(new Set([CHAIN_PARENT_UNSTAMPED]));

/** The causes only the owner's drawing can answer. */
export const OWNER_CAUSES = Object.freeze(new Set(["keyedBookUnreadable", "keylessBookUnreadable"]));

export { MECHANICAL };
