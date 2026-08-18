// ----------------------------------------------------------------------------
// transfer-vocabulary.mjs — the SCRIPT twin of
// backend/src/scm/shared/transfer-vocabulary.ts.
//
// WHY A TWIN AND NOT AN IMPORT. backend/tsconfig.json compiles `src/**/*.ts`
// with no `allowJs`, and these scripts run under bare `node` with no build
// step, so neither side can import the other. doc-ref-repair-core.mjs already
// carried a hand-copied regex for the same reason; the difference now is that
// nothing here is hand-copied WITHOUT A REFEREE.
//
// THE REFEREE is backend/tests/transferVocabulary.corpus.test.ts. It reads the
// .ts module and this file, and fails if:
//   - the accepted-label lists differ, or
//   - the two parsers disagree on any note in the shared corpus, or
//   - the SQL pattern fails to select a note the JS parser accepts.
// So this file may not drift silently; it may only drift loudly, in CI.
//
// EVERYTHING ELSE — why the legacy labels are permanent, why the note is a
// stored data contract, who reads it — is documented ONCE, in the .ts module.
// Read that file; do not re-derive it from this one.
// ----------------------------------------------------------------------------

/** Mirror of TRANSFER_DOC. */
export const TRANSFER_DOC = {
  so: "Sales Order",
  po: "Purchase Order",
  do: "Delivery Order",
  si: "Sales Invoice",
  dr: "Delivery Return",
  grn: "Goods Received",
  pi: "Purchase Invoice",
  pr: "Purchase Return",
  co: "Consignment Order",
  cn: "Consignment Note",
  cr: "Consignment Return",
  pco: "Purchase Consignment Order",
  pcr: "Consignment Receive",
};

/** Mirror of transferFromLabel. */
export const transferFromLabel = (source) => `Transfer from ${TRANSFER_DOC[source]}`;

/** Mirror of provenanceNoteLabel. */
export const provenanceNoteLabel = (source) => transferFromLabel(source);

/** Mirror of PROVENANCE_NOTE_LABELS — current first, then the legacy spellings
 *  that production rows still carry, sorted longest-first for the alternation.
 *  NEVER shorten this list: see the .ts module's comment on total loss. */
export const PROVENANCE_NOTE_LABELS = [
  provenanceNoteLabel("so"), // current, since 2026-08-18
  "From SOs", // legacy — the raise's wording until 2026-08-18
  "From SO", // legacy — singular; readers have always taken it
]
  .slice()
  .sort((a, b) => b.length - a.length);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mirror of PROVENANCE_LABEL_ALTERNATION. */
export const PROVENANCE_LABEL_ALTERNATION = PROVENANCE_NOTE_LABELS.map(escapeRegExp).join("|");

/** Mirror of provenanceNoteRe. */
export const provenanceNoteRe = () =>
  new RegExp(`^\\s*(?:${PROVENANCE_LABEL_ALTERNATION}):\\s*(.+)$`, "im");

/** Mirror of parseProvenanceNote. */
export const parseProvenanceNote = (note) => {
  if (!note) return [];
  const m = provenanceNoteRe().exec(String(note).trim());
  if (!m || !m[1]) return [];
  return [...new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean))];
};

/** Mirror of provenanceNoteSqlPattern — the `notes ~* <pattern>` fragment. */
export const provenanceNoteSqlPattern = () => `(${PROVENANCE_LABEL_ALTERNATION}):`;

/** Mirror of relabelProvenanceNote — the backfill's primitive. Smallest edit:
 *  the label span only, every other character byte-identical. Returns the
 *  input BY IDENTITY when already current, which is what makes the backfill
 *  idempotent and lets a caller test `next === note`. */
export const relabelProvenanceNote = (note, source = "so") => {
  if (!note) return String(note ?? "");
  const original = String(note);
  const trimmed = original.trim();
  const m = provenanceNoteRe().exec(trimmed);
  if (!m) return original;

  const leading = original.length - original.trimStart().length;
  const matchStart = leading + m.index;
  const head = m[0].slice(0, m[0].length - m[1].length);
  const colon = head.lastIndexOf(":");
  const labelStart = matchStart + (head.length - head.trimStart().length);
  const labelEnd = matchStart + colon;

  const current = provenanceNoteLabel(source);
  if (original.slice(labelStart, labelEnd) === current) return original;
  return original.slice(0, labelStart) + current + original.slice(labelEnd);
};
