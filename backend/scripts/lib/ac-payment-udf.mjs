// ----------------------------------------------------------------------------
// ac-payment-udf — AutoCount's `PAYEMENT` sales-order UDF, in both directions.
//
// (The misspelling is AutoCount's own. The field is `UDF_PAYEMENT` in the book
// and renaming it here would only hide which field is meant.)
//
// WHY THIS FILE EXISTS. `parsePayment` lived inside import-ac-outstanding-so.mjs
// and was the ONLY definition of this field's format anywhere. The cutover ran
// it over the live book to fill scm.mfg_sales_order_payments.account_sheet and
// .approval_code, and then nothing ever wrote the field back — so the owner's
// standing rule (whatever the cutover EXTRACTED must go back) had no
// implementation, and could not get one while the format lived in a runnable
// script the write-back cannot import.
//
// It is moved here unchanged, and `composePaymentUdf` is its INVERSE. The two
// are in one file on purpose: a format written in one place and read in another
// is how the two stop agreeing, and this one has no schema to catch it — the
// field is free text.
//
// NO SHEBANG, deliberately: a test imports this, and on Windows vitest inlines
// the source and wraps it before vm.runInThisContext, so a `#!` that is no
// longer at byte 0 is a SyntaxError at LOAD (see CLAUDE.md).
// ----------------------------------------------------------------------------

/**
 * Read AutoCount's `UDF_PAYEMENT` free text.
 *
 * MOVED VERBATIM from import-ac-outstanding-so.mjs — this is the function the
 * cutover actually ran over 13,015 headers, so it is the specification of what
 * the book holds, not a fresh reading of it.
 *
 * The format is one or more parenthesised groups, `(accountSheet/approvalCode)`.
 * Whatever separates the groups is NOT part of the format: the matcher takes
 * every `(...)` and ignores the text between them.
 */
export function parsePayment(p) {
  const s = (p || '').trim();
  if (!s) return { acct: null, appr: null, extra: null };
  const groups = [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  let acct = null; let appr = null; const kept = [];
  for (const g of groups) {
    if (g === '/' || g === '') continue;
    const parts = g.split('/');
    if (!acct && parts[0]) acct = parts[0].trim();
    if (!appr && parts[1]) appr = parts[1].trim();
    kept.push(g);
  }
  return { acct, appr, extra: kept.length > 1 ? kept.join(' | ') : null };
}

/**
 * The three characters the format itself uses as delimiters.
 *
 * A value carrying one of them cannot survive a round trip — `(MBB/CIMB/123)`
 * parses back as acct `MBB`, appr `CIMB`, and the rest is lost. They are
 * replaced with a space rather than dropped, so the text stays readable to
 * whoever opens the document, and rather than refused, because refusing would
 * cost the whole document over a slash in a bank name.
 *
 * A human typing into this field in AutoCount's own UI is under exactly the
 * same constraint; the format has never been able to carry them.
 */
const DELIMITERS = /[()/]/g;

const clean = (v) => {
  const s = String(v ?? '').replace(DELIMITERS, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
};

/**
 * Build the `PAYEMENT` value for a sales order from its payments ledger.
 *
 * `payments` is the ERP's own rows, in the order they should read — oldest
 * first, which is the order a person scanning a receipt list expects.
 *
 * Returns `null` when there is nothing to say, so the caller omits the key.
 * OMITTING IS NOT THE SAME AS SENDING A BLANK: AcSyncService's header loop is
 * ContainsKey-gated and `Str` turns a present-null into `""`, so a null would
 * ERASE whatever the account book holds — including the cutover's own text on
 * an order whose payments predate the ERP.
 */
export function composePaymentUdf(payments) {
  if (!Array.isArray(payments)) return null;
  const groups = [];
  for (const p of payments) {
    const acct = clean(p?.account_sheet);
    const appr = clean(p?.approval_code);
    /* Both empty carries nothing — a group of `(/)` is skipped by the parser
       anyway, so emitting it would be noise in a field people read. */
    if (!acct && !appr) continue;
    groups.push(`(${acct ?? ''}/${appr ?? ''})`);
  }
  if (!groups.length) return null;
  /* A single space between groups. The separator is not recoverable from the
     extract — parsePayment discards whatever sits between the parentheses — so
     any choice round-trips, and this is the one that reads best. */
  return groups.join(' ');
}
