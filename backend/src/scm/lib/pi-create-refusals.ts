// ----------------------------------------------------------------------------
// pi-create-refusals — how POST /purchase-invoices answers when it will not, or
// cannot, save; and the reasoning behind the two rules that answer follows.
//
// THE REPORT, 2026-08-19. Raising a Purchase Invoice from a Goods Receipt
// answered `POST /api/scm/purchase-invoices -> 500`, and went on answering it.
// The screen said only "The system hit a problem. Please try again — if it keeps
// happening, let IT know."
//
// The 500 is NOT a crash. Every 5xx that handler can emit is a deliberate
// fail-closed refusal, and the zero-price theory was tested rather than reasoned
// about: routes/purchaseInvoiceZeroPriceCreate.test.ts drives the real handler
// on the owner's own document — three sofa modules at unit price 0, MYR, charge
// allocation by quantity — and gets 201. landed-allocation.ts states and keeps
// the no-op guarantee for a zero pool and the divide-by-zero fallback for a zero
// basis; recost.ts reads 0 as "no price known" rather than dividing by it.
//
// ── RULE 1: A REFUSAL THAT WROTE NOTHING RELEASES THE OPERATOR'S KEY ─────────
// PurchaseInvoiceNew mints ONE Idempotency-Key per page mount
// (frontend lib/idempotency.ts `useIdempotencyKey`). middleware/idempotency.ts
// persists EVERY terminal response, "not only 2xx" (:363-373), and replays it
// for the identical payload (:289-296). So a refusal — any refusal — is frozen
// against that key: pressing Save again is answered from the store and the
// handler is never reached, which is how a transient fail-closed 500 becomes a
// permanent one. Correcting the payload does not escape it either; a different
// hash under a claimed key is `idempotency_key_reused` (:167). Only a page
// reload gets out, and it throws away the typed invoice.
//
// grns.ts closed exactly this on 2026-08-17 — lib/no-write-refusal.ts carries
// the trace and the precondition. purchase-invoices.ts contained
// `refuseWithoutWriting` zero times, so the step AFTER the receipt kept the dead
// end the receipt lost. Every refusal at or above the create's first mutating
// call (`insertWithDocNoRetry`) now releases; the three past it release only on
// a rollback whose delete error came back NULL, because releasing a claim
// wrongly costs a duplicate payable while keeping one costs a retype, and those
// are not comparable. Pinned by tests/piCreatePreWriteRefusalsReleaseKey.ts.
//
// ── RULE 2: A COMMITTED INVOICE IS NEVER REPORTED AS A FAILURE ───────────────
// The create's tail runs five side-effects that each promise, in their own
// docblocks, never to throw into the caller. A promise kept by five try/catch
// blocks is not a guarantee: a TypeError raised ABOVE a catch, a subrequest cap
// reached mid-cascade, or a client call that rejects rather than resolving with
// an `error` all unwind past the lot of them into app.onError, which answers
// 500. That 500 would be a lie about money — the invoice, its lines, its audit
// row and its outbox row are already committed, the operator is told the save
// failed, and the sensible thing they then do is press Save again. With Rule 1
// in place the claim no longer stops them, so the lie and the release must not
// be able to meet, and the two shipped together. Pinned by
// routes/purchaseInvoiceCommittedNeverFails.test.ts.
//
// ── AND THE BODIES SAY SOMETHING ─────────────────────────────────────────────
// These exits used to be `{ error, reason }` and no sentence. `reason` is
// whatever the driver said — "null value in column …", "relation … does not
// exist" — and the client's hygiene filter drops exactly that vocabulary
// (frontend authed-fetch.ts), so the operator was left with the status line and
// no idea whether an invoice now existed. `reason` is KEPT, unchanged, for the
// log and for anyone reading the response; the sentence is added beside it. Each
// one says the single thing that decides what the operator does next: whether
// there is now an invoice.
// ----------------------------------------------------------------------------

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
    /* 200 characters is a CLIFF on the client, not a taper, and the first draft
       of this sentence came out at 201 with the longest `what` any call site
       passes — one word from being discarded exactly like the refusal it
       explains. pi-create-refusals.test.ts measures it rather than trusting it. */
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
