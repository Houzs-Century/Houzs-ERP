// A staged Sales Order photo that did not upload must say WHY, and must not
// send the operator back to re-attach against a refusal that will refuse again.
//
// WHY THIS FILE EXISTS. #3303 fixed exactly this defect for line writes and
// named the instance it left behind, in its own ledger entry:
//
//   "Not fixed here, same shape: uploadStagedPhotos in the same file
//    (`catch { failed += 1; }`, then 'N line photo(s) failed to upload')
//    discards the reason identically for the photo path."
//
// `MobileNewSO.uploadStagedPhotos` caught every upload with a bare
// `catch { failed += 1; }` and told the operator a number: "3 line photo(s)
// failed to upload. Add them again from the SO detail screen." Behind that
// number could be an AutoCount lock, a permission refusal, a file the server
// would not take, an expired lease, or one dropped connection out of twelve —
// and "add them again" is right for exactly one of those.
//
// These tests assert the CONTRACT the operator experiences, using errors shaped
// the way authedFetch actually throws them (`err.message` humanised,
// `err.status` the raw code — vendor/scm/lib/authed-fetch.ts). They fail on the
// pre-fix tree, where vendor/scm/lib/photo-upload-failures.ts does not exist and
// the reason never left uploadStagedPhotos.
import { describe, expect, it } from "vitest";
import {
  isRefusal,
  namedPhotoFailures,
  photoLabel,
  photoUploadFailure,
  photoUploadFailureMessage,
  unmatchedLinePhotos,
} from "../vendor/scm/lib/photo-upload-failures";
import { sharedFailureCause } from "../vendor/scm/lib/line-write-failures";

/** An authedFetch rejection: the humanised sentence plus the raw status. */
const apiError = (message: string, status: number): Error => {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
};

/* The sentence the migrated-SO lock actually sends, verbatim from
   backend/src/scm/lib/migrated-so-lock.ts DEFAULT_LOCKED_MESSAGE. */
const LOCKED =
  "This order came from AutoCount and is view-only for now: its payments are still being "
  + "reconciled, so an edit could be overwritten. New orders save normally. "
  + "Ask IT if it must change today.";

const TOO_BIG = "That file is too large.";

describe("a refused photo upload reaches the operator with its reason", () => {
  it("carries the server's sentence instead of the count", () => {
    const f = photoUploadFailure(photoLabel("SOFA-5535", "IMG_2043.jpg"), apiError(LOCKED, 409));
    expect(f.message).toBe(LOCKED);
    expect(f.status).toBe(409);
    expect(photoUploadFailureMessage([f])).toContain(LOCKED);
  });

  it("does NOT tell the operator to re-attach — that cannot clear a refusal", () => {
    const msg = photoUploadFailureMessage([
      photoUploadFailure(photoLabel("SOFA-5535", "IMG_2043.jpg"), apiError(LOCKED, 409)),
    ]);
    expect(msg).not.toMatch(/add them again/i);
    expect(msg).toContain("Adding them again will not help");
  });

  it("treats a permission refusal the same way as the lock", () => {
    const msg = photoUploadFailureMessage([
      photoUploadFailure(photoLabel("BF-2", "slip.png"), apiError("You don't have permission to do that.", 403)),
    ]);
    expect(msg).toContain("You don't have permission to do that.");
    expect(msg).not.toMatch(/add them again/i);
  });

  it("agrees with the line-write module about what a refusal IS", () => {
    // Same statuses, same answer — the two surfaces cannot drift apart, because
    // this is literally the line-write module's own function.
    expect(isRefusal([photoUploadFailure("x", apiError(LOCKED, 409))])).toBe(true);
    expect(isRefusal([photoUploadFailure("x", apiError(TOO_BIG, 413))])).toBe(false);
  });
});

describe("the photo is NAMED, so the operator knows which one to re-attach", () => {
  it("names the line and the file together", () => {
    const msg = photoUploadFailureMessage([
      photoUploadFailure(photoLabel("SOFA-5535", "IMG_2043.jpg"), apiError(TOO_BIG, 413)),
    ]);
    expect(msg).toContain("SOFA-5535");
    expect(msg).toContain("IMG_2043.jpg");
  });

  it("names only ONE of a line's several photos when only one failed", () => {
    const msg = photoUploadFailureMessage([
      photoUploadFailure(photoLabel("SOFA-5535", "IMG_2044.jpg"), apiError(TOO_BIG, 413)),
    ]);
    expect(msg).toContain("IMG_2044.jpg");
    expect(msg).not.toContain("IMG_2043.jpg");
  });

  it("drops whichever half the code does not have, rather than printing an empty one", () => {
    expect(photoLabel("SOFA-5535", "")).toBe("SOFA-5535");
    expect(photoLabel("", "IMG_2043.jpg")).toBe("IMG_2043.jpg");
    expect(photoLabel(null, undefined)).toBe("A line photo");
    expect(photoLabel("  ", "  ")).toBe("A line photo");
  });
});

describe("one shared cause is said once", () => {
  const threeLocked = ["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"]
    .map((file) => photoUploadFailure(photoLabel("SOFA-5535", file), apiError(LOCKED, 409)));

  it("says the cause once and keeps the count", () => {
    const msg = photoUploadFailureMessage(threeLocked);
    expect(msg.split("AutoCount").length - 1).toBe(1); // the reason appears ONCE
    expect(msg).toContain("3 photos could not be uploaded");
    expect(msg).toContain(LOCKED);
  });

  it("falls back to naming every photo when the causes differ", () => {
    const msg = photoUploadFailureMessage([
      photoUploadFailure(photoLabel("SOFA-5535", "IMG_1.jpg"), apiError(LOCKED, 409)),
      photoUploadFailure(photoLabel("BF-2", "IMG_2.jpg"), apiError(TOO_BIG, 413)),
    ]);
    expect(msg).toContain("SOFA-5535 (IMG_1.jpg): ");
    expect(msg).toContain("BF-2 (IMG_2.jpg): ");
  });

  it("never collapses a single failure — that would drop the photo's name", () => {
    const one = photoUploadFailure(photoLabel("SOFA-5535", "IMG_1.jpg"), apiError(LOCKED, 409));
    expect(sharedFailureCause([one])).toBeNull();
    expect(namedPhotoFailures([one]))
      .toBe(`Could not upload SOFA-5535 (IMG_1.jpg): ${LOCKED}`);
  });
});

describe("a hiccup still says re-attach — the advice is earned, not removed", () => {
  it("a network failure carries no status and stays retryable", () => {
    const f = photoUploadFailure(photoLabel("SOFA-5535", "IMG_1.jpg"), new TypeError("Failed to fetch"));
    expect(f.status).toBeUndefined();
    expect(isRefusal([f])).toBe(false);
    expect(photoUploadFailureMessage([f])).toContain("Add them again from the SO detail screen");
  });

  it("a rejected file is a real reason AND still retryable — the operator can send a smaller one", () => {
    const msg = photoUploadFailureMessage([
      photoUploadFailure(photoLabel("SOFA-5535", "IMG_1.jpg"), apiError(TOO_BIG, 413)),
    ]);
    expect(msg).toContain(TOO_BIG);
    expect(msg).toContain("Add them again");
  });

  it("a 5xx stays retryable", () => {
    expect(photoUploadFailureMessage([
      photoUploadFailure("IMG_1.jpg", apiError("The system hit a problem. Please try again.", 503)),
    ])).toContain("Add them again");
  });

  it("MIXED causes keep the retry advice — some of those photos really can go up", () => {
    const failures = [
      photoUploadFailure(photoLabel("SOFA-5535", "IMG_1.jpg"), apiError(LOCKED, 409)),
      photoUploadFailure(photoLabel("BF-2", "IMG_2.jpg"), new TypeError("Failed to fetch")),
    ];
    expect(isRefusal(failures)).toBe(false);
    expect(photoUploadFailureMessage(failures)).toContain("Add them again");
  });

  it("a rejection that is not an Error at all still produces a sentence", () => {
    const f = photoUploadFailure(photoLabel("SOFA-5535", "IMG_1.jpg"), "boom");
    expect(f.message).toBe("Something went wrong.");
    expect(photoUploadFailureMessage([f])).toContain("Add them again");
  });
});

describe("a photo that never reached the network says so", () => {
  it("gives one failure per staged file, so the count still matches what to re-attach", () => {
    const failures = unmatchedLinePhotos("SOFA-5535", [{ name: "IMG_1.jpg" }, { name: "IMG_2.jpg" }]);
    expect(failures).toHaveLength(2);
    expect(failures[0]!.label).toBe("SOFA-5535 (IMG_1.jpg)");
    expect(failures[1]!.label).toBe("SOFA-5535 (IMG_2.jpg)");
  });

  it("does not blame the server, and stays retryable — the detail screen IS the fix", () => {
    const failures = unmatchedLinePhotos("SOFA-5535", [{ name: "IMG_1.jpg" }]);
    expect(failures[0]!.status).toBeUndefined();
    expect(isRefusal(failures)).toBe(false);
    const msg = photoUploadFailureMessage(failures);
    expect(msg).toContain("could not match this line to the saved order");
    expect(msg).toContain("Add them again from the SO detail screen");
  });

  it("collapses to one sentence when a whole line's photos were unmatched", () => {
    const msg = photoUploadFailureMessage(
      unmatchedLinePhotos("SOFA-5535", [{ name: "a.jpg" }, { name: "b.jpg" }, { name: "c.jpg" }]),
    );
    expect(msg).toContain("3 photos could not be uploaded");
    expect(msg.split("could not match").length - 1).toBe(1);
  });

  it("survives a File with no usable name", () => {
    expect(unmatchedLinePhotos("SOFA-5535", [{}])[0]!.label).toBe("SOFA-5535");
    expect(unmatchedLinePhotos(null, [{}])[0]!.label).toBe("A line photo");
  });
});

describe("nothing failed, nothing is said", () => {
  it("an empty list produces no message and is not a refusal", () => {
    expect(photoUploadFailureMessage([])).toBe("");
    expect(namedPhotoFailures([])).toBe("");
    expect(isRefusal([])).toBe(false);
    expect(unmatchedLinePhotos("SOFA-5535", [])).toEqual([]);
  });
});
