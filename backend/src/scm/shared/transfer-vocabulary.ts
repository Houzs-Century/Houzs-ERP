// ----------------------------------------------------------------------------
// transfer-vocabulary — the ONE place this ERP names a document's LINEAGE.
//
// #2370 ("one rule generates every transfer label") established the rule and
// put it in frontend/src/lib/convertScope.tsx. It covered BUTTONS only, and it
// could only ever cover buttons, because it lived in a .tsx file in the
// frontend tree: the two other places the same words appear could not reach it.
//
//   1. The PROVENANCE NOTE the backend writes into `purchase_orders.notes`
//      when MRP raises a PO from shortages. Backend code; cannot import a
//      frontend .tsx.
//   2. The LINEAGE COLUMN HEADERS on ~15 list and detail screens. Frontend,
//      but narrow columns that hold a document NUMBER — a full sentence does
//      not fit, and the rule had no short form to offer them, so all fifteen
//      were written by hand.
//
// Both drifted, exactly the way #2370 predicted a hand-written label drifts.
// Before this file the SAME column — "which document did this row come from" —
// was titled FIVE different ways across live screens:
//
//     From SO / From DO / From PO / From GRN     (10 sites)
//     Source PO / Source GRN                     (4 sites)
//     Transfer From (SO)                         (2 sites)
//     Transfer From (Order) / (Receive)          (3 sites)
//     Transfer To (DO)                           (1 site)
//
// So the rule moves HERE, to the shared tree the backend and the frontend both
// already mirror (backend/src/scm/shared -> frontend/src/vendor/shared, the
// pair refereed by backend/scripts/check-shared-mirrors.mjs), and it grows the
// two forms it was missing. convertScope.tsx re-exports it, so every existing
// caller is untouched and the words still have exactly one home.
//
// ── THE PROVENANCE NOTE IS A STORED DATA CONTRACT, NOT A LABEL ──────────────
//
// Read this before changing `provenanceNote()`. The note is the ONLY stored
// record of which Sales Orders an MRP-raised PO was bought for: those POs carry
// no per-line `so_item_id` (frontend/src/vendor/scm/lib/purchase-order-pdf.ts
// documents this at its callsite). EIGHT live readers parse it, in three
// languages that cannot import one another:
//
//   backend/src/scm/routes/document-flow.ts        the relationship graph
//   backend/src/scm/routes/po-so-coverage.ts       via that re-export, x2
//   frontend/src/pages/scm-v2/po-relationship-map.ts   the PO Relationship Map
//   frontend/src/vendor/scm/lib/purchase-order-pdf.ts  the PRINTED PO
//   backend/scripts/lib/doc-ref-repair-core.mjs    the 2990 doc-ref repair
//   backend/scripts/backfill-po-so-item-links.mjs  SQL predicate + parser
//   backend/scripts/audit-mrp-pairing.mjs          SQL predicate
//   backend/scripts/repair-2990-doc-refs.mjs       SQL predicate
//
// The three SQL predicates are the easiest to forget and the worst to get
// wrong: they narrow to candidate rows with `notes ~* <pattern>` BEFORE any JS
// parser sees them, so a pattern that knows fewer labels than the parser makes
// the whole script report a clean pass over rows it never fetched. Build it
// with provenanceNoteSqlPattern(); never type it out.
//
// Teach a reader only the CURRENT wording and every PO written before that day
// loses its provenance silently — no error, just an empty Sales Order node on
// the map and a blank "Your Ref No." on the printed PO. That is why
// PROVENANCE_NOTE_LABELS lists the legacy spellings and why they are never to
// be deleted: rows written under them exist in production forever, whether or
// not the backfill has run.
// ----------------------------------------------------------------------------

/* ── The WORD table (moved verbatim from convertScope.tsx, #2370) ───────────
   Full document names, never abbreviations, always singular. See
   transferToLabel / transferFromLabel below for why each of those is
   deliberate. */
export const TRANSFER_DOC = {
  so:  'Sales Order',
  po:  'Purchase Order',
  do:  'Delivery Order',
  si:  'Sales Invoice',
  dr:  'Delivery Return',
  grn: 'Goods Received',
  pi:  'Purchase Invoice',
  pr:  'Purchase Return',
  co:  'Consignment Order',
  cn:  'Consignment Note',
  cr:  'Consignment Return',
  pco: 'Purchase Consignment Order',
  pcr: 'Consignment Receive',
} as const;

export type TransferDoc = keyof typeof TRANSFER_DOC;

/* ── The LABEL rule (owner-approved 2026-08-17, #2370) ─────────────────────
   Two sentences generate every transfer label, and nothing else does:

       Transfer from <Source document, full name>      secondary, header
       Transfer to   <Destination document, full name>  primary, footer

   Three properties are deliberate, and each was a defect before:

   - **Full document names, never abbreviations.** `SI` / `PI` / `PR` / `GRN` /
     `DO` / `SO` do not appear on a button. They stay in document NUMBERS,
     which is where an abbreviation identifies something.
   - **Always SINGULAR.** The button names the source TYPE, not how many were
     picked. A picker that accepts ten sales orders still reads "Transfer from
     Sales Order" — the old plural ("one or more Purchase Orders") described
     the widget, not the document.
   - **Generated, never written out.** Twenty hand-written literals is how
     desktop and mobile came to word the SAME operation differently — one used
     the abbreviation, one the full name. Call the helpers; a new pair cannot be
     added with an inconsistent label. */

/** The label for the SOURCE-side action: "Transfer to <destination>". */
export const transferToLabel = (destination: TransferDoc): string =>
  `Transfer to ${TRANSFER_DOC[destination]}`;

/** The label for the DESTINATION-side action: "Transfer from <source>". */
export const transferFromLabel = (source: TransferDoc): string =>
  `Transfer from ${TRANSFER_DOC[source]}`;

/* ── The SHORT form (added 2026-08-18; the rule had none) ───────────────────
   A lineage COLUMN is 110-160px wide and its cell holds a document number.
   "Transfer From (SO)" fits; "Transfer from Sales Order" does not, and that
   gap is precisely why fifteen headers were hand-written instead of generated.

   Using the abbreviation HERE does not contradict the full-name rule above —
   it obeys its stated reason. That rule sends abbreviations to "where an
   abbreviation identifies something": document numbers. A lineage column IS a
   column of document numbers, so the header names which kind of number it
   holds. A button, which names an ACTION, still gets the full name.

   Written out rather than derived by upper-casing the key, because three of
   them are not their key: `pco` heads a column of consignment ORDER numbers
   and `pcr` a column of RECEIVE numbers, which is what those screens already
   said in words before this table existed. */
export const TRANSFER_DOC_SHORT = {
  so:  'SO',
  po:  'PO',
  do:  'DO',
  si:  'SI',
  dr:  'DR',
  grn: 'GRN',
  pi:  'PI',
  pr:  'PR',
  co:  'CO',
  cn:  'CN',
  cr:  'CR',
  pco: 'Order',
  pcr: 'Receive',
} as const;

/** Lineage column header, SOURCE side: "Transfer From (SO)". Title Case,
 *  because it is a column header sitting beside "PO No." and "Doc Date". */
export const transferFromColumnLabel = (source: TransferDoc): string =>
  `Transfer From (${TRANSFER_DOC_SHORT[source]})`;

/** Lineage column header, DESTINATION side: "Transfer To (DO)". */
export const transferToColumnLabel = (destination: TransferDoc): string =>
  `Transfer To (${TRANSFER_DOC_SHORT[destination]})`;

/* WHAT THESE ARE NOT FOR, because the next person will reach for them here and
   be wrong. Three columns survive the 2026-08-18 unification still reading
   "Source PO", and they are correct:

     frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx      (source_pos)
     frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx  (source_pos)
     frontend/src/mobile/source-chips.tsx                   (SourcePosRowMobile)

   They name the purchase order the GOODS came from — resolved from batch_no on
   the stock ledger, GRN-healed, and capable of reading "STOCK ADJ" when the
   stock entered through a PO-less adjustment. That is a physical fact about
   inventory, not a document transfer: a Sales Invoice is never transferred
   FROM a Purchase Order, and SalesInvoicesListV2's own comment says so ("an SI
   is born FROM a Sales Order, so 'Assigned SO' is wrong here"). Titling them
   "Transfer From (PO)" would assert a lineage that does not exist and cannot be
   clicked through. Different relationship, different words — on purpose. */

/* ── The PROVENANCE NOTE ────────────────────────────────────────────────────
   `<Transfer from Sales Order>: <doc no>, <doc no>` written into
   `purchase_orders.notes` by the MRP shortage->PO raise
   (backend/src/scm/routes/mfg-purchase-orders.ts).

   The label is `transferFromLabel(source)` — the SAME sentence the button
   says — so the operator reads the same words on the screen that raised the PO
   and in the note the PO carries. It is not a sixteenth variant; it is the
   rule, applied to a third surface. */

/** The label the writer stamps today, for `source`. */
export const provenanceNoteLabel = (source: TransferDoc): string =>
  transferFromLabel(source);

/** Build the stored note. Doc numbers are written verbatim, comma-space
 *  separated, in the order given, blanks dropped and duplicates collapsed —
 *  so `parseProvenanceNote(provenanceNote(d, xs))` round-trips to the same set
 *  every reader will extract. */
export const provenanceNote = (
  source: TransferDoc,
  docNos: readonly string[],
): string => {
  // String() rather than a bare .trim(): the sole caller spreads a Set built
  // from database rows, so a null slipping through the `string[]` type would
  // otherwise throw here and fail the whole PO raise rather than the one token.
  const list = [...new Set(docNos.map((d) => String(d).trim()).filter(Boolean))];
  return `${provenanceNoteLabel(source)}: ${list.join(', ')}`;
};

/* EVERY label a stored provenance note may carry, current first.
 *
 * THE LEGACY ENTRIES ARE LOAD-BEARING AND PERMANENT. `From SOs:` was the
 * writer's wording from the MRP raise's first day until 2026-08-18, and
 * `From SO:` has been accepted by every reader since — the singular was never
 * written by the raise, but readers have always taken it, and a human editing
 * a note by hand can still produce it. Production rows carry both. Removing
 * either spelling from this list does not throw; it makes the PO Relationship
 * Map's Sales Order node go blank and the printed PO's "Your Ref No." go empty
 * for those rows, with nothing logged. Total loss, no error.
 *
 * Ordered LONGEST FIRST so the alternation cannot half-match: on
 * "From SOs: X", a "From SO" branch tried first would consume "From SO", find
 * "s" where it needs ":", and fail. */
export const PROVENANCE_NOTE_LABELS: readonly string[] = [
  provenanceNoteLabel('so'), // current, since 2026-08-18
  'From SOs',                // legacy — the raise's wording until 2026-08-18
  'From SO',                 // legacy — singular; readers have always taken it
]
  .slice()
  .sort((a, b) => b.length - a.length);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The accepted-label alternation, as a regex SOURCE fragment. Exported so the
 *  script twin and the SQL predicates can be checked against it rather than
 *  re-typed — see backend/scripts/lib/transfer-vocabulary.mjs. */
export const PROVENANCE_LABEL_ALTERNATION: string =
  PROVENANCE_NOTE_LABELS.map(escapeRegExp).join('|');

/** The ONE shape a provenance note is recognised by.
 *
 *  `i` — doc numbers and labels are written by hand as well as by the raise.
 *  `m` — the label may sit on its own line inside a longer free-text note; the
 *        FIRST matching line wins. (Before this module the printed PO alone
 *        omitted `m`, so a note whose label was not on line 1 printed no source
 *        SO while the relationship map beside it showed one.)
 *
 *  A fresh RegExp per call: a shared `/m/` instance is stateless, but exporting
 *  a mutable object that a caller could `.exec` with `/g` bolted on is how a
 *  `lastIndex` bug gets in. */
export const provenanceNoteRe = (): RegExp =>
  new RegExp(`^\\s*(?:${PROVENANCE_LABEL_ALTERNATION}):\\s*(.+)$`, 'im');

/** The source document doc numbers a provenance note records.
 *
 *  Returns [] for a plain free-text note (no recognised label) — that is a
 *  note, not provenance, and it must not be mistaken for one. Tokens are the
 *  doc numbers verbatim: the writer has already stripped the company prefix,
 *  and every caller VALIDATES each token against a real, company-owned
 *  document by equality, which is what makes whole-token matching safe (a
 *  split token "SO-1" can only ever equal "SO-1", never "SO-10"). */
export const parseProvenanceNote = (note: string | null | undefined): string[] => {
  if (!note) return [];
  const m = provenanceNoteRe().exec(String(note).trim());
  if (!m || !m[1]) return [];
  return [...new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean))];
};

/** A POSIX-regex fragment for `notes ~* <pattern>` — the three prod-touching
 *  scripts select their candidate rows in SQL, not in JS, and a SQL predicate
 *  that knows only the old labels silently narrows the whole run to the rows
 *  written before the rename. Derived from the same list as the JS regex so
 *  the two cannot disagree. Case-insensitive is the caller's `~*`. */
export const provenanceNoteSqlPattern = (): string =>
  `(${PROVENANCE_LABEL_ALTERNATION}):`;

/** Rewrite a stored note's LABEL to the current wording, changing nothing else.
 *
 *  This is a PRODUCTION DATA WRITE's primitive, so it is deliberately the
 *  smallest edit that exists: it replaces the matched label span and leaves
 *  every other character — the doc numbers, the spacing around each comma,
 *  other lines of the note, leading and trailing whitespace — byte-identical.
 *  Same discipline as `rewriteFromSosNote`, which rewrites doc numbers and
 *  never the label; the two are orthogonal and can run in either order.
 *
 *  IDEMPOTENT by construction: a note already carrying the current label is
 *  returned BY IDENTITY, so a second run plans zero rows and a caller can test
 *  `next === note` rather than comparing strings.
 *
 *  THE INVARIANT, which the backfill re-checks against the database afterwards
 *  rather than trusting: `parseProvenanceNote` returns the SAME doc numbers
 *  before and after. The wording changes; the extracted set must not. */
export const relabelProvenanceNote = (
  note: string | null | undefined,
  source: TransferDoc = 'so',
): string => {
  if (!note) return String(note ?? '');
  const original = String(note);
  const trimmed = original.trim();
  const m = provenanceNoteRe().exec(trimmed);
  if (!m) return original;

  // The label is everything the match consumed before the captured list, minus
  // its trailing ":" and separator run. Locate it in the ORIGINAL string:
  // trim() only strips the ends, so the leading run's length is the offset.
  const leading = original.length - original.trimStart().length;
  const matchStart = leading + m.index;
  const head = m[0].slice(0, m[0].length - m[1]!.length); // "  From SOs:   "
  const colon = head.lastIndexOf(':');
  const labelStart = matchStart + (head.length - head.trimStart().length);
  const labelEnd = matchStart + colon;

  const current = provenanceNoteLabel(source);
  if (original.slice(labelStart, labelEnd) === current) return original;
  return original.slice(0, labelStart) + current + original.slice(labelEnd);
};
