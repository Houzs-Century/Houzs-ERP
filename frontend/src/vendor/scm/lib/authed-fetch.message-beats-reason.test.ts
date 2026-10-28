// ----------------------------------------------------------------------------
// The refusal wrote a sentence for the operator, and the client read the
// DIAGNOSTIC instead — then threw that away too.
//
// PRODUCTION, 2026-08-19. Creating a Purchase Invoice from a Goods Receipt
// answered `POST /api/scm/purchase-invoices -> 500`, and the only thing on the
// screen was "The system hit a problem. Please try again — if it keeps
// happening, let IT know."
//
// Every 500 this router can emit is a hand-written fail-closed refusal that
// ships BOTH halves (purchase-invoices.ts:774, :785, :809, :927, :932):
//
//   { error, message: <the sentence for the operator>, reason: <the driver text> }
//
// `humanApiError` preferred `reason`, because it was written when `reason` was
// the only field a refusal carried. `reason` on these bodies is whatever
// PostgREST said — "column … does not exist", "null value in column … violates
// not-null constraint" — so it hit the internals filter directly below it and
// was dropped, and the sentence beside it was never even looked at. The result
// is the worst of the three: the server explained itself, the client had the
// explanation in hand, and the operator was told nothing.
//
// The order is now message-then-reason. `message` in this codebase IS the
// operator's half by construction — every writer of one says so in its own
// docblock (return-unlinked-lines.ts "its own refusal, because 'we could not
// check' and 'there is nothing to find' are opposite facts"; fx-guard.ts "the
// 422 body an offending POST receives — actionable, never a 500") — and `reason`
// is the driver's. The hygiene filter still applies to whichever one is chosen,
// so a `message` that is itself a blob or a code cannot sail past it; it simply
// falls through to `reason` and then to the status line, exactly as before.
// ----------------------------------------------------------------------------
import { describe, expect, test } from "vitest";
import { humanApiError } from "./authed-fetch";

const GENERIC_500 =
  "The system hit a problem. Please try again — if it keeps happening, let IT know.";

const body = (o: unknown) => JSON.stringify(o);

/** The real body of purchase-invoices.ts:774 / :785, verbatim from
 *  lib/return-unlinked-lines.ts `unlinkedCheckFailedResponse`. */
const unlinkedCheckFailed = (reason: string) => ({
  error: "unlinked_check_failed",
  message:
    "Could not check whether any line bills goods the named Goods Receipt already "
    + "contains, so this invoice was NOT saved — the same goods could otherwise be paid for "
    + `twice. Please try again (${reason}).`,
  reason,
});

describe("a refusal that carries both halves shows the operator's half", () => {
  /* THE REGRESSION. The reason is a PostgREST sentence, which the filter below
     the choice is right to drop — but dropping it must not take the sentence
     written for the operator with it. */
  test("a raw driver reason does not bury the sentence beside it", () => {
    const out = humanApiError(500, body(unlinkedCheckFailed("column grn_items.foo does not exist")));
    expect(out).not.toBe(GENERIC_500);
    expect(out).toContain("was NOT saved");
    expect(out).toContain("paid for twice");
  });

  /* The other half of the same defect: the operator must be told the invoice
     was not saved even when the driver said something unremarkable. */
  test("a plain reason still loses to the message", () => {
    const out = humanApiError(500, body(unlinkedCheckFailed("timeout")));
    expect(out).toContain("was NOT saved");
  });

  /* `reason` is not being demoted to noise — it is the fallback, unchanged, for
     every refusal that never wrote a message. That is most of this router's
     500s (`insert_failed`, `load_failed`, `lookup_failed`). */
  test("reason still speaks when there is no message", () => {
    expect(humanApiError(500, body({ error: "insert_failed", reason: "Supplier is closed for the day" })))
      .toBe("Supplier is closed for the day");
  });

  /* A message that is itself internals must still be dropped — the hygiene
     filter applies to whichever half is chosen, not to `reason` alone. */
  test("an internals-shaped message is dropped, and reason is tried next", () => {
    expect(humanApiError(500, body({
      error: "insert_failed",
      message: 'null value in column "material_kind" violates not-null constraint',
      reason: "The invoice line is missing its item type — reopen the receipt and try again.",
    }))).toBe("The invoice line is missing its item type — reopen the receipt and try again.");
  });

  /* Both halves unusable ⇒ the status line, exactly as before this change. */
  test("both halves unusable falls through to the status line", () => {
    expect(humanApiError(500, body({
      error: "insert_failed",
      message: "relation scm.purchase_invoices does not exist",
      reason: "relation scm.purchase_invoices does not exist",
    }))).toBe(GENERIC_500);
  });
});

/* ── The diagnostic tail ────────────────────────────────────────────────────
   Sixteen refusals in the backend end their operator sentence with the driver's
   own words in brackets. Judged as one string they were dropped whole. */
describe("a bracketed diagnostic tail costs the bracket, not the sentence", () => {
  test("the tail goes and the sentence survives, punctuation intact", () => {
    const out = humanApiError(500, body(unlinkedCheckFailed("column grn_items.foo does not exist")));
    expect(out).toBe(
      "Could not check whether any line bills goods the named Goods Receipt already contains, "
      + "so this invoice was NOT saved — the same goods could otherwise be paid for twice. "
      + "Please try again.",
    );
  });

  /* A sentence that was already sayable keeps its bracket — stripping is a
     rescue, not a rewrite. */
  test("a sayable sentence keeps its own brackets", () => {
    const msg = "Enter the price shown on the supplier document (the one they emailed).";
    expect(humanApiError(409, body({ error: "x_failed", message: msg }))).toBe(msg);
  });

  /* A MID-sentence aside is not a tail. `unlinkedInvoiceResponse` names the
     menu path this way — removing it would delete the remedy. */
  test("a mid-sentence aside is never touched", () => {
    const msg = "Raise the invoice from that receipt (Goods Receipt -> Transfer to "
      + "Purchase Invoice) so each line is linked.";
    expect(humanApiError(409, body({ error: "x_failed", message: msg }))).toBe(msg);
  });

  /* Deletion only: a remainder that is still internals is still refused. */
  test("stripping cannot rescue a sentence that is internals all the way down", () => {
    expect(humanApiError(500, body({
      error: "insert_failed",
      message: 'null value in column "material_kind" (23502).',
    }))).toBe(GENERIC_500);
  });
});
