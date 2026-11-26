
/** The header insert, or the line insert after its header was rolled back. */
export const insertFailed = (reason: string | undefined, error = 'insert_failed') => ({
  error,
  message:
    'The invoice could not be saved, so nothing was recorded and the receipt is still '
    + 'waiting to be billed. Please try again, and tell IT if it happens twice.',
  reason: reason ?? null,
});

/** A guard that could not READ what it needed. "We could not check" and "there
 *  is nothing to find" are opposite facts and only one of them authorises
 *  billing a supplier, so this is a refusal and not a shrug. */
export const loadFailed = (reason: string, what: string) => ({
  error: 'load_failed',
  message:
    `Could not ${what}, so this invoice was NOT saved — the check that stops a `
    + 'receipt being billed twice could not run. Please try again.',
  reason,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around */

/**
 * Undo a header the create already inserted, and say whether the undo is PROVEN.
 *
 * The two compensating branches in `POST /` (a failed line insert, and the
 * post-insert over-invoice re-check) both answer a refusal after writing a
 * header, and both are only entitled to release the operator's idempotency key
 * because that header is gone. `await sb…delete()` alone does not establish
 * that — the delete has its own error, and an unbound one is how "we rolled
 * back" becomes a claim nobody checked. A header left behind by a failed delete
 * is a real invoice with no lines; releasing the key there would let the
 * corrected resubmit mint a SECOND one beside it.
 *
 * So the caller releases on `true` and keeps the claim on `false`. Keeping it
 * costs the operator a retype; releasing it wrongly costs a duplicate payable.
 */
export async function rollbackPi(sb: any, piId: string, docNo: string): Promise<boolean> {
  const { error } = await sb.from('purchase_invoices').delete().eq('id', piId);
  if (!error) return true;
  /* eslint-disable-next-line no-console */
  console.error(`[pi create] rollback failed — invoice retained: ${docNo}: ${error.message ?? error}`);
  return false;
}

/**
 * Run the create's post-commit side-effects so that none of them can turn a
 * saved invoice into a 500. See rule 2 above; the document number rides the log
 * because a failure nobody can find is a failure nobody fixes.
 */
export async function committedAnyway(docNo: string, run: () => Promise<void>): Promise<void> {
  try { await run(); } catch (e) {
    /* eslint-disable-next-line no-console */
    console.error(`[pi create] post-commit side-effects failed for ${docNo} — the invoice IS saved:`, e);
  }
}
