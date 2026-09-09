// ----------------------------------------------------------------------------
// photo-upload-failures — what a Sales Order line PHOTO says when it does NOT
// upload, for BOTH surfaces.
//
// WHY THIS EXISTS. This is the second half of the defect fixed in #3303, and it
// was named in that PR's ledger entry as the instance left behind:
//
//   "Not fixed here, same shape: uploadStagedPhotos in the same file
//    (`catch { failed += 1; }`, then 'N line photo(s) failed to upload')
//    discards the reason identically for the photo path."
//
// The operator saved a Sales Order with photos attached to its lines and was
// told "3 line photo(s) failed to upload. Add them again from the SO detail
// screen." A count is not a reason. Behind it could be an AutoCount lock, a
// permission refusal, a file the server rejected as too large or the wrong
// type, an expired edit lease, or a dropped connection on the last one of
// twelve — and the instruction attached to that count ("add them again") is
// right for exactly one of those. Told to re-attach against a refusal, the
// operator re-attaches, watches it fail, and re-attaches again; that is the
// afternoon #3303 was written about, on a different button.
//
// CLAUDE.md's named bug class, in its harder-to-see form: the failure DID reach
// somebody, and arrived stripped of the only part that was actionable.
//
// THE RULES ARE line-write-failures.ts's RULES — that is the point of this
// file being a sibling rather than a second opinion. Capture (lineWriteFailure),
// shared-cause collapse (sharedFailureCause) and the retry decision (isRefusal)
// are IMPORTED, not re-implemented, so a photo refusal and a line refusal can
// never disagree about what counts as a refusal. What is local here is only
// what genuinely differs:
//
//   • THE NOUN. "3 lines could not be saved" is wrong for a photo, and
//     "your edits are still here" is FALSE for one: staged Files do not
//     survive the screen, which is exactly why the retry advice has to name
//     where to go instead (the SO detail screen).
//   • THE LABEL. A line write is identified by its item code. A photo needs
//     the code AND the file name, because a line can carry several photos and
//     only some of them failed — see photoLabel.
//   • ONE FAILURE THAT IS NOT AN EXCEPTION. A staged photo whose line cannot
//     be matched back to a saved item never reaches the network at all. It was
//     counted as a failure before this change and reported as one; it now
//     carries a sentence saying so, because "we could not find the line" is a
//     different instruction from "the server said no".
//
// PURE ON PURPOSE — no React, no fetch — so both surfaces share it and it is
// testable without mounting a 3,700-line screen.
// ----------------------------------------------------------------------------
import {
  isRefusal,
  lineWriteFailure,
  sharedFailureCause,
  type LineWriteFailure,
} from './line-write-failures';

/**
 * One staged photo that did not land. Structurally a `LineWriteFailure` and
 * deliberately the SAME type rather than a parallel one: the moment the two
 * shapes diverge, the shared capture and retry logic stops applying to both.
 * `status` is absent when the rejection never carried one — a network failure,
 * or one of ours raised before any request went out.
 */
export type PhotoUploadFailure = LineWriteFailure;

/**
 * Capture a rejected photo upload with everything the operator can act on.
 *
 * Straight through to `lineWriteFailure`: `authedFetch` has already humanised
 * the API error to one plain sentence and stashed the raw HTTP status on the
 * Error, and there is no second error vocabulary here either.
 */
export const photoUploadFailure = (label: string, e: unknown): PhotoUploadFailure =>
  lineWriteFailure(label, e);

/** Shown when the code has no usable name for the photo at all — an unnamed
 *  File on a line that has neither a product code nor a description yet. */
const UNLABELLED = 'A line photo';

/**
 * What the operator will look for on screen: the line, then the file.
 *
 * BOTH halves earn their place. The line code says which row to open; the file
 * name says which of that row's photos to re-attach, and a line routinely
 * carries several where only one failed. Either half may be missing — a staged
 * line has no code until a product is picked, and a File from a camera capture
 * can arrive with an empty name — so each is dropped independently rather than
 * printing an empty bracket or a bare separator.
 */
export function photoLabel(
  lineLabel: string | null | undefined,
  fileName: string | null | undefined,
): string {
  const line = (lineLabel ?? '').trim();
  const file = (fileName ?? '').trim();
  if (line && file) return `${line} (${file})`;
  return line || file || UNLABELLED;
}

/** Why a staged photo never reached the network: its line could not be paired
 *  back to a saved item, so there is no item to hang the photo on. Says what
 *  happened without blaming the server, which did not refuse anything. */
const UNMATCHED_LINE = 'We could not match this line to the saved order, so its photos were not sent.';

/**
 * The failures for a line whose saved item could not be resolved — one per
 * staged file, so the count the operator is given still matches the number of
 * photos they have to re-attach.
 *
 * NO STATUS, on purpose. Nothing refused this: the order saved, the line is on
 * it, and attaching the photos from the SO detail screen is exactly the fix.
 * A missing status is what `isRefusal` reads as retryable, so the honest
 * advice falls out of the shared rule instead of being special-cased here.
 */
export function unmatchedLinePhotos(
  lineLabel: string | null | undefined,
  files: readonly { name?: string }[],
): PhotoUploadFailure[] {
  return files.map((f) => ({
    label: photoLabel(lineLabel, f.name),
    message: UNMATCHED_LINE,
  }));
}

/**
 * Name what failed: the shared cause once, or every photo's own reason.
 *
 * The count leads whenever there is more than one, because "how many photos am
 * I re-attaching" is the first thing the operator needs, and a list of reasons
 * is the last thing that makes it obvious. Twelve photos refused by one lock is
 * ONE fact — repeating it twelve times buries the one sentence that mattered.
 */
export function namedPhotoFailures(failures: readonly PhotoUploadFailure[]): string {
  if (failures.length === 0) return '';
  if (failures.length === 1) {
    const only = failures[0]!;
    return `Could not upload ${only.label}: ${only.message}`;
  }
  const shared = sharedFailureCause(failures);
  const detail = shared ?? failures.map((f) => `${f.label}: ${f.message}`).join(' · ');
  return `${failures.length} photos could not be uploaded — ${detail}`;
}

/** What a retryable photo failure promises. It does NOT say "your edits are
 *  still here" the way a line write does, because for a photo that is a lie:
 *  the staged File is gone with the screen, so the advice has to say where to
 *  go and do it again. */
const RETRY_TAIL = 'Add them again from the SO detail screen.';

/** What a refusal says instead — and it does not send the operator off to
 *  re-attach photos that will be refused exactly the same way on arrival. */
const REFUSED_TAIL = 'Adding them again will not help until this is resolved.';

/**
 * The sentence shown when staged Sales Order photos did not upload.
 *
 * One string, because both surfaces report this through a notify() body with
 * no per-photo banner to hang a reason on.
 */
export function photoUploadFailureMessage(failures: readonly PhotoUploadFailure[]): string {
  if (failures.length === 0) return '';
  return `${namedPhotoFailures(failures)}. ${isRefusal(failures) ? REFUSED_TAIL : RETRY_TAIL}`;
}

/** Re-exported so a caller reporting photo failures does not have to import
 *  the line-write module as well to ask the one question that decides its
 *  wording. Same function, same answer, by construction. */
export { isRefusal };
