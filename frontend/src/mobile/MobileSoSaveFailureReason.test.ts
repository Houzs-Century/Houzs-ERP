// A Sales Order line write that the server REFUSED must say what it refused,
// and must not tell the operator to do the thing that just failed.
//
// WHY THIS FILE EXISTS. The owner, on his phone, changed the fabric colour on a
// Sales Order and pressed Save. He was told:
//
//   "2 line change(s) did not save. Your edits are still here; try Save again."
//
// 「我是edit 要process 但是一直不能」 — he pressed it again, and again, and it
// could never have worked. The order was imported from AutoCount, the migrated-SO
// lock (backend/src/scm/lib/migrated-so-readonly.ts) was refusing every line
// write with a 409 that carried its OWN sentence, and MobileNewSO.applyLineDiff
// caught each call with a bare `catch { failed += 1; }`. The explanation arrived,
// was correct, and was thrown away one line into the client; the caller then
// built a message out of the count alone, so a lock, a permission refusal, a
// validation error and a dropped connection all rendered as the same sentence —
// and that sentence's advice is right for exactly one of them.
//
// These tests assert the CONTRACT the operator experiences, using errors shaped
// the way authedFetch actually throws them (`err.message` humanised,
// `err.status` the raw code — vendor/scm/lib/authed-fetch.ts:421-423). They fail
// on the pre-fix tree, where the reason never left applyLineDiff.
import { describe, expect, it } from "vitest";
import {
  isRefusal,
  lineWriteFailure,
  lineWriteSaveMessage,
  namedFailures,
  sharedFailureCause,
} from "../vendor/scm/lib/line-write-failures";

/** An authedFetch rejection: the humanised sentence plus the raw status. */
const apiError = (message: string, status: number): Error => {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
};

/* The sentence the migrated-SO lock actually sends, verbatim from
   backend/src/scm/lib/migrated-so-lock.ts DEFAULT_LOCKED_MESSAGE. It reaches
   the client through humanApiError, which lets a `so_migrated_readonly` body's
   own words win over the curated line (authed-fetch.ts SERVER_SENTENCE_WINS). */
const LOCKED =
  "This order came from AutoCount and is view-only for now: its payments are still being "
  + "reconciled, so an edit could be overwritten. New orders save normally. "
  + "Ask IT if it must change today.";

describe("a refused line write reaches the operator with its reason", () => {
  it("carries the server's sentence instead of the count", () => {
    const f = lineWriteFailure("SOFA-5535", apiError(LOCKED, 409));
    expect(f.message).toBe(LOCKED);
    expect(f.status).toBe(409);
    expect(lineWriteSaveMessage([f])).toContain(LOCKED);
  });

  it("names the line, so the operator knows which row to look at", () => {
    expect(lineWriteSaveMessage([lineWriteFailure("SOFA-5535", apiError(LOCKED, 409))]))
      .toContain("SOFA-5535");
  });

  it("does NOT tell the operator to try Save again — retrying cannot clear a refusal", () => {
    const msg = lineWriteSaveMessage([lineWriteFailure("SOFA-5535", apiError(LOCKED, 409))]);
    expect(msg).not.toMatch(/try save again/i);
    expect(msg).toContain("Saving again will not help");
  });

  it("treats a permission refusal the same way as the lock", () => {
    const msg = lineWriteSaveMessage([
      lineWriteFailure("BF-2", apiError("You don't have permission to do that.", 403)),
    ]);
    expect(msg).toContain("You don't have permission to do that.");
    expect(msg).not.toMatch(/try save again/i);
  });
});

describe("one shared cause is said once", () => {
  const threeLocked = ["SOFA-5535", "BF-2", "MT-3"]
    .map((label) => lineWriteFailure(label, apiError(LOCKED, 409)));

  it("says the cause once and keeps the count", () => {
    const msg = lineWriteSaveMessage(threeLocked);
    expect(msg.split("AutoCount").length - 1).toBe(1); // the reason appears ONCE
    expect(msg).toContain("3 lines could not be saved");
    expect(msg).toContain(LOCKED);
  });

  it("falls back to naming every line when the causes differ", () => {
    const msg = lineWriteSaveMessage([
      lineWriteFailure("SOFA-5535", apiError(LOCKED, 409)),
      lineWriteFailure("BF-2", apiError("That clashes with something already in the system.", 409)),
    ]);
    expect(msg).toContain("SOFA-5535: ");
    expect(msg).toContain("BF-2: ");
    expect(sharedFailureCause([
      lineWriteFailure("a", apiError("one", 409)),
      lineWriteFailure("b", apiError("two", 409)),
    ])).toBeNull();
  });

  it("never collapses a single failure — that would drop the line's name", () => {
    expect(sharedFailureCause([lineWriteFailure("SOFA-5535", apiError(LOCKED, 409))])).toBeNull();
    expect(namedFailures([lineWriteFailure("SOFA-5535", apiError(LOCKED, 409))]))
      .toBe(`Could not save SOFA-5535: ${LOCKED}`);
  });
});

describe("a hiccup still says try again — the advice is earned, not removed", () => {
  it("a network failure carries no status and stays retryable", () => {
    const f = lineWriteFailure("SOFA-5535", new TypeError("Failed to fetch"));
    expect(f.status).toBeUndefined();
    expect(isRefusal([f])).toBe(false);
    expect(lineWriteSaveMessage([f])).toContain("try Save again");
  });

  it("a 5xx stays retryable", () => {
    const msg = lineWriteSaveMessage([
      lineWriteFailure("SOFA-5535", apiError("The system hit a problem. Please try again.", 503)),
    ]);
    expect(msg).toContain("try Save again");
  });

  it("MIXED causes keep the retry advice — some of that work really can go out", () => {
    const failures = [
      lineWriteFailure("SOFA-5535", apiError(LOCKED, 409)),
      lineWriteFailure("BF-2", new TypeError("Failed to fetch")),
    ];
    expect(isRefusal(failures)).toBe(false);
    expect(lineWriteSaveMessage(failures)).toContain("try Save again");
  });

  it("a rejection that is not an Error at all still produces a sentence", () => {
    const f = lineWriteFailure("SOFA-5535", "boom");
    expect(f.message).toBe("Something went wrong.");
    expect(lineWriteSaveMessage([f])).toContain("try Save again");
  });
});

describe("nothing failed, nothing is said", () => {
  it("an empty list produces no message and is not a refusal", () => {
    expect(lineWriteSaveMessage([])).toBe("");
    expect(namedFailures([])).toBe("");
    expect(isRefusal([])).toBe(false);
  });
});
