// PURE core of the 2990 doc-reference repair. No database, no I/O — so the rule
// that decides whether a reference may be rewritten is unit-testable, and the
// script that talks to production carries no judgement of its own.
//
// THE PROBLEM. `migrate-2990-into-houzs.mjs` prefixed DOCUMENT NUMBERS with
// `2990-` (DOCNO_COL) and a fixed list of doc-number REFERENCE COLUMNS
// (PREFIX_REF_COLS). Two references were in neither list because they are free
// text inside another column:
//
//   purchase_orders.notes           "From SOs: SO-2606-005"
//   inventory_lots.batch_no  +      "PO-2606-001"
//   inventory_movements.batch_no
//
// Every consumer resolves those by STRING EQUALITY against the real doc number
// (po-so-coverage.ts validates note tokens with `.in('doc_no', …)`; the batch
// joins in resolveDeliveredSoLock / fn_reconcile_dropship_batch are `=`), so a
// pre-import number matches nothing and the UI renders a dash.
//
// WHY IT CANNOT BE A BLANKET `'2990-' || col`. Doc-number TAILS collide across
// company namespaces. companyDocPrefix (scm/lib/companyScope.ts) has the base
// company HOUZS mint BARE numbers and every other company prefix with its code,
// so `PO-2607-002` (a real HOUZS purchase order) and `2990-PO-2607-002` (a real
// 2990 one) both exist. Stamping a prefix blindly would repoint a batch at a
// DIFFERENT REAL purchase order and corrupt the costing trail — which is why the
// production diagnostic (check-source-po-prefixes.mjs) reports colliding tails
// as the concrete reason the DISPLAY is left verbatim.
//
// THE RULE, therefore: a token is rewritten only when all three hold.
//   1. as stored it resolves to NOTHING in its own row's company, AND
//   2. prefixed with THAT ROW'S OWN company code it resolves to EXACTLY ONE
//      document, AND
//   3. that document belongs to the SAME company as the row being repaired.
// Anything that already resolves is left alone. Anything that resolves to 0 or
// more than 1 when prefixed is left alone and REPORTED. A base-company (HOUZS)
// row has an empty prefix, so (2) can never differ from (1) and the rule makes
// the repair a structural no-op there — by construction, not by a special case.

/** The prefix a company's minter stamps — the same rule as companyDocPrefix
 *  (scm/lib/companyScope.ts): the base company HOUZS and an unknown/absent code
 *  mint BARE numbers; every other company prefixes with its code. */
export function companyPrefix(code) {
  if (typeof code !== "string") return "";
  const c = code.trim();
  if (!c || c.toUpperCase() === "HOUZS") return "";
  return `${c}-`;
}

/** Outcome of the safety rule for ONE token. `verdict` is one of:
 *    repair            — rewrite to `prefixed`
 *    already-resolves  — resolves as stored, in its own company; untouched
 *    no-prefix         — the owning company mints bare numbers; nothing to try
 *    prefixed-missing  — prefixed form matches no document; untouched
 *    prefixed-ambiguous— prefixed form matches more than one; untouched
 *
 *  `ownCompanyMatches` / `prefixedOwnCompanyMatches` are the counts of documents
 *  matching the token (resp. the prefixed token) that belong to the SAME company
 *  as the row — condition 3 is enforced by the caller filtering on company_id
 *  BEFORE counting, so a foreign document can never satisfy the rule.
 *
 *  `foreignMatches` is informational only: a document with this exact number
 *  exists in ANOTHER company. It never permits or blocks a repair (the repair
 *  targets the prefixed form in the row's own company), but it is the colliding
 *  tail the safety fact is about, so it is surfaced. */
export function classifyToken({
  token,
  prefix,
  ownCompanyMatches,
  prefixedOwnCompanyMatches,
  foreignMatches = 0,
}) {
  const base = { token, prefixed: prefix ? `${prefix}${token}` : token, foreignMatches };
  if (ownCompanyMatches > 0) return { ...base, verdict: "already-resolves" };
  if (!prefix) return { ...base, verdict: "no-prefix" };
  if (prefixedOwnCompanyMatches === 1) return { ...base, verdict: "repair" };
  if (prefixedOwnCompanyMatches === 0) return { ...base, verdict: "prefixed-missing" };
  return { ...base, verdict: "prefixed-ambiguous" };
}

/* The note FORMAT lives in document-flow.ts: the writer is
   `From SOs: ${docNos.join(', ')}` (mfg-purchase-orders.ts:2115) and the only
   structural reader is parseFromSosNote, which trims the note, takes the FIRST
   line matching this regex (multiline, case-insensitive, optional plural) and
   splits the captured list on commas, trimming each token. This regex is copied
   verbatim from parseFromSosNote so the repair can never rewrite a token the
   parser would not have read, nor miss one it would. */
const FROM_SOS_RE = /^\s*From SOs?:\s*(.+)$/im;

/** The tokens parseFromSosNote would extract — same regex, same split, same
 *  de-duplication. Kept here so the script does not import TypeScript. */
export function parseFromSosTokens(note) {
  if (!note) return [];
  const m = FROM_SOS_RE.exec(String(note).trim());
  if (!m) return [];
  return [...new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Rewrite ONLY the tokens named in `replacements` (Map old -> new) inside the
 *  "From SOs:" list, leaving every other character of the note — other lines,
 *  the label's own casing, the spacing around each comma, leading and trailing
 *  whitespace — byte-identical. Returns the original string when there is
 *  nothing to change, so a caller can compare by identity.
 *
 *  A note is annotation, not structure; the smallest possible edit is the point. */
export function rewriteFromSosNote(note, replacements) {
  if (!note || !replacements || replacements.size === 0) return note;
  const original = String(note);
  const trimmed = original.trim();
  const m = FROM_SOS_RE.exec(trimmed);
  if (!m) return original;

  // Where the captured list sits inside the ORIGINAL string. trim() only strips
  // leading/trailing whitespace, so the leading run's length is the offset.
  const leading = original.length - original.trimStart().length;
  const listStart = leading + m.index + (m[0].length - m[1].length);
  const listEnd = listStart + m[1].length;

  let changed = false;
  const rebuilt = m[1]
    .split(",")
    .map((segment) => {
      const tok = segment.trim();
      const next = replacements.get(tok);
      if (!tok || !next || next === tok) return segment;
      changed = true;
      // Preserve the segment's own surrounding whitespace exactly.
      const head = segment.slice(0, segment.indexOf(tok));
      const tail = segment.slice(segment.indexOf(tok) + tok.length);
      return `${head}${next}${tail}`;
    })
    .join(",");

  if (!changed) return original;
  return original.slice(0, listStart) + rebuilt + original.slice(listEnd);
}
