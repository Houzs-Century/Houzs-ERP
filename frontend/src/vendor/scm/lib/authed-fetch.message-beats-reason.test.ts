import { describe, expect, test } from "vitest";
import { humanApiError } from "./authed-fetch";

const GENERIC_500 =
  "The system hit a problem. Please try again — if it keeps happening, let IT know.";

const body = (o: unknown) => JSON.stringify(o);

const unlinkedCheckFailed = (reason: string) => ({
  error: "unlinked_check_failed",
  message:
    "Could not check whether any line bills goods the named Goods Receipt already "
    + "contains, so this invoice was NOT saved — the same goods could otherwise be paid for "
    + `twice. Please try again (${reason}).`,
  reason,
});

describe("a refusal that carries both halves shows the operator's half", () => {
  test("a raw driver reason does not bury the sentence beside it", () => {
    const out = humanApiError(500, body(unlinkedCheckFailed("column grn_items.foo does not exist")));
    expect(out).not.toBe(GENERIC_500);
    expect(out).toContain("was NOT saved");
    expect(out).toContain("paid for twice");
  });

  test("a plain reason still loses to the message", () => {
    const out = humanApiError(500, body(unlinkedCheckFailed("timeout")));
    expect(out).toContain("was NOT saved");
  });

  test("reason still speaks when there is no message", () => {
    expect(humanApiError(500, body({ error: "insert_failed", reason: "Supplier is closed for the day" })))
      .toBe("Supplier is closed for the day");
  });

  test("an internals-shaped message is dropped, and reason is tried next", () => {
    expect(humanApiError(500, body({
      error: "insert_failed",
      message: 'null value in column "material_kind" violates not-null constraint',
      reason: "The invoice line is missing its item type — reopen the receipt and try again.",
    }))).toBe("The invoice line is missing its item type — reopen the receipt and try again.");
  });

  test("both halves unusable falls through to the status line", () => {
    expect(humanApiError(500, body({
      error: "insert_failed",
      message: "relation scm.purchase_invoices does not exist",
      reason: "relation scm.purchase_invoices does not exist",
    }))).toBe(GENERIC_500);
  });
});

describe("a bracketed diagnostic tail costs the bracket, not the sentence", () => {
  test("the tail goes and the sentence survives, punctuation intact", () => {
    const out = humanApiError(500, body(unlinkedCheckFailed("column grn_items.foo does not exist")));
    expect(out).toBe(
      "Could not check whether any line bills goods the named Goods Receipt already contains, "
      + "so this invoice was NOT saved — the same goods could otherwise be paid for twice. "
      + "Please try again.",
    );
  });

  test("a sayable sentence keeps its own brackets", () => {
    const msg = "Enter the price shown on the supplier document (the one they emailed).";
    expect(humanApiError(409, body({ error: "x_failed", message: msg }))).toBe(msg);
  });

  test("a mid-sentence aside is never touched", () => {
    const msg = "Raise the invoice from that receipt (Goods Receipt -> Transfer to "
      + "Purchase Invoice) so each line is linked.";
    expect(humanApiError(409, body({ error: "x_failed", message: msg }))).toBe(msg);
  });

  test("stripping cannot rescue a sentence that is internals all the way down", () => {
    expect(humanApiError(500, body({
      error: "insert_failed",
      message: 'null value in column "material_kind" (23502).',
    }))).toBe(GENERIC_500);
  });
});
